import { createHash } from "node:crypto";
import { normalizeBaseUrl } from "@honcho-ai/harness-plugin-core";
import {
  ensureHostBlock,
  getConfigPath,
  hostBlock,
  isObject,
  readConfig,
  readConfigStrict,
  updateConfig,
  withConfigLock,
} from "../config-file.js";
import type { JsonObject } from "../config-file.js";
import { readPiKey } from "../settings.js";
import {
  OAuthError,
  SCOPE,
  defaultRevocationEndpoint,
  defaultTokenEndpoint,
  discover,
  refreshTokens,
  revokeToken,
} from "./oauth.js";
import type { Fetch, TokenResponse } from "./oauth.js";

export type CredentialSource = "env" | "pi-key" | "oauth" | "shared-key";

/** Root `oauth`, in honcho-cli's shape so both tools share one grant. */
export interface StoredGrant {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds. */
  accessExpiresAt: number;
  clientId: string;
  scope: string;
  host: string;
}

export interface Credential {
  source: CredentialSource;
  token: string;
  grant?: StoredGrant;
}

/** Thrown when the OAuth grant is dead and no other credential exists. */
export class SignInExpiredError extends Error {
  constructor(cause?: unknown) {
    super("sign-in expired", { cause });
    this.name = "SignInExpiredError";
  }
}

type Env = Record<string, string | undefined>;

export const REFRESH_SKEW_S = 120;
const deadGrants = new Set<string>();
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

const interpolate = (value: string, env: Env): string =>
  value.replace(/\$\{([^}]+)\}/g, (match, name: string) => env[name] ?? match);

const sameHost = (a: string, b: string) => normalizeBaseUrl(a) === normalizeBaseUrl(b);

export const readGrant = (file: JsonObject, baseUrl: string): StoredGrant | undefined => {
  const raw = isObject(file.oauth)
    ? file.oauth
    : isObject(file.auth) && isObject(file.auth.oauth)
      ? file.auth.oauth
      : undefined;
  if (!raw) {
    return undefined;
  }
  const { accessToken, refreshToken, clientId, scope, host } = raw;
  const expiry = raw.accessExpiresAt ?? raw.expiresAt;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    return undefined;
  }
  const grantHost = typeof host === "string" ? host : "";
  if (grantHost && !sameHost(grantHost, baseUrl)) {
    return undefined;
  }
  const accessExpiresAt =
    typeof expiry === "number"
      ? expiry
      : typeof expiry === "string"
        ? Date.parse(expiry) / 1000 || 0
        : 0;
  return {
    accessToken,
    refreshToken,
    accessExpiresAt,
    clientId: typeof clientId === "string" ? clientId : "honcho-cli",
    scope: typeof scope === "string" ? scope : SCOPE,
    host: grantHost || normalizeBaseUrl(baseUrl),
  };
};

const sharedKey = (file: JsonObject): string | undefined => {
  if (typeof file.apiKey === "string" && file.apiKey.trim()) {
    return file.apiKey.trim();
  }
  if (isObject(file.auth) && typeof file.auth.apiKey === "string" && file.auth.apiKey.trim()) {
    return file.auth.apiKey.trim();
  }
  return undefined;
};

export const isGrantDead = (grant: StoredGrant) => deadGrants.has(hash(grant.refreshToken));

/** Precedence: `HONCHO_API_KEY` > `hosts.pi.apiKey` > root `oauth` > root `apiKey`. */
export const resolveCredential = (
  file: JsonObject,
  baseUrl: string,
  env: Env = process.env,
): Credential | null => {
  if (env.HONCHO_API_KEY) {
    return { source: "env", token: env.HONCHO_API_KEY };
  }
  const piKey = readPiKey(file);
  if (piKey) {
    return { source: "pi-key", token: interpolate(piKey, env) };
  }
  const grant = readGrant(file, baseUrl);
  const shared = sharedKey(file);
  if (grant && !(isGrantDead(grant) && shared)) {
    return { source: "oauth", token: grant.accessToken, grant };
  }
  if (shared) {
    return { source: "shared-key", token: interpolate(shared, env) };
  }
  if (grant) {
    return { source: "oauth", token: grant.accessToken, grant };
  }
  return null;
};

export const toGrant = (
  token: TokenResponse,
  clientId: string,
  host: string,
  previous?: StoredGrant,
): StoredGrant => ({
  accessToken: token.access_token,
  refreshToken: token.refresh_token ?? previous?.refreshToken ?? "",
  accessExpiresAt: Date.now() / 1000 + token.expires_in,
  clientId,
  scope: token.scope ?? SCOPE,
  host: normalizeBaseUrl(host),
});

export interface CredentialStoreOptions {
  path?: string;
  env?: Env;
  fetchImpl?: Fetch;
}

/** Reads, refreshes and persists credentials in the shared config file. */
export class CredentialStore {
  readonly path: string;
  private readonly env: Env;
  private readonly fetchImpl: Fetch;
  private inflight: Promise<Credential> | undefined;

