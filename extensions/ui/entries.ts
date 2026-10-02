import type { PerTurnMode, ReasoningLevel, SessionStrategy, SettingSource } from "../settings.js";

export const STATUS_ENTRY_TYPE = "honcho-status";
export const LOGIN_ENTRY_TYPE = "honcho-login";

/** Right-hand column in the status panel and settings overlay. */
export type ScopeTag = "shared" | "pi only" | "env";

export const scopeTag = (source: SettingSource, sharedWhenDefault: boolean): ScopeTag =>
  source === "env"
    ? "env"
    : source === "pi"
      ? "pi only"
      : source === "shared"
        ? "shared"
        : sharedWhenDefault
          ? "shared"
          : "pi only";

export type AccountMethod = "oauth" | "api key" | "env key";

export interface StatusSnapshot {
  state: "connected" | "connecting" | "off" | "signed-out" | "expired" | "unreachable" | "error";
  endpoint: string;
  latencyMs?: number;
  error?: string;
  account?: {
    name: string;
    method: AccountMethod;
    scope: ScopeTag;
    /** Minutes until the OAuth access token is refreshed. */
    renewsInMin?: number;
  };
  workspace: { value: string; scope: ScopeTag };
  peers: { user: string; ai: string; scope: ScopeTag };
  session?: { name: string; strategy: SessionStrategy };
  memory?: { conclusions?: number; peerCardFacts?: number; sessions?: number };
  queue?: { pending: number; inProgress: number };
  injection: {
    sessionStart: string[];
    perTurn: PerTurnMode;
    reasoning: ReasoningLevel;
    maxConclusions: number;
  };
  tools: string[];
  warnings: string[];
}

export interface LoginEntryData {
  user: string;
  method: "oauth" | "api key";
  endpoint: string;
  workspace: string;
  peer: string;
  aiPeer: string;
  session: string;
  strategy: SessionStrategy;
  savedTo: string;
  sharedWith: string;
  /** E.g. which OAuth client the grant was issued to. */
  note?: string;
}
