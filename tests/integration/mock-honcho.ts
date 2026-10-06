import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Named Honcho v3 routes; faults and assertions key off these. */
export type RouteName =
  | "workspace"
  | "peer"
  | "session"
  | "session.peers"
  | "card"
  | "summaries"
  | "chat"
  | "context"
  | "messages"
  | "conclusions.list"
  | "conclusions.query"
  | "session.search"
  | "peer.search"
  | "workspace.search"
  | "peer.sessions"
  | "queue"
  | "oauth.discovery"
  | "unknown";

export interface RecordedRequest {
  route: RouteName;
  method: string;
  path: string;
  /** Path params, e.g. `{ workspace, peer }` or `{ workspace, session }`. */
  params: Record<string, string>;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  body: unknown;
  status: number;
}

export interface Fault {
  /** Respond with this status and `{ detail }`; omit to only add latency. */
  status?: number;
  detail?: string;
  delayMs?: number;
  /** How many matching requests this applies to; unlimited by default. */
  times?: number;
}

export interface SummaryFixture {
  content: string;
  createdAt?: string;
}

export interface ConclusionFixture {
  id: string;
  content: string;
  level?: "explicit" | "deductive" | "inductive" | "contradiction";
  sessionId?: string;
  createdAt?: string;
}

export interface MessageFixture {
  id: string;
  content: string;
  peerId: string;
  sessionId: string;
  createdAt?: string;
}

/** Server-side data the routes answer from; tests mutate it between scenarios. */
export interface MockData {
  peerCard: string[] | null;
  shortSummary: SummaryFixture | null;
  longSummary: SummaryFixture | null;
  /** Dialectic answer; a function sees the parsed request body. */
  chatAnswer: string | null | ((body: Record<string, unknown>) => string | null);
  /** Markdown returned as `representation` by the peer context route. */
  representation: string | null;
  conclusions: ConclusionFixture[];
  /** `total` reported by conclusions/list; defaults to `conclusions.length`. */
  conclusionTotal?: number;
  searchMessages: MessageFixture[];
}

export const NOW = "2026-10-01T12:00:00Z";

export const defaultData = (): MockData => ({
  peerCard: null,
  shortSummary: null,
  longSummary: null,
  chatAnswer: null,
  representation: null,
  conclusions: [],
  searchMessages: [],
});

interface Route {
  name: RouteName;
  method: string;
  pattern: RegExp;
  keys: string[];
}

const SEG = "([^/]+)";
const route = (name: RouteName, method: string, path: string): Route => {
  const keys: string[] = [];
  const source = path.replace(/:(\w+)/g, (_match, key: string) => {
    keys.push(key);
    return SEG;
  });
  return { name, method, pattern: new RegExp(`^${source}$`), keys };
};

const ROUTES: Route[] = [
  route("oauth.discovery", "GET", "/.well-known/oauth-authorization-server"),
  route("workspace", "POST", "/v3/workspaces"),
  route("peer", "POST", "/v3/workspaces/:workspace/peers"),
  route("session", "POST", "/v3/workspaces/:workspace/sessions"),
  route("session.peers", "POST", "/v3/workspaces/:workspace/sessions/:session/peers"),
  route("card", "GET", "/v3/workspaces/:workspace/peers/:peer/card"),
  route("summaries", "GET", "/v3/workspaces/:workspace/sessions/:session/summaries"),
  route("chat", "POST", "/v3/workspaces/:workspace/peers/:peer/chat"),
  route("context", "GET", "/v3/workspaces/:workspace/peers/:peer/context"),
  route("messages", "POST", "/v3/workspaces/:workspace/sessions/:session/messages"),
  route("conclusions.list", "POST", "/v3/workspaces/:workspace/conclusions/list"),
  route("conclusions.query", "POST", "/v3/workspaces/:workspace/conclusions/query"),
  route("session.search", "POST", "/v3/workspaces/:workspace/sessions/:session/search"),
  route("peer.search", "POST", "/v3/workspaces/:workspace/peers/:peer/search"),
  route("workspace.search", "POST", "/v3/workspaces/:workspace/search"),
  route("peer.sessions", "POST", "/v3/workspaces/:workspace/peers/:peer/sessions"),
  route("queue", "GET", "/v3/workspaces/:workspace/queue/status"),
];

