import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const SCOPE = "write";
export const SOURCE = "pi";
export const PI_CLIENT_ID = "honcho-pi";
export const CLI_CLIENT_ID = "honcho-cli";
export const BROWSER_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PERMANENT = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

export type Fetch = typeof fetch;

export interface AuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint?: string;
  revocationEndpoint?: string;
  registrationEndpoint?: string;
  grantTypes: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  config?: Record<string, unknown>;
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly description?: string,
    readonly status?: number,
  ) {
    super(description ? `${code}: ${description}` : code);
    this.name = "OAuthError";
  }

  /** The grant or client is dead; retrying will not help. */
  get permanent(): boolean {
    return PERMANENT.has(this.code);
  }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OAuthError("cancelled"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new OAuthError("cancelled"));
      },
      { once: true },
    );
  });

const trimSlash = (url: string) => url.replace(/\/+$/, "");

/** RFC 8414 discovery. `null` means no managed authorization server, so API key only. */
export const discover = async (
  baseUrl: string,
  fetchImpl: Fetch = fetch,
): Promise<AuthServer | null> => {
  try {
    const res = await fetchImpl(`${trimSlash(baseUrl)}/.well-known/oauth-authorization-server`, {
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return null;
    }
    const m = (await res.json()) as Record<string, unknown>;
    if (typeof m.token_endpoint !== "string" || typeof m.authorization_endpoint !== "string") {
      return null;
    }
    const opt = (key: string) => (typeof m[key] === "string" ? m[key] : undefined);
    return {
      issuer: opt("issuer") ?? baseUrl,
      authorizationEndpoint: m.authorization_endpoint,
      tokenEndpoint: m.token_endpoint,
      deviceAuthorizationEndpoint: opt("device_authorization_endpoint"),
      revocationEndpoint: opt("revocation_endpoint"),
      registrationEndpoint: opt("registration_endpoint"),
      grantTypes: Array.isArray(m.grant_types_supported)
        ? m.grant_types_supported.filter((g): g is string => typeof g === "string")
        : [],
    };
  } catch {
    return null;
  }
};

interface FormResult {
  status: number;
  body: Record<string, unknown>;
}

const postForm = async (
  url: string,
  form: Record<string, string>,
  fetchImpl: Fetch,
  signal?: AbortSignal,
): Promise<FormResult> => {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      body: new URLSearchParams(form),
      headers: { Accept: "application/json" },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new OAuthError("cancelled");
    }
    throw new OAuthError("connection_error", (error as Error).message);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
};

const fail = ({ status, body }: FormResult): never => {
  if (status === 429) {
    throw new OAuthError("rate_limited", "Too many requests; wait a minute and try again", 429);
  }
  const code = typeof body.error === "string" ? body.error : `http_${status}`;
  const description =
    typeof body.error_description === "string"
      ? body.error_description
      : typeof body.detail === "string"
        ? body.detail
        : undefined;
  throw new OAuthError(code, description, status);
};

const asToken = (body: Record<string, unknown>): TokenResponse => {
  if (typeof body.access_token !== "string") {
    throw new OAuthError("invalid_response", "no access_token in response");
  }
  return {
    access_token: body.access_token,
    token_type: typeof body.token_type === "string" ? body.token_type : "Bearer",
    expires_in: typeof body.expires_in === "number" ? body.expires_in : 3600,
    refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    config:
      typeof body.config === "object" && body.config !== null
        ? (body.config as Record<string, unknown>)
        : undefined,
  };
};

/** Side-effect-free probe: does the client exist and hold this grant? */
export const clientSupports = async (
  as: AuthServer,
  clientId: string,
  grantType: string,
  fetchImpl: Fetch = fetch,
): Promise<boolean> => {
  const { body } = await postForm(
    as.tokenEndpoint,
    { grant_type: grantType, client_id: clientId },
    fetchImpl,
  );
  return body.error === "invalid_request";
};