  constructor(opts: CredentialStoreOptions = {}) {
    this.env = opts.env ?? process.env;
    this.path = opts.path ?? getConfigPath(this.env);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  resolve(baseUrl: string): Credential | null {
    return resolveCredential(readConfig(this.path), baseUrl, this.env);
  }

  /** Returns a credential whose token is valid for at least `REFRESH_SKEW_S`. */
  async fresh(
    baseUrl: string,
    opts: { force?: boolean; failedToken?: string } = {},
  ): Promise<Credential | null> {
    const current = this.resolve(baseUrl);
    if (!current || current.source !== "oauth" || !current.grant) {
      return current;
    }
    const due = current.grant.accessExpiresAt - Date.now() / 1000 < REFRESH_SKEW_S;
    if (!due && !opts.force) {
      return current;
    }
    // Another process may have rotated it since the failing request
    if (opts.failedToken && current.token !== opts.failedToken && !due) {
      return current;
    }
    this.inflight ??= this.refresh(baseUrl, opts.failedToken)
      .catch((error: unknown) => {
        // A dead grant yields to a key, which resolveCredential now prefers
        const fallback = error instanceof SignInExpiredError ? this.resolve(baseUrl) : null;
        if (fallback && fallback.source !== "oauth") {
          return fallback;
        }
        throw error;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  private async refresh(baseUrl: string, failedToken?: string): Promise<Credential> {
    return withConfigLock(async () => {
      const file = readConfigStrict(this.path);
      const grant = readGrant(file, baseUrl);
      if (!grant) {
        throw new SignInExpiredError();
      }
      if (isGrantDead(grant)) {
        throw new SignInExpiredError();
      }
      const stillFresh = grant.accessExpiresAt - Date.now() / 1000 >= REFRESH_SKEW_S;
      if (stillFresh && (!failedToken || grant.accessToken !== failedToken)) {
        return { source: "oauth", token: grant.accessToken, grant };
      }
      const as = await discover(grant.host, this.fetchImpl);
      const tokenEndpoint = as?.tokenEndpoint ?? defaultTokenEndpoint(grant.host);
      let token: TokenResponse;
      try {
        token = await refreshTokens(
          tokenEndpoint,
          grant.clientId,
          grant.refreshToken,
          this.fetchImpl,
        );
      } catch (error) {
        if (error instanceof OAuthError && error.permanent) {
          deadGrants.add(hash(grant.refreshToken));
          throw new SignInExpiredError(error);
        }
        throw error;
      }
      const next = toGrant(token, grant.clientId, grant.host, grant);
      let replaced = false;
      updateConfig((config) => {
        // Another tool signed in or out during the exchange; its write wins
        replaced = readGrant(config, baseUrl)?.refreshToken !== grant.refreshToken;
        if (!replaced) {
          config.oauth = { ...next };
        }
      }, this.path);
      if (replaced) {
        const current = this.resolve(baseUrl);
        if (!current) {
          throw new SignInExpiredError();
        }
        return current;
      }
      return { source: "oauth", token: next.accessToken, grant: next };
    }, this.path);
  }

  saveGrant(token: TokenResponse, clientId: string, host: string): StoredGrant {
    const grant = toGrant(token, clientId, host);
    updateConfig((config) => {
      config.oauth = { ...grant };
      const pi = hostBlock(config);
      // An OAuth sign-in replaces a pi-scoped key so the new grant takes effect
      if ("apiKey" in pi) {
        delete pi.apiKey;
      }
      if (isObject(pi.auth)) {
        delete pi.auth.apiKey;
      }
    }, this.path);
    return grant;
  }

  savePiKey(key: string): void {
    updateConfig((config) => {
      ensureHostBlock(config).apiKey = key;
    }, this.path);
  }

  rememberClient(clientId: string): void {
    updateConfig((config) => {
      ensureHostBlock(config).oauthClientId = clientId;
    }, this.path);
  }

  registeredClientId(): string | undefined {
    const id = hostBlock(readConfig(this.path)).oauthClientId;
    return typeof id === "string" ? id : undefined;
  }

  removePiKey(): void {
    updateConfig((config) => {
      const pi = hostBlock(config);
      delete pi.apiKey;
      if (isObject(pi.auth)) {
        delete pi.auth.apiKey;
      }
    }, this.path);
  }

  /** Revokes this host's grant server-side (best effort) and removes it from the file. */
  async removeGrant(baseUrl: string): Promise<void> {
    // Under the refresh lock so a concurrent rotation can't write the grant back
    await withConfigLock(() => this.revokeAndDelete(baseUrl), this.path);
  }

  private async revokeAndDelete(baseUrl: string): Promise<void> {
    const grant = readGrant(readConfigStrict(this.path), baseUrl);
    if (!grant) {
      return;
    }
    const as = await discover(grant.host, this.fetchImpl);
    await revokeToken(
      as?.revocationEndpoint ?? defaultRevocationEndpoint(grant.host),
      grant.clientId,
      grant.refreshToken,
      this.fetchImpl,
    );
    deadGrants.add(hash(grant.refreshToken));
    updateConfig((config) => {
      // A grant for another host belongs to whoever signed in there
      if (isObject(config.oauth) && readGrant({ oauth: config.oauth }, baseUrl)) {
        delete config.oauth;
      }
      if (
        isObject(config.auth) &&
        isObject(config.auth.oauth) &&
        readGrant({ auth: config.auth }, baseUrl)
      ) {
        delete config.auth.oauth;
      }
    }, this.path);
  }
}
