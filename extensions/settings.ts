import { normalizeBaseUrl, resolveConfig } from "@honcho-ai/harness-plugin-core";
import type { RootConfig } from "@honcho-ai/harness-plugin-core";
import { HOST, getPath, hostBlock, isObject } from "./config-file.js";
import type { Json, JsonObject } from "./config-file.js";

export type SessionStrategy = "per-directory" | "git-branch" | "chat-instance";
export type PerTurnMode = "chat" | "context" | "off";
export type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "max";
export type SettingSource = "env" | "pi" | "shared" | "default";

export const SESSION_STRATEGIES: readonly SessionStrategy[] = [
  "per-directory",
  "git-branch",
  "chat-instance",
];
export const PER_TURN_MODES: readonly PerTurnMode[] = ["chat", "context", "off"];
export const REASONING_LEVELS: readonly ReasoningLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "max",
];

export const DEFAULT_AI_PEER = "pi";
export const DEFAULT_DIALECTIC_TEMPLATE =
  "Return a compact, factual list of anything from the user's history (preferences, prior decisions, relevant past work) that would help with the following. Write in the third person as background notes; do not address the user, ask questions, or offer next steps. If nothing relevant exists, say so in one line. Relevant to: %{user_query}";
export const TURN_BUDGET_MS = 30_000;

export interface InjectionSettings {
  sessionStart: { summary: boolean; peerCard: boolean };
  perTurn: PerTurnMode;
  reasoning: ReasoningLevel;
  template: string;
  maxConclusions: number;
  searchTopK: number;
  searchMaxDistance: number;
  showSessionStart: boolean;
  showPerTurn: boolean;
}

export interface PiSettings {
  enabled: boolean;
  baseUrl: string;
  workspace: string;
  peerName: string;
  aiPeer: string;
  timeoutMs: number;
  sessionStrategy: SessionStrategy;
  saveMessages: boolean;
  injection: InjectionSettings;
  tools: { chat: boolean; search: boolean };
  /** Where each overlay-editable value came from. */
  sources: {
    enabled: SettingSource;
    baseUrl: SettingSource;
    workspace: SettingSource;
    peerName: SettingSource;
    aiPeer: SettingSource;
  };
  warnings: string[];
}

type Env = Record<string, string | undefined>;

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Coerces a string into a valid Honcho id (`^[A-Za-z0-9_-]+$`). */
export const toHonchoId = (value: string): string =>
  value
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 512) || "user";

const str = (value: Json | undefined): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const bool = (value: Json | undefined): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const int = (value: Json | undefined, min: number, max: number): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};

const num = (value: Json | undefined, min: number, max: number): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

const strings = (value: Json | undefined): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;

export const normalizeStrategy = (value: string | undefined): SessionStrategy | undefined => {
  if (!value) {
    return undefined;
  }
  if ((SESSION_STRATEGIES as readonly string[]).includes(value)) {
    return value as SessionStrategy;
  }
  // V1 names
  if (value === "repo" || value === "directory") {
    return "per-directory";
  }
  return undefined;
};

export const normalizeReasoning = (value: string | undefined): ReasoningLevel | undefined =>
  value && (REASONING_LEVELS as readonly string[]).includes(value)
    ? (value as ReasoningLevel)
    : undefined;

/** `perTurn` accepts claude-honcho's component list or a bare mode string. */
export const parsePerTurn = (value: Json | undefined): PerTurnMode | undefined => {
  if (typeof value === "string") {
    if ((PER_TURN_MODES as readonly string[]).includes(value)) {
      return value as PerTurnMode;
    }
    if (value === "dialectic") {
      return "chat";
    }
    if (value === "userContext") {
      return "context";
    }
    return undefined;
  }
  const list = strings(value);
  if (!list) {
    return undefined;
  }
  if (list.includes("dialectic")) {
    return "chat";
  }
  if (list.includes("userContext") || list.includes("context")) {
    return "context";
  }
  return "off";
};

export const perTurnToFile = (mode: PerTurnMode): string[] =>
  mode === "chat" ? ["dialectic"] : mode === "context" ? ["userContext"] : [];

/** V0 endpoint shapes that harness core does not migrate. */
const legacyBaseUrl = (block: JsonObject): string | undefined => {
  const { endpoint } = block;
  if (typeof endpoint === "string" && endpoint.trim()) {
    return endpoint.trim();
  }
  if (isObject(endpoint)) {
    if (typeof endpoint.baseUrl === "string" && endpoint.baseUrl.trim()) {
      return endpoint.baseUrl.trim();
    }
    if (endpoint.environment === "local") {
      return "http://localhost:8000";
    }
  }
  return undefined;
};

const hasBaseUrl = (block: JsonObject): boolean =>
  Boolean(str(block.baseUrl) ?? str(block.environmentUrl) ?? legacyBaseUrl(block));