const match = (
  method: string,
  path: string,
): { name: RouteName; params: Record<string, string> } => {
  for (const r of ROUTES) {
    if (r.method !== method) {
      continue;
    }
    const m = r.pattern.exec(path);
    if (!m) {
      continue;
    }
    const params: Record<string, string> = {};
    r.keys.forEach((key, i) => {
      params[key] = decodeURIComponent(m[i + 1] ?? "");
    });
    return { name: r.name, params };
  }
  return { name: "unknown", params: {} };
};

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        return resolve(undefined);
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const summaryJson = (fixture: SummaryFixture | null, type: "short" | "long") =>
  fixture
    ? {
        content: fixture.content,
        message_id: `m-${type}`,
        summary_type: type,
        created_at: fixture.createdAt ?? NOW,
        token_count: 10,
      }
    : null;

const messageJson = (m: MessageFixture, workspace: string) => ({
  id: m.id,
  content: m.content,
  peer_id: m.peerId,
  session_id: m.sessionId,
  workspace_id: workspace,
  metadata: {},
  created_at: m.createdAt ?? NOW,
  token_count: 5,
});

/**
 * A node:http stand-in for the Honcho v3 routes the extension calls, with a
 * request log and per-route fault injection.
 */
export class MockHoncho {
  readonly requests: RecordedRequest[] = [];
  data: MockData = defaultData();
  private faults: { route: RouteName; fault: Fault; used: number }[] = [];
  private server: Server | undefined;
  private messageSeq = 0;
  baseUrl = "";

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    const { server } = this;
    this.server = undefined;
    if (!server) {
      return;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Clears the log, faults and data between scenarios. */
  reset(): void {
    this.requests.length = 0;
    this.faults = [];
    this.data = defaultData();
  }

  /** Injects a failure or latency into one route. Later faults for the same route queue behind earlier ones. */
  fail(routeName: RouteName, fault: Fault): void {
    this.faults.push({ route: routeName, fault, used: 0 });
  }

  calls(routeName: RouteName): RecordedRequest[] {
    return this.requests.filter((r) => r.route === routeName);
  }

  routes(): RouteName[] {
    return this.requests.map((r) => r.route);
  }

  /** Resolves once `predicate` holds over the log, or rejects after `timeoutMs`. */
  async waitFor(predicate: (log: RecordedRequest[]) => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.requests)) {
      if (Date.now() > deadline) {
        throw new Error(
          `mock honcho: condition not met within ${timeoutMs}ms; saw ${this.routes().join(", ")}`,
        );
      }
      await sleep(10);
    }
  }

  private takeFault(routeName: RouteName): Fault | undefined {
    const entry = this.faults.find(
      (f) => f.route === routeName && (f.fault.times === undefined || f.used < f.fault.times),
    );
    if (!entry) {
      return undefined;
    }
    entry.used += 1;
    return entry.fault;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://mock");
    const method = req.method ?? "GET";
    const { name, params } = match(method, url.pathname);
    const body = await readBody(req);
    const entry: RecordedRequest = {
      route: name,
      method,
      path: url.pathname,
      params,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: req.headers,
      body,
      status: 0,
    };
    this.requests.push(entry);

    const send = (status: number, payload: unknown) => {
      entry.status = status;
      if (res.destroyed) {
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    const fault = this.takeFault(name);
    if (fault?.delayMs) {
      await sleep(fault.delayMs);
    }
    if (fault?.status) {
      send(fault.status, { detail: fault.detail ?? `mock ${fault.status}` });
      return;
    }

    const status = name === "session" || name === "messages" ? 201 : 200;
    const result = this.respond(name, params, entry.query, asRecord(body));
    if (result === undefined) {
      send(404, { detail: `mock honcho: no route for ${method} ${url.pathname}` });
    } else {
      send(status, result);
    }
  }

  private respond(
    name: RouteName,
    params: Record<string, string>,
    query: Record<string, string>,
    body: Record<string, unknown>,
  ): unknown {
    const workspace = params.workspace ?? (typeof body.id === "string" ? body.id : "");
    switch (name) {
      case "workspace":
        return { id: body.id, metadata: {}, configuration: {}, created_at: NOW };
      case "peer":
        return {
          id: body.id,
          workspace_id: workspace,
          metadata: body.metadata ?? {},
          configuration: body.configuration ?? {},
          created_at: NOW,
        };
      case "session":
        return {
          id: body.id,
          workspace_id: workspace,
          is_active: true,
          metadata: body.metadata ?? {},
          configuration: body.configuration ?? {},
          created_at: NOW,
        };
      case "session.peers":
        return {};
      case "card":
        return { peer_card: this.data.peerCard };
      case "summaries":
        return {
          id: params.session,
          short_summary: summaryJson(this.data.shortSummary, "short"),
          long_summary: summaryJson(this.data.longSummary, "long"),
        };
      case "chat": {
        const answer =
          typeof this.data.chatAnswer === "function"
            ? this.data.chatAnswer(body)
            : this.data.chatAnswer;
        return { content: answer };
      }
      case "context":
        return {
          peer_id: params.peer,
          target_id: query.target ?? params.peer,
          representation: this.data.representation,
          peer_card: this.data.peerCard,
        };
      case "messages": {
        const messages = Array.isArray(body.messages)
          ? (body.messages as Record<string, unknown>[])
          : [];
        return messages.map((m) => ({
          id: `msg-${++this.messageSeq}`,
          content: m.content,
          peer_id: m.peer_id,
          session_id: params.session,
          workspace_id: workspace,
          metadata: m.metadata ?? {},
          created_at: m.created_at ?? NOW,
          token_count: 5,
        }));
      }
      case "conclusions.list": {
        const size = Number(query.size ?? 50);
        const items = this.data.conclusions.slice(0, size).map((c) => this.conclusionJson(c, body));
        const total = this.data.conclusionTotal ?? this.data.conclusions.length;
        return {
          items,
          total,
          page: Number(query.page ?? 1),
          size,
          pages: Math.max(1, Math.ceil(total / size)),
        };
      }
      case "conclusions.query": {
        const topK = typeof body.top_k === "number" ? body.top_k : 10;
        return this.data.conclusions.slice(0, topK).map((c) => this.conclusionJson(c, body));
      }
      case "session.search":
      case "peer.search":
      case "workspace.search": {
        const limit = typeof body.limit === "number" ? body.limit : 10;
        return this.data.searchMessages.slice(0, limit).map((m) => messageJson(m, workspace));
      }
      case "peer.sessions":
        return { items: [], total: 0, page: 1, size: Number(query.size ?? 50), pages: 1 };
      case "queue":
        return {
          total_work_units: 0,
          completed_work_units: 0,
          in_progress_work_units: 0,
          pending_work_units: 0,
        };
      case "oauth.discovery":
      case "unknown":
        return undefined;
    }
  }

  private conclusionJson(c: ConclusionFixture, body: Record<string, unknown>) {
    const filters = asRecord(body.filters);
    return {
      id: c.id,
      content: c.content,
      observer_id: filters.observer_id ?? "user",
      observed_id: filters.observed_id ?? "user",
      session_id: c.sessionId ?? null,
      level: c.level ?? "explicit",
      source_ids: [],
      times_derived: 1,
      created_at: c.createdAt ?? NOW,
    };
  }
}
