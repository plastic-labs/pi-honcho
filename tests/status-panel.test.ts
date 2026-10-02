import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AuthenticationError, ConnectionError, PermissionDeniedError } from "@honcho-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../extensions/auth/credentials.js";
import type { Fetch } from "../extensions/auth/oauth.js";
import type { JsonObject } from "../extensions/config-file.js";
import { HonchoRuntime } from "../extensions/runtime.js";
import type { Connection, RuntimePhase } from "../extensions/runtime.js";
import { resolveSettings } from "../extensions/settings.js";
import { collectStatus } from "../extensions/ui/status-panel.js";

type Env = Record<string, string | undefined>;

interface Stubs {
  queue?: () => Promise<unknown>;
  conclusions?: () => Promise<{ total: number }>;
  sessions?: () => Promise<{ total: number }>;
  card?: () => Promise<string[] | null>;
}

const FAST = { timeoutMs: 100 };
const PI_KEY_FILE: JsonObject = {
  peerName: "aakash",
  hosts: { pi: { apiKey: "hch-test-key", workspace: "claude_code" } },
};

let dir: string;
const runtimes: HonchoRuntime[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-honcho-status-"));
});

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.dispose();
  }
  rmSync(dir, { recursive: true, force: true });
});

const noFetch: Fetch = () => Promise.reject(new Error("network is disabled in tests"));

