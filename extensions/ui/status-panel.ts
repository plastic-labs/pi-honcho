import { REFRESH_SKEW_S } from "../auth/credentials.js";
import type { Credential, CredentialSource } from "../auth/credentials.js";
import { withTimeout } from "../honcho.js";
import { TOOL_NAMES } from "../runtime.js";
import type { Connection, HonchoRuntime, RuntimePhase } from "../runtime.js";
import { deriveSessionName, sessionsMap } from "../session-name.js";
import { endpointLabel } from "../settings.js";
import type { PiSettings } from "../settings.js";
import { scopeTag } from "./entries.js";
import type { AccountMethod, ScopeTag, StatusSnapshot } from "./entries.js";

export const STATUS_TIMEOUT_MS = 5_000;

export interface CollectOptions {
  /** Bound for each read and for the reconnect attempt. */
  timeoutMs?: number;
  now?: number;
}

const STATES: Record<RuntimePhase, StatusSnapshot["state"]> = {
  idle: "connecting",
  connecting: "connecting",
  connected: "connected",
  off: "off",
  "signed-out": "signed-out",
  expired: "expired",
  unreachable: "unreachable",
  error: "error",
};

const METHODS: Record<CredentialSource, AccountMethod> = {
  oauth: "oauth",
  "pi-key": "api key",
  "shared-key": "api key",
  env: "env key",
};
const SCOPES: Record<CredentialSource, ScopeTag> = {
  oauth: "shared",
  "shared-key": "shared",
  "pi-key": "pi only",
  env: "env",
};

interface LiveStatus {
  latencyMs?: number;
  queue?: { pending: number; inProgress: number };
  conclusions?: number;
  peerCardFacts?: number;
  sessions?: number;
}

/** Raw `GET queue/status` body; the SDK method would first get-or-create the workspace. */
interface QueueStatusBody {
  pending_work_units?: number;
  in_progress_work_units?: number;
}

const settle = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  try {
    return await withTimeout(promise, ms);
  } catch {
    return undefined;
  }
};

const timed = async <T>(promise: Promise<T>): Promise<{ value: T; ms: number }> => {
  const started = performance.now();
  const value = await promise;
  return { value, ms: Math.round(performance.now() - started) };
};

/** Latency and counts; a failed or slow read leaves its field unset. */
const readLive = async (runtime: HonchoRuntime, ms: number): Promise<LiveStatus> => {
  const live: LiveStatus = {};
  let cardMs: number | undefined;
  const read = async (c: Connection) => {
    const workspace = encodeURIComponent(c.clients.fast.workspaceId);
    const queue = async () => {
      const { value, ms: took } = await timed(
        c.clients.fast.http.get<QueueStatusBody>(`/v3/workspaces/${workspace}/queue/status`),
      );
      live.latencyMs = took;
      live.queue = {
        pending: value.pending_work_units ?? 0,
        inProgress: value.in_progress_work_units ?? 0,
      };
    };
    const conclusions = async () => {
      live.conclusions = (await c.userPeer.conclusions.list({ size: 1 })).total;
    };
    const sessions = async () => {
      live.sessions = (await c.userPeer.sessions({ size: 1 })).total;
    };
    const card = async () => {
      const { value, ms: took } = await timed(c.userPeer.getCard());
      live.peerCardFacts = value?.length ?? 0;
      cardMs = took;
    };
    // Every key scope may read the peer card, so only its failure marks the connection unhealthy
    await Promise.all([
      settle(queue(), ms),
      settle(conclusions(), ms),
      settle(sessions(), ms),
      withTimeout(card(), ms),
    ]);
  };
  // Room for one token refresh before the reads
  await settle(runtime.call(read), ms * 2);
  live.latencyMs ??= cardMs;
  return live;
};