export const resolveSettings = (file: JsonObject, env: Env = process.env): PiSettings => {
  const pi = hostBlock(file);
  const warnings: string[] = [];

  // Harness core resolves the six shared fields; v0 shapes it skips arrive via the overlay
  const overlay: RootConfig = {};
  const piLegacyUrl = str(pi.baseUrl) || str(pi.environmentUrl) ? undefined : legacyBaseUrl(pi);
  const rootLegacyUrl =
    str(file.baseUrl) || str(file.environmentUrl) ? undefined : legacyBaseUrl(file);
  if (piLegacyUrl) {
    overlay.baseUrl = piLegacyUrl;
  } else if (rootLegacyUrl && !hasBaseUrl(pi)) {
    overlay.baseUrl = rootLegacyUrl;
  }
  const core = resolveConfig(file, { host: HOST, env, overlay });
  warnings.push(...core.warnings.filter((w) => !w.includes("shadows auth.apiKey")));

  const envBaseUrl = env.HONCHO_BASE_URL || env.HONCHO_URL || env.HONCHO_ENDPOINT;
  const envWorkspace = env.HONCHO_WORKSPACE || env.HONCHO_WORKSPACE_ID;
  const sources: PiSettings["sources"] = {
    enabled:
      env.HONCHO_ENABLED === "false"
        ? "env"
        : bool(pi.enabled) !== undefined
          ? "pi"
          : bool(file.enabled) !== undefined
            ? "shared"
            : "default",
    baseUrl: envBaseUrl ? "env" : hasBaseUrl(pi) ? "pi" : hasBaseUrl(file) ? "shared" : "default",
    workspace: envWorkspace
      ? "env"
      : str(pi.workspace)
        ? "pi"
        : str(file.workspace)
          ? "shared"
          : "default",
    peerName: env.HONCHO_PEER_NAME
      ? "env"
      : str(pi.peerName)
        ? "pi"
        : str(file.peerName)
          ? "shared"
          : "default",
    aiPeer: env.HONCHO_AI_PEER ? "env" : str(pi.aiPeer) ? "pi" : "default",
  };

  const ids = {
    workspace: core.workspace,
    peerName: core.peerName,
    aiPeer: env.HONCHO_AI_PEER || str(pi.aiPeer) || DEFAULT_AI_PEER,
  };
  for (const [key, value] of Object.entries(ids)) {
    if (!ID_PATTERN.test(value)) {
      const fixed = toHonchoId(value);
      warnings.push(`${key} "${value}" is not a valid Honcho id; using "${fixed}"`);
      ids[key as keyof typeof ids] = fixed;
    }
  }

  const envStrategy = env.HONCHO_SESSION_STRATEGY;
  const fileStrategy = str(pi.sessionStrategy);
  const sessionStrategy =
    normalizeStrategy(envStrategy) ?? normalizeStrategy(fileStrategy) ?? "per-directory";
  for (const raw of [envStrategy, fileStrategy]) {
    if (raw && !normalizeStrategy(raw)) {
      warnings.push(`unknown sessionStrategy "${raw}"; using ${sessionStrategy}`);
    }
  }

  const inj = isObject(pi.injection) ? pi.injection : {};
  const startParts = strings(inj.sessionStart);
  const show = strings(inj.showInChat);
  const tools = isObject(pi.tools) ? pi.tools : {};

  return {
    enabled: core.enabled,
    baseUrl: normalizeBaseUrl(core.baseUrl),
    workspace: ids.workspace,
    peerName: ids.peerName,
    aiPeer: ids.aiPeer,
    timeoutMs: core.timeoutMs,
    sessionStrategy,
    saveMessages: bool(pi.saveMessages) ?? bool(file.saveMessages) ?? true,
    injection: {
      sessionStart: {
        summary: startParts ? startParts.includes("summary") : true,
        peerCard: startParts ? startParts.includes("peerCard") : true,
      },
      perTurn: parsePerTurn(inj.perTurn) ?? "chat",
      reasoning: normalizeReasoning(str(inj.dialecticReasoning)) ?? "medium",
      template: str(inj.dialecticTemplate) ?? DEFAULT_DIALECTIC_TEMPLATE,
      maxConclusions: int(inj.maxConclusions, 1, 100) ?? 15,
      searchTopK: int(inj.searchTopK, 1, 100) ?? 10,
      searchMaxDistance: num(inj.searchMaxDistance, 0, 1) ?? 0.6,
      showSessionStart: show ? show.includes("sessionStart") : true,
      showPerTurn: show ? show.includes("perTurn") : true,
    },
    tools: { chat: bool(tools.honcho_chat) ?? true, search: bool(tools.honcho_search) ?? true },
    sources,
    warnings,
  };
};

/** Host label for display, e.g. `api.honcho.dev`. */
export const endpointLabel = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
};

export const readPiKey = (file: JsonObject): string | undefined => {
  const pi = hostBlock(file);
  const nested = getPath(pi, ["auth", "apiKey"]);
  return str(pi.apiKey) ?? (typeof nested === "string" ? str(nested) : undefined);
};