const fakePi = (): ExtensionAPI => {
  let active: string[] = [];
  const pi = {
    getActiveTools: () => active,
    setActiveTools: (tools: string[]) => {
      active = tools;
    },
    appendEntry: () => undefined,
    exec: () => Promise.resolve({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  return pi as unknown as ExtensionAPI;
};

const never = <T>() => new Promise<T>(() => undefined);
const later = <T>(value: T, ms = 5) =>
  new Promise<T>((resolve) => {
    setTimeout(() => resolve(value), ms);
  });

/** A real runtime over a temp config file, with a stubbed connection in place of the SDK clients. */
const setup = (
  opts: {
    file?: JsonObject;
    env?: Env;
    phase?: RuntimePhase;
    stubs?: Stubs;
    connected?: boolean;
    lastError?: string;
  } = {},
) => {
  const file = opts.file ?? PI_KEY_FILE;
  const env = opts.env ?? {};
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(file));
  const runtime = new HonchoRuntime(fakePi());
  runtimes.push(runtime);
  Object.assign(runtime, { store: new CredentialStore({ path, env, fetchImpl: noFetch }) });
  runtime.file = file;
  runtime.settings = resolveSettings(file, env);
  runtime.credential = runtime.store.resolve(runtime.settings.baseUrl);
  runtime.ctx = {
    cwd: "/work/demo",
    sessionManager: { getSessionId: () => "abc123" },
  } as unknown as ExtensionContext;
  runtime.lastError = opts.lastError;

  const stubs = opts.stubs ?? {};
  const token = runtime.credential?.token;
  const http = {
    apiKey: token,
    get: vi.fn((_path: string) =>
      stubs.queue ? stubs.queue() : later({ pending_work_units: 0, in_progress_work_units: 0 }),
    ),
  };
  const userPeer = {
    getCard: vi.fn(() =>
      stubs.card ? stubs.card() : later(Array.from({ length: 14 }, (_, i) => `fact ${i}`)),
    ),
    conclusions: {
      list: vi.fn((_opts: { size: number }) =>
        stubs.conclusions ? stubs.conclusions() : later({ total: 1284 }),
      ),
    },
    sessions: vi.fn((_opts: { size: number }) =>
      stubs.sessions ? stubs.sessions() : later({ total: 37 }),
    ),
  };
  const connection = {
    clients: {
      fast: { http, workspaceId: runtime.settings.workspace },
      dialectic: { http: { apiKey: token } },
    },
    credential: runtime.credential,
    sessionName: "aakash-demo",
    userPeer,
  } as unknown as Connection;
  if (opts.connected ?? true) {
    runtime.connection = connection;
    runtime.sessionName = "aakash-demo";
  }
  runtime.phase = opts.phase ?? (runtime.connection ? "connected" : "signed-out");
  return { runtime, connection, http, userPeer };
};

describe("collectStatus when connected", () => {
  it("reads latency, memory counts and the queue", async () => {
    const { runtime, http, userPeer } = setup();
    const status = await collectStatus(runtime, FAST);
    expect(status).toMatchObject({
      state: "connected",
      endpoint: "api.honcho.dev",
      account: { name: "aakash", method: "api key", scope: "pi only" },
      workspace: { value: "claude_code", scope: "pi only" },
      peers: { user: "aakash", ai: "pi", scope: "pi only" },
      session: { name: "aakash-demo", strategy: "per-directory" },
      memory: { conclusions: 1284, peerCardFacts: 14, sessions: 37 },
      queue: { pending: 0, inProgress: 0 },
      injection: {
        sessionStart: ["summary", "peer card"],
        perTurn: "chat",
        reasoning: "medium",
        maxConclusions: 15,
      },
      tools: ["honcho_chat", "honcho_search"],
      warnings: [],
    });
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);
    expect(status.error).toBeUndefined();
    expect(status.account?.renewsInMin).toBeUndefined();
    expect(http.get).toHaveBeenCalledWith("/v3/workspaces/claude_code/queue/status");
    expect(userPeer.conclusions.list).toHaveBeenCalledWith({ size: 1 });
    expect(userPeer.sessions).toHaveBeenCalledWith({ size: 1 });
  });

  it("issues the four reads in parallel", async () => {
    let started = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated =
      <T>(value: T) =>
      () => {
        started += 1;
        if (started === 4) {
          release();
        }
        return gate.then(() => value);
      };
    const { runtime } = setup({
      stubs: {
        queue: gated({ pending_work_units: 12, in_progress_work_units: 3 }),
        conclusions: gated({ total: 5 }),
        sessions: gated({ total: 2 }),
        card: gated(["one"]),
      },
    });
    const status = await collectStatus(runtime, { timeoutMs: 500 });
    expect(status.queue).toEqual({ pending: 12, inProgress: 3 });
    expect(status.memory).toEqual({ conclusions: 5, peerCardFacts: 1, sessions: 2 });
  });

  it("counts a missing peer card as zero facts", async () => {
    const { runtime } = setup({ stubs: { card: () => later(null) } });
    expect((await collectStatus(runtime, FAST)).memory?.peerCardFacts).toBe(0);
  });

  it("keeps the footer conclusion count in step", async () => {
    const { runtime } = setup();
    await collectStatus(runtime, FAST);
    expect(runtime.conclusions).toBe(1284);
    expect(runtime.footer.current).toMatchObject({ kind: "connected", conclusions: 1284 });
  });

  it("degrades rows that a scoped key cannot read", async () => {
    const { runtime } = setup({
      stubs: {
        queue: () =>
          Promise.reject(new AuthenticationError("Route requires a workspace-level key")),
        conclusions: () => Promise.reject(new PermissionDeniedError("forbidden")),
        sessions: () => Promise.reject(new Error("boom")),
      },
    });
    const status = await collectStatus(runtime, FAST);
    expect(status.state).toBe("connected");
    expect(status.queue).toBeUndefined();
    expect(status.memory).toEqual({
      conclusions: undefined,
      peerCardFacts: 14,
      sessions: undefined,
    });
    // The peer card read stands in for latency when queue status is forbidden
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);
    expect(status.warnings).toEqual([]);
    expect(runtime.phase).toBe("connected");
  });

  it("gives up on slow reads after the timeout", async () => {
    const { runtime } = setup({ stubs: { queue: never, sessions: never } });
    const started = Date.now();
    const status = await collectStatus(runtime, { timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(status.state).toBe("connected");
    expect(status.queue).toBeUndefined();
    expect(status.memory).toEqual({ conclusions: 1284, peerCardFacts: 14, sessions: undefined });
  });

  it("keeps the state when only the peer card is slow", async () => {
    const { runtime } = setup({ stubs: { card: never } });
    const status = await collectStatus(runtime, { timeoutMs: 50 });
    expect(status.state).toBe("connected");
    expect(status.memory).toEqual({ conclusions: 1284, peerCardFacts: undefined, sessions: 37 });
    expect(status.queue).toEqual({ pending: 0, inProgress: 0 });
    expect(runtime.phase).toBe("connected");
  });

  it("warns when nothing could be read", async () => {
    const { runtime } = setup({
      stubs: { queue: never, conclusions: never, sessions: never, card: never },
    });
    const status = await collectStatus(runtime, { timeoutMs: 30 });
    expect(status.state).toBe("connected");
    expect(status.latencyMs).toBeUndefined();
    expect(status.warnings).toEqual(["could not read memory counts from api.honcho.dev"]);
  });

  it("reports unreachable when the peer card read cannot connect", async () => {
    const { runtime } = setup({
      stubs: { card: () => Promise.reject(new ConnectionError("connect ECONNREFUSED")) },
    });
    const status = await collectStatus(runtime, FAST);
    expect(status.state).toBe("unreachable");
    expect(status.error).toBe("api.honcho.dev is unreachable; Honcho memory is paused.");
    expect(status.memory).toBeUndefined();
    expect(status.queue).toBeUndefined();
    expect(status.latencyMs).toBeUndefined();
  });

  it("reports a rejected key", async () => {
    const { runtime } = setup({
      stubs: { card: () => Promise.reject(new AuthenticationError("Invalid API key")) },
    });
    const status = await collectStatus(runtime, FAST);
    expect(status.state).toBe("error");
    expect(status.error).toBe("api.honcho.dev rejected the key: Invalid API key");
  });
});

describe("collectStatus account and scopes", () => {
  const nowS = Math.floor(Date.now() / 1000);
  const uid = () => randomBytes(6).toString("hex");

  it("shows an OAuth grant with its renewal time", async () => {
    const accessExpiresAt = nowS + 3600;
    const file: JsonObject = {
      peerName: "aakash",
      oauth: {
        accessToken: `hch-at-${uid()}`,
        refreshToken: `hch-rt-${uid()}`,
        accessExpiresAt,
        clientId: "honcho-pi",
        scope: "write",
        host: "https://api.honcho.dev",
      },
    };
    const { runtime } = setup({ file });
    const status = await collectStatus(runtime, { ...FAST, now: (accessExpiresAt - 3600) * 1000 });
    expect(status.account).toEqual({
      name: "aakash",
      method: "oauth",
      scope: "shared",
      renewsInMin: 58,
    });
  });

  it("labels shared and env keys", async () => {
    const shared = await collectStatus(
      setup({ file: { peerName: "aakash", apiKey: "hch-shared" } }).runtime,
      FAST,
    );
    expect(shared.account).toEqual({ name: "aakash", method: "api key", scope: "shared" });
    const env = await collectStatus(
      setup({ file: PI_KEY_FILE, env: { HONCHO_API_KEY: "hch-env" } }).runtime,
      FAST,
    );
    expect(env.account).toEqual({ name: "aakash", method: "env key", scope: "env" });
  });

  it("tags where the workspace and peers come from", async () => {
    const root = await collectStatus(
      setup({ file: { peerName: "aakash", workspace: "shared_ws", apiKey: "k" } }).runtime,
      FAST,
    );
    expect(root.workspace).toEqual({ value: "shared_ws", scope: "shared" });
    expect(root.peers.scope).toBe("pi only");
    const defaults = await collectStatus(
      setup({ file: { apiKey: "k" }, env: { USER: "dev" } }).runtime,
      FAST,
    );
    expect(defaults.workspace).toEqual({ value: "pi", scope: "pi only" });
    expect(defaults.peers).toEqual({ user: "dev", ai: "pi", scope: "pi only" });
    const env = await collectStatus(
      setup({
        file: { apiKey: "k" },
        env: { HONCHO_WORKSPACE: "env_ws", HONCHO_PEER_NAME: "envy" },
      }).runtime,
      FAST,
    );
    expect(env.workspace).toEqual({ value: "env_ws", scope: "env" });
    expect(env.peers).toEqual({ user: "envy", ai: "pi", scope: "env" });
  });

  it("reflects injection, tools and settings warnings", async () => {
    const file: JsonObject = {
      peerName: "aakash",
      apiKey: "k",
      hosts: {
        pi: {
          workspace: "a b",
          injection: { sessionStart: ["summary"], perTurn: "context", maxConclusions: 20 },
          tools: { honcho_search: false },
        },
      },
    };
    const status = await collectStatus(setup({ file }).runtime, FAST);
    expect(status.injection).toEqual({
      sessionStart: ["summary"],
      perTurn: "context",
      reasoning: "medium",
      maxConclusions: 20,
    });
    expect(status.tools).toEqual(["honcho_chat"]);
    expect(status.warnings).toEqual(['workspace "a b" is not a valid Honcho id; using "a-b"']);
  });
});

describe("collectStatus when not connected", () => {
  it("explains a signed-out state without touching the network", async () => {
    const { runtime, http } = setup({
      file: { peerName: "aakash" },
      connected: false,
      phase: "signed-out",
    });
    const status = await collectStatus(runtime, FAST);
    expect(status).toMatchObject({
      state: "signed-out",
      endpoint: "api.honcho.dev",
      error: "Not signed in to Honcho. Run /honcho login.",
      workspace: { value: "pi", scope: "pi only" },
      session: { name: "aakash-demo", strategy: "per-directory" },
    });
    expect(status.account).toBeUndefined();
    expect(status.memory).toBeUndefined();
    expect(status.queue).toBeUndefined();
    expect(status.latencyMs).toBeUndefined();
    expect(http.get).not.toHaveBeenCalled();
  });

  it("explains off, expired and error states", async () => {
    const off = await collectStatus(setup({ connected: false, phase: "off" }).runtime, FAST);
    expect(off.state).toBe("off");
    expect(off.error).toBe("Honcho is off for pi. Run /honcho on to turn it back on.");
    expect(off.account).toEqual({ name: "aakash", method: "api key", scope: "pi only" });

    const grant = {
      accessToken: "a",
      refreshToken: `r-${randomBytes(4).toString("hex")}`,
      accessExpiresAt: 1,
      clientId: "honcho-pi",
      scope: "write",
      host: "https://api.honcho.dev",
    };
    const expired = await collectStatus(
      setup({ file: { peerName: "aakash", oauth: grant }, connected: false, phase: "expired" })
        .runtime,
      FAST,
    );
    expect(expired.state).toBe("expired");
    expect(expired.error).toBe("Honcho sign-in expired. Run /honcho login.");
    expect(expired.account).toEqual({ name: "aakash", method: "oauth", scope: "shared" });

    const broken = await collectStatus(
      setup({
        connected: false,
        phase: "error",
        lastError: "~/.honcho/config.json is not valid JSON",
      }).runtime,
      FAST,
    );
    expect(broken.state).toBe("error");
    expect(broken.error).toBe("~/.honcho/config.json is not valid JSON");
  });

  it("predicts the session per strategy, except git-branch", async () => {
    const chat = { peerName: "aakash", hosts: { pi: { sessionStrategy: "chat-instance" } } };
    const instance = await collectStatus(
      setup({ file: chat, connected: false, phase: "signed-out" }).runtime,
      FAST,
    );
    expect(instance.session).toEqual({ name: "aakash-chat-abc123", strategy: "chat-instance" });
    const branch = { peerName: "aakash", hosts: { pi: { sessionStrategy: "git-branch" } } };
    const git = await collectStatus(
      setup({ file: branch, connected: false, phase: "signed-out" }).runtime,
      FAST,
    );
    expect(git.session).toBeUndefined();
  });

  it("tries one reconnect when unreachable", async () => {
    const { runtime, connection } = setup({ connected: false, phase: "unreachable" });
    const ready = vi.fn((_ms: number) => {
      runtime.connection = connection;
      runtime.phase = "connected";
      return Promise.resolve(connection);
    });
    runtime.ready = ready;
    const status = await collectStatus(runtime, FAST);
    expect(ready).toHaveBeenCalledWith(FAST.timeoutMs);
    expect(status.state).toBe("connected");
    expect(status.memory?.conclusions).toBe(1284);
  });

  it("stays unreachable when the reconnect fails", async () => {
    const { runtime } = setup({ connected: false, phase: "unreachable" });
    runtime.ready = vi.fn(() => Promise.resolve(undefined));
    const status = await collectStatus(runtime, FAST);
    expect(status.state).toBe("unreachable");
    expect(status.error).toBe("api.honcho.dev is unreachable; Honcho memory is paused.");
    expect(status.memory).toBeUndefined();
  });

  it("recovers an unreachable connection whose reads succeed", async () => {
    const { runtime } = setup({ phase: "unreachable" });
    const status = await collectStatus(runtime, FAST);
    expect(status.state).toBe("connected");
    expect(runtime.phase).toBe("connected");
    expect(status.memory?.sessions).toBe(37);
  });

  it("waits for a connect in flight", async () => {
    const { runtime, connection } = setup({ connected: false, phase: "connecting" });
    runtime.ready = vi.fn(async () => {
      await later(undefined, 10);
      runtime.connection = connection;
      runtime.phase = "connected";
      return connection;
    });
    const status = await collectStatus(runtime, FAST);
    expect(status.state).toBe("connected");
  });
});