const accountOf = (
  name: string,
  credential: Credential | null,
  live: boolean,
  now: number,
): StatusSnapshot["account"] => {
  if (!credential) {
    return undefined;
  }
  const account: NonNullable<StatusSnapshot["account"]> = {
    name,
    method: METHODS[credential.source],
    scope: SCOPES[credential.source],
  };
  if (live && credential.source === "oauth" && credential.grant) {
    account.renewsInMin = Math.max(
      0,
      Math.floor((credential.grant.accessExpiresAt - REFRESH_SKEW_S - now / 1000) / 60),
    );
  }
  return account;
};

const peersScope = (sources: PiSettings["sources"]): ScopeTag => {
  const tags = [scopeTag(sources.peerName, true), scopeTag(sources.aiPeer, false)];
  if (tags.includes("env")) {
    return "env";
  }
  return tags.includes("pi only") ? "pi only" : "shared";
};

/** The connected session, else the name this directory would map to; git-branch needs git, so it waits for a connect. */
const sessionOf = (runtime: HonchoRuntime): StatusSnapshot["session"] => {
  const { settings } = runtime;
  let name = runtime.connection?.sessionName ?? runtime.sessionName;
  if (!name && settings.sessionStrategy !== "git-branch") {
    try {
      name = deriveSessionName({
        strategy: settings.sessionStrategy,
        cwd: runtime.ctx?.cwd ?? process.cwd(),
        peerName: settings.peerName,
        sessions: sessionsMap(runtime.file),
        instanceId: runtime.ctx?.sessionManager.getSessionId(),
      });
    } catch {
      // Stale ctx after a session replacement
    }
  }
  return name ? { name, strategy: settings.sessionStrategy } : undefined;
};

/** Everything the `/honcho` panel shows; network reads are bounded and never throw. */
export const collectStatus = async (
  runtime: HonchoRuntime,
  opts: CollectOptions = {},
): Promise<StatusSnapshot> => {
  const ms = opts.timeoutMs ?? STATUS_TIMEOUT_MS;
  if (runtime.phase === "unreachable" || runtime.phase === "connecting") {
    await runtime.ready(ms);
  }
  const live =
    runtime.connection && (runtime.phase === "connected" || runtime.phase === "unreachable")
      ? await readLive(runtime, ms)
      : undefined;

  const { settings } = runtime;
  const state = STATES[runtime.phase];
  const connected = state === "connected";
  const endpoint = endpointLabel(settings.baseUrl);
  const { sessionStart, perTurn, reasoning, maxConclusions } = settings.injection;
  const snapshot: StatusSnapshot = {
    state,
    endpoint,
    account: accountOf(settings.peerName, runtime.credential, connected, opts.now ?? Date.now()),
    workspace: { value: settings.workspace, scope: scopeTag(settings.sources.workspace, false) },
    peers: { user: settings.peerName, ai: settings.aiPeer, scope: peersScope(settings.sources) },
    session: sessionOf(runtime),
    injection: {
      sessionStart: [
        ...(sessionStart.summary ? ["summary"] : []),
        ...(sessionStart.peerCard ? ["peer card"] : []),
      ],
      perTurn,
      reasoning,
      maxConclusions,
    },
    tools: [
      ...(settings.tools.chat ? [TOOL_NAMES.chat] : []),
      ...(settings.tools.search ? [TOOL_NAMES.search] : []),
    ],
    warnings: [...settings.warnings],
  };

  if (!connected) {
    snapshot.error = runtime.describeUnavailable();
    return snapshot;
  }
  if (live) {
    snapshot.latencyMs = live.latencyMs;
    snapshot.queue = live.queue;
    snapshot.memory = {
      conclusions: live.conclusions,
      peerCardFacts: live.peerCardFacts,
      sessions: live.sessions,
    };
    if (Object.values(live).every((value) => value === undefined)) {
      snapshot.warnings.push(`could not read memory counts from ${endpoint}`);
    }
    if (live.conclusions !== undefined && live.conclusions !== runtime.conclusions) {
      runtime.conclusions = live.conclusions;
      runtime.setPhase("connected");
    }
  }
  return snapshot;
};