/** RFC 7591 registration of a per-install public client (authorization code only). */
export const registerClient = async (as: AuthServer, fetchImpl: Fetch = fetch): Promise<string> => {
  if (!as.registrationEndpoint) {
    throw new OAuthError(
      "registration_unavailable",
      "this server does not allow client registration",
    );
  }
  let res: Response;
  try {
    res = await fetchImpl(as.registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "pi",
        redirect_uris: ["http://127.0.0.1/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        scope: SCOPE,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OAuthError("connection_error", (error as Error).message);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status !== 200 && res.status !== 201) {
    fail({ status: res.status, body });
  }
  if (typeof body.client_id !== "string") {
    throw new OAuthError("invalid_response", "no client_id in registration response");
  }
  return body.client_id;
};

export interface ClientChoice {
  clientId: string;
  /** Shown when pi signs in under another client's name. */
  note?: string;
  registered?: boolean;
}

/** Picks the client for a flow: `honcho-pi` when seeded, else a fallback. */
export const chooseClient = async (
  as: AuthServer,
  flow: "browser" | "device",
  opts: { override?: string; registeredClientId?: string; fetchImpl?: Fetch } = {},
): Promise<ClientChoice> => {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (opts.override) {
    return { clientId: opts.override };
  }
  const grant = flow === "browser" ? "authorization_code" : DEVICE_GRANT;
  if (await clientSupports(as, PI_CLIENT_ID, grant, fetchImpl)) {
    return { clientId: PI_CLIENT_ID };
  }
  if (flow === "device") {
    if (await clientSupports(as, CLI_CLIENT_ID, DEVICE_GRANT, fetchImpl)) {
      return { clientId: CLI_CLIENT_ID, note: 'The approval page will say "Honcho CLI".' };
    }
    throw new OAuthError(
      "unsupported_grant_type",
      "device sign-in is not available on this server",
    );
  }
  if (
    opts.registeredClientId &&
    (await clientSupports(as, opts.registeredClientId, grant, fetchImpl))
  ) {
    return { clientId: opts.registeredClientId, registered: true };
  }
  return { clientId: await registerClient(as, fetchImpl), registered: true };
};

// ── Device code (RFC 8628) ─────────────────────────────────────────────

export const requestDeviceCode = async (
  as: AuthServer,
  clientId: string,
  opts: { signal?: AbortSignal; fetchImpl?: Fetch } = {},
): Promise<DeviceCode> => {
  if (!as.deviceAuthorizationEndpoint) {
    throw new OAuthError(
      "unsupported_grant_type",
      "device sign-in is not available on this server",
    );
  }
  const result = await postForm(
    as.deviceAuthorizationEndpoint,
    { client_id: clientId, scope: SCOPE, source: SOURCE },
    opts.fetchImpl ?? fetch,
    opts.signal,
  );
  if (result.status !== 200) {
    fail(result);
  }
  const b = result.body;
  if (
    typeof b.device_code !== "string" ||
    typeof b.user_code !== "string" ||
    typeof b.verification_uri !== "string"
  ) {
    throw new OAuthError("invalid_response", "incomplete device authorization response");
  }
  return {
    device_code: b.device_code,
    user_code: b.user_code,
    verification_uri: b.verification_uri,
    verification_uri_complete:
      typeof b.verification_uri_complete === "string"
        ? b.verification_uri_complete
        : `${b.verification_uri}?user_code=${encodeURIComponent(b.user_code)}`,
    expires_in: typeof b.expires_in === "number" ? b.expires_in : 600,
    interval: typeof b.interval === "number" ? b.interval : 5,
  };
};

export const pollDeviceToken = async (
  as: AuthServer,
  clientId: string,
  code: DeviceCode,
  opts: {
    signal?: AbortSignal;
    fetchImpl?: Fetch;
    onPoll?: () => void;
    sleepImpl?: typeof sleep;
    now?: () => number;
  } = {},
): Promise<TokenResponse> => {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const wait = opts.sleepImpl ?? sleep;
  const now = opts.now ?? Date.now;
  let interval = Math.min(Math.max(code.interval, 1), 60);
  const deadline = now() + code.expires_in * 1000;
  for (;;) {
    if (now() + interval * 1000 >= deadline) {
      throw new OAuthError("expired_token", "the code expired before it was approved");
    }
    // Sleeping after each response keeps spacing at interval + RTT, which the server checks
    await wait(interval * 1000, opts.signal);
    opts.onPoll?.();
    let result: FormResult;
    try {
      result = await postForm(
        as.tokenEndpoint,
        { grant_type: DEVICE_GRANT, device_code: code.device_code, client_id: clientId },
        fetchImpl,
        opts.signal,
      );
    } catch (error) {
      if (error instanceof OAuthError && error.code === "connection_error") {
        continue;
      }
      throw error;
    }
    if (result.status === 200) {
      return asToken(result.body);
    }
    // A gateway blip mid-approval should not end the sign-in
    if (result.status >= 500) {
      continue;
    }
    if (result.body.error === "authorization_pending") {
      continue;
    }
    if (result.body.error === "slow_down") {
      interval = Math.min(interval + 5, 60);
      continue;
    }
    fail(result);
  }
};

// ── Browser: authorization code + PKCE + loopback ────────────────────

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (res: ServerResponse, status: number, title: string, body: string) => {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<body style="font:14px ui-monospace,Menlo,monospace;background:#1a1a1a;color:#e4e4e4;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
      `<div>${escapeHtml(body)}</div></body>`,
  );
};

export interface BrowserLogin {
  authorizeUrl: string;
  redirectUri: string;
  port: number;
  deadline: number;
  result: Promise<TokenResponse>;
  /** Fallback when the browser cannot reach this machine's loopback (SSH, containers). */
  submitRedirectUrl(input: string): void;
  cancel(): void;
}

export const pkcePair = () => {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

export const startBrowserLogin = async (
  as: AuthServer,
  clientId: string,
  opts: { timeoutMs?: number; fetchImpl?: Fetch } = {},
): Promise<BrowserLogin> => {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(32).toString("base64url");
  const timeoutMs = opts.timeoutMs ?? BROWSER_TIMEOUT_MS;
  let redirectUri = "";
  let settled = false;
  let claimed = false;
  let resolveResult!: (token: TokenResponse) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<TokenResponse>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  result.catch(() => {});

  const exchange = async (code: string): Promise<TokenResponse> => {
    const r = await postForm(
      as.tokenEndpoint,
      {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      fetchImpl,
    );
    if (r.status !== 200) {
      fail(r);
    }
    return asToken(r.body);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get("state") !== state) {
      page(res, 400, "Honcho sign-in failed", "State mismatch. Start sign-in again from pi.");
      return;
    }
    if (claimed || settled) {
      page(res, 409, "Honcho", "This sign-in was already handled. You can close this tab.");
      return;
    }
    const err = url.searchParams.get("error");
    if (err) {
      page(
        res,
        400,
        "Honcho sign-in failed",
        `Sign-in was not completed (${err}). You can close this tab.`,
      );
      finish(new OAuthError(err, url.searchParams.get("error_description") ?? undefined));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      page(res, 400, "Honcho sign-in failed", "Missing authorization code.");
      return;
    }
    claimed = true;
    // Codes live 60s, so exchange before answering the browser
    exchange(code).then(
      (token) => {
        page(
          res,
          200,
          "Honcho connected",
          "Connected to Honcho. You can close this tab and return to pi.",
        );
        finish(token);
      },
      (error: Error) => {
        page(res, 502, "Honcho sign-in failed", error.message);
        finish(error);
      },
    );
  });

  const timer = setTimeout(
    () => finish(new OAuthError("timeout", "no approval within 5 minutes")),
    timeoutMs,
  );
  timer.unref?.();

  function finish(value: TokenResponse | Error) {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
    if (value instanceof Error) {
      rejectResult(value);
    } else {
      resolveResult(value);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  redirectUri = `http://127.0.0.1:${port}/callback`;
  const authorizeUrl = `${as.authorizationEndpoint}?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    source: SOURCE,
  }).toString()}`;

  return {
    authorizeUrl,
    redirectUri,
    port,
    deadline: Date.now() + timeoutMs,
    result,
    submitRedirectUrl(input: string) {
      if (settled || claimed) {
        return;
      }
      let url: URL;
      try {
        url = new URL(input.trim());
      } catch {
        finish(
          new OAuthError("invalid_request", "paste the full URL the browser was redirected to"),
        );
        return;
      }
      if (url.searchParams.get("state") !== state) {
        finish(new OAuthError("state_mismatch", "that URL belongs to a different sign-in attempt"));
        return;
      }
      const err = url.searchParams.get("error");
      if (err) {
        finish(new OAuthError(err, url.searchParams.get("error_description") ?? undefined));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code || claimed) {
        return;
      }
      claimed = true;
      exchange(code).then(finish, finish);
    },
    cancel() {
      finish(new OAuthError("cancelled"));
    },
  };
};

/** Opens a URL without a shell; mirrors pi's unexported helper. */
export const openBrowser = (url: string): void => {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {
    // No opener available
  }
};

// ── Refresh / revoke ─────────────────────────────────────────────────

/** Always returns a rotated pair; persist it before using the access token. */
export const refreshTokens = async (
  tokenEndpoint: string,
  clientId: string,
  refreshToken: string,
  fetchImpl: Fetch = fetch,
): Promise<TokenResponse> => {
  const r = await postForm(
    tokenEndpoint,
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId },
    fetchImpl,
  );
  if (r.status !== 200) {
    fail(r);
  }
  return asToken(r.body);
};

export const revokeToken = async (
  revocationEndpoint: string,
  clientId: string,
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<void> => {
  await postForm(
    revocationEndpoint,
    { token, client_id: clientId, token_type_hint: "refresh_token" },
    fetchImpl,
  ).catch(() => {});
};

export const defaultTokenEndpoint = (host: string) => `${trimSlash(host)}/oauth/token`;
export const defaultRevocationEndpoint = (host: string) => `${trimSlash(host)}/oauth/revoke`;
