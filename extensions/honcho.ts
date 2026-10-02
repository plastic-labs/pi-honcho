import { createRequire } from "node:module";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { setTelemetryHeaders, telemetryHeaders } from "@honcho-ai/harness-plugin-core";
import {
  AuthenticationError,
  ConnectionError,
  Honcho,
  HonchoError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  TimeoutError,
} from "@honcho-ai/sdk";
import { SignInExpiredError } from "./auth/credentials.js";

const require = createRequire(import.meta.url);
export const PLUGIN_VERSION: string = (require("../package.json") as { version: string }).version;
export const PLUGIN_NAME = "pi-honcho";

export type ErrorKind = "auth" | "expired" | "unreachable" | "rate-limited" | "invalid" | "other";

export const classify = (error: unknown): ErrorKind => {
  if (error instanceof SignInExpiredError) {
    return "expired";
  }
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return "auth";
  }
  if (error instanceof ConnectionError || error instanceof TimeoutError) {
    return "unreachable";
  }
  // A 500 is one endpoint failing; gateway errors mean the instance is down
  if (error instanceof ServerError) {
    return error.status >= 502 && error.status <= 504 ? "unreachable" : "other";
  }
  if (error instanceof RateLimitError) {
    return "rate-limited";
  }
  if ((error as { name?: string } | null)?.name === "ZodError") {
    return "invalid";
  }
  if ((error as { name?: string } | null)?.name === "OAuthError") {
    const { code, status } = error as { code?: string; status?: number };
    return code === "connection_error" || code === "rate_limited" || (status ?? 0) >= 500
      ? "unreachable"
      : "other";
  }
  return "other";
};

export const errorMessage = (error: unknown): string => {
  if ((error as { name?: string } | null)?.name === "ZodError") {
    const issue = (error as { issues?: { message?: string }[] }).issues?.[0]?.message;
    if (issue) {
      return issue;
    }
  }
  if (error instanceof HonchoError) {
    // FastAPI validation errors carry an array detail that the SDK stringifies as [object Object]
    const detail = (error.body as { detail?: unknown } | undefined)?.detail;
    if (Array.isArray(detail) && detail.length) {
      const first = detail[0] as { msg?: string; loc?: unknown[] };
      const where = Array.isArray(first.loc)
        ? first.loc.filter((part) => part !== "body").join(".")
        : "";
      if (first.msg) {
        return where ? `${where}: ${first.msg}` : first.msg;
      }
    }
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

export class TurnTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`timed out after ${Math.round(ms / 1000)}s`);
    this.name = "TurnTimeoutError";
  }
}

/** Races a promise against a deadline; the underlying request keeps running. */
export const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TurnTimeoutError(ms)), Math.max(0, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/** Rejects with an AbortError when the signal fires; the SDK has no signal support. */
export const abortable = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
};

export interface ClientOptions {
  token: string;
  baseUrl: string;
  workspace: string;
  timeoutMs: number;
  model?: string;
}

export interface Clients {
  /** Reads, writes and status calls. */
  fast: Honcho;
  /** Dialectic calls; long timeout, no retries. */
  dialectic: Honcho;
}

const headers = (model?: string) =>
  telemetryHeaders({
    host: "pi",
    hostVersion: PI_VERSION,
    plugin: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    model,
  });

export const createClients = (opts: ClientOptions): Clients => ({
  fast: new Honcho({
    apiKey: opts.token,
    baseURL: opts.baseUrl,
    workspaceId: opts.workspace,
    timeout: Math.min(opts.timeoutMs, 30_000),
    maxRetries: 1,
    defaultHeaders: headers(opts.model),
  }),
  dialectic: new Honcho({
    apiKey: opts.token,
    baseURL: opts.baseUrl,
    workspaceId: opts.workspace,
    timeout: 120_000,
    maxRetries: 0,
    defaultHeaders: headers(opts.model),
  }),
});

/** Swaps the bearer on live clients; peers and sessions share the same HTTP client. */
export const setToken = (clients: Clients, token: string): void => {
  for (const client of [clients.fast, clients.dialectic]) {
    (client.http as unknown as { apiKey?: string }).apiKey = token;
  }
};

export const setModel = (clients: Clients, model: string | undefined): void => {
  if (!model) {
    return;
  }
  for (const client of [clients.fast, clients.dialectic]) {
    setTelemetryHeaders(client.http.defaultHeaders, { model });
  }
};

export const tokenOf = (clients: Clients): string | undefined =>
  (clients.fast.http as unknown as { apiKey?: string }).apiKey;

/** One-RTT auth probe that creates nothing. Throws classified SDK errors. */
export const probe = async (
  opts: Omit<ClientOptions, "timeoutMs"> & { timeoutMs?: number },
): Promise<number> => {
  const honcho = new Honcho({
    apiKey: opts.token,
    baseURL: opts.baseUrl,
    workspaceId: opts.workspace,
    timeout: opts.timeoutMs ?? 8_000,
    maxRetries: 0,
    defaultHeaders: headers(opts.model),
  });
  const started = performance.now();
  try {
    await honcho.http.get(`/v3/workspaces/${encodeURIComponent(opts.workspace)}/queue/status`);
  } catch (error) {
    // Workspace-scoped keys cannot read queue status; the peer card route proves auth for them
    if (error instanceof AuthenticationError && /permissioned|admin/i.test(error.message)) {
      await honcho.http
        .get(
          `/v3/workspaces/${encodeURIComponent(opts.workspace)}/peers/${encodeURIComponent("_probe")}/card`,
        )
        .catch((e: unknown) => {
          if (e instanceof AuthenticationError) {
            throw e;
          }
        });
    } else {
      throw error;
    }
  }
  return Math.round(performance.now() - started);
};

export { PI_VERSION };
