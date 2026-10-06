import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CredentialStore,
  REFRESH_SKEW_S,
  SignInExpiredError,
  isGrantDead,
  readGrant,
  resolveCredential,
  toGrant,
} from "../extensions/auth/credentials.js";
import type { StoredGrant } from "../extensions/auth/credentials.js";
import { OAuthError } from "../extensions/auth/oauth.js";
import type { Fetch } from "../extensions/auth/oauth.js";
import type { JsonObject } from "../extensions/config-file.js";

const HOST = "https://api.honcho.test";
const OTHER_HOST = "https://api.staging.honcho.test";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-honcho-cred-"));
  path = join(dir, ".honcho", "config.json");
  mkdirSync(join(dir, ".honcho"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const nowS = () => Date.now() / 1000;
// The dead-grant registry is process-wide, so every grant gets unique tokens
const uid = () => randomBytes(6).toString("hex");

const grant = (over: Partial<StoredGrant> = {}): StoredGrant => ({
  accessToken: `hch-at-${uid()}`,
  refreshToken: `hch-rt-${uid()}`,
  accessExpiresAt: nowS() + 3600,
  clientId: "honcho-cli",
  scope: "write",
  host: HOST,
  ...over,
});

const writeFile = (config: JsonObject) => writeFileSync(path, JSON.stringify(config, null, 2));
const readFile = (): JsonObject => JSON.parse(readFileSync(path, "utf8")) as JsonObject;
const asJson = (g: StoredGrant): JsonObject => ({ ...g });

const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

interface Call {
  url: string;
  method: string;
  form: Record<string, string>;
}

/** Fake authorization server: discovery, token and revoke endpoints. */
const fakeServer = (
  opts: {
    token?: (form: Record<string, string>) => Response | Promise<Response>;
    discovery?: boolean;
    onToken?: () => void;
  } = {},
) => {
  const calls: Call[] = [];
  let n = 0;
  const fetchImpl: Fetch = async (input, init) => {
    const url = urlOf(input);
    const form = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {};
    calls.push({ url, method: init?.method ?? "GET", form });
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      if (opts.discovery === false) {
        return new Response("not found", { status: 404 });
      }
      const base = url.replace("/.well-known/oauth-authorization-server", "");
      return Response.json({
        issuer: base,
        authorization_endpoint: `${base}/authorize-ui`,
        token_endpoint: `${base}/as/token`,
        revocation_endpoint: `${base}/as/revoke`,
        grant_types_supported: ["authorization_code", "refresh_token"],
      });
    }
    if (url.endsWith("/token")) {
      opts.onToken?.();
      if (opts.token) {
        return opts.token(form);
      }
      n += 1;
      return Response.json({
        access_token: `hch-at-new-${n}-${uid()}`,
        refresh_token: `hch-rt-new-${n}-${uid()}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "write",
      });
    }
    if (url.endsWith("/revoke")) {
      return Response.json({});
    }
    return new Response("unexpected", { status: 500 });
  };
  const tokenCalls = () => calls.filter((c) => c.url.endsWith("/token"));
  return { fetchImpl, calls, tokenCalls };
};

describe("readGrant", () => {
  it("reads root oauth in honcho-cli shape for the matching host", () => {
    const g = grant();
    expect(readGrant({ oauth: asJson(g) }, `${HOST}/`)).toEqual(g);
  });

  it("ignores a grant issued for another host", () => {
    expect(readGrant({ oauth: asJson(grant({ host: OTHER_HOST })) }, HOST)).toBeUndefined();
  });

  it("accepts a grant without a host and assigns the current one", () => {
    const { host: _host, ...rest } = grant();
    expect(readGrant({ oauth: rest }, HOST)?.host).toBe(HOST);
  });

  it("reads harness-core auth.oauth with an ISO expiresAt", () => {
    const g = readGrant(
      {
        auth: { oauth: { accessToken: "a", refreshToken: "r", expiresAt: "2030-01-01T00:00:00Z" } },
      },
      HOST,
    );
    expect(g).toEqual({
      accessToken: "a",
      refreshToken: "r",
      accessExpiresAt: Date.parse("2030-01-01T00:00:00Z") / 1000,
      clientId: "honcho-cli",
      scope: "write",
      host: HOST,
    });
  });

  it("rejects grants without both tokens", () => {
    expect(readGrant({ oauth: { accessToken: "a" } }, HOST)).toBeUndefined();
    expect(readGrant({ oauth: "x" }, HOST)).toBeUndefined();
  });
});

describe("resolveCredential", () => {
  const g = grant();
  const full: JsonObject = {
    apiKey: "root-key",
    oauth: asJson(g),
    hosts: { pi: { apiKey: "pi-key" } },
  };

  it("prefers HONCHO_API_KEY over everything", () => {
    expect(resolveCredential(full, HOST, { HONCHO_API_KEY: "env-key" })).toEqual({
      source: "env",
      token: "env-key",
    });
  });

  it("then hosts.pi.apiKey, then hosts.pi.auth.apiKey", () => {
    expect(resolveCredential(full, HOST, {})).toEqual({ source: "pi-key", token: "pi-key" });
    const nested: JsonObject = { ...full, hosts: { pi: { auth: { apiKey: "nested-key" } } } };
    expect(resolveCredential(nested, HOST, {})).toEqual({ source: "pi-key", token: "nested-key" });
  });

  it("then a root oauth grant for this host over the root apiKey", () => {
    const file: JsonObject = { apiKey: "root-key", oauth: asJson(g) };
    expect(resolveCredential(file, HOST, {})).toEqual({
      source: "oauth",
      token: g.accessToken,
      grant: g,
    });
  });

  it("ignores a grant for another host and uses the root apiKey", () => {
    const file: JsonObject = { apiKey: "root-key", oauth: asJson(grant({ host: OTHER_HOST })) };
    expect(resolveCredential(file, HOST, {})).toEqual({ source: "shared-key", token: "root-key" });
    expect(resolveCredential({ oauth: asJson(grant({ host: OTHER_HOST })) }, HOST, {})).toBeNull();
  });

  it("reads a v1 root auth.apiKey as the shared key", () => {
    expect(resolveCredential({ auth: { apiKey: " v1-key " } }, HOST, {})).toEqual({
      source: "shared-key",
      token: "v1-key",
    });
  });

  it("interpolates ${VAR} in file keys", () => {
    const env = { MY_HONCHO_KEY: "from-env" };
    expect(
      resolveCredential({ hosts: { pi: { apiKey: "${MY_HONCHO_KEY}" } } }, HOST, env)?.token,
    ).toBe("from-env");
    expect(resolveCredential({ apiKey: "pre-${MY_HONCHO_KEY}" }, HOST, env)?.token).toBe(
      "pre-from-env",
    );
    expect(resolveCredential({ apiKey: "${UNSET_VAR}" }, HOST, env)?.token).toBe("${UNSET_VAR}");
  });

  it("returns null with nothing configured", () => {
    expect(resolveCredential({}, HOST, {})).toBeNull();
    expect(resolveCredential({ apiKey: "  " }, HOST, { HONCHO_API_KEY: "" })).toBeNull();
  });

  it("falls back to the shared key once the grant is dead, and keeps a dead grant when nothing else exists", async () => {
    const dead = grant();
    writeFile({ oauth: asJson(dead) });
    const { fetchImpl } = fakeServer();
    await new CredentialStore({ path, env: {}, fetchImpl }).removeGrant(HOST);
    expect(isGrantDead(dead)).toBe(true);
    expect(resolveCredential({ apiKey: "root-key", oauth: asJson(dead) }, HOST, {})).toEqual({
      source: "shared-key",
      token: "root-key",
    });
    expect(resolveCredential({ oauth: asJson(dead) }, HOST, {})?.source).toBe("oauth");
  });
});

describe("toGrant", () => {
  it("keeps the previous refresh token when the response omits one", () => {
    const prev = grant();
    const next = toGrant(
      { access_token: "a", token_type: "Bearer", expires_in: 60 },
      "c",
      `${HOST}/`,
      prev,
    );
    expect(next.refreshToken).toBe(prev.refreshToken);
    expect(next.host).toBe(HOST);
    expect(next.scope).toBe("write");
    expect(next.accessExpiresAt).toBeGreaterThan(nowS() + 59);
    expect(next.accessExpiresAt).toBeLessThan(nowS() + 61);
  });
});

describe("CredentialStore.fresh", () => {
  it("returns non-OAuth credentials untouched", async () => {
    writeFile({ apiKey: "root-key" });
    const { fetchImpl, calls } = fakeServer();
    const store = new CredentialStore({ path, env: {}, fetchImpl });
    expect(await store.fresh(HOST)).toEqual({ source: "shared-key", token: "root-key" });
    expect(
      await new CredentialStore({ path, env: { HONCHO_API_KEY: "e" }, fetchImpl }).fresh(HOST, {
        force: true,
      }),
    ).toEqual({ source: "env", token: "e" });
    expect(calls).toEqual([]);
  });

  it("does not refresh a token with more than the skew left", async () => {
    const g = grant({ accessExpiresAt: nowS() + REFRESH_SKEW_S + 5 });
    writeFile({ oauth: asJson(g) });
    const { fetchImpl, calls } = fakeServer();
    const cred = await new CredentialStore({ path, env: {}, fetchImpl }).fresh(HOST);
    expect(cred?.token).toBe(g.accessToken);
    expect(calls).toEqual([]);
  });

  it("refreshes within the skew and persists the rotated pair before returning", async () => {
    const g = grant({ accessExpiresAt: nowS() + 100, clientId: "honcho-pi" });
    writeFile({
      apiKey: "keep-me",
      peerName: "aakash",
      oauth: asJson(g),
      hosts: { claude_code: { x: 1 } },
    });
    const { fetchImpl, calls, tokenCalls } = fakeServer();
    const cred = await new CredentialStore({ path, env: {}, fetchImpl }).fresh(HOST);

    expect(calls[0]?.url).toBe(`${HOST}/.well-known/oauth-authorization-server`);
    expect(tokenCalls()).toHaveLength(1);
    expect(tokenCalls()[0]).toMatchObject({
      url: `${HOST}/as/token`,
      method: "POST",
      form: { grant_type: "refresh_token", refresh_token: g.refreshToken, client_id: "honcho-pi" },
    });
    const onDisk = readFile();
    const stored = onDisk.oauth as JsonObject;
    expect(cred?.source).toBe("oauth");
    expect(cred?.token).toBe(stored.accessToken);
    expect(cred?.grant).toEqual(stored);
    expect(stored.refreshToken).not.toBe(g.refreshToken);
    expect(Object.keys(stored).sort()).toEqual([
      "accessExpiresAt",
      "accessToken",
      "clientId",
      "host",
      "refreshToken",
      "scope",
    ]);
    expect(stored.clientId).toBe("honcho-pi");
    expect(stored.accessExpiresAt as number).toBeGreaterThan(nowS() + 3500);
    expect(onDisk.apiKey).toBe("keep-me");
    expect(onDisk.peerName).toBe("aakash");
    expect(onDisk.hosts).toEqual({ claude_code: { x: 1 } });
  });

  it("uses the default token endpoint when discovery fails", async () => {
    writeFile({ oauth: asJson(grant({ accessExpiresAt: nowS() - 10 })) });
    const { fetchImpl, tokenCalls } = fakeServer({ discovery: false });
    await new CredentialStore({ path, env: {}, fetchImpl }).fresh(HOST);
    expect(tokenCalls()[0]?.url).toBe(`${HOST}/oauth/token`);
  });

  it("does not hand out the new token when it cannot be persisted", async () => {
    const g = grant({ accessExpiresAt: nowS() - 10 });
    writeFile({ oauth: asJson(g) });
    const { fetchImpl } = fakeServer({ onToken: () => writeFileSync(path, "{corrupted") });
    await expect(new CredentialStore({ path, env: {}, fetchImpl }).fresh(HOST)).rejects.toThrow(
      /not valid JSON/,
    );
    expect(readFileSync(path, "utf8")).toBe("{corrupted");
  });

  it("adopts a grant another process rotated after our request failed, without a network call", async () => {
    const mine = grant();
    const theirs = grant();
    writeFile({ oauth: asJson(theirs) });
    const { fetchImpl, calls } = fakeServer();
    const cred = await new CredentialStore({ path, env: {}, fetchImpl }).fresh(HOST, {
      force: true,
      failedToken: mine.accessToken,
    });
    expect(cred?.token).toBe(theirs.accessToken);
    expect(calls).toEqual([]);
  });

  it("adopts a newer grant written while it waited for the lock", async () => {
    const stale = grant({ accessExpiresAt: nowS() + 30 });
    writeFile({ oauth: asJson(stale) });
    const lock = join(dir, ".honcho", ".pi-honcho.lock");
    mkdirSync(lock);
    const { fetchImpl, tokenCalls } = fakeServer();
    const pending = new CredentialStore({ path, env: {}, fetchImpl }).fresh(HOST);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const rotated = grant();
    writeFile({ oauth: asJson(rotated) });
    rmSync(lock, { recursive: true });
    const cred = await pending;
    expect(cred?.token).toBe(rotated.accessToken);
    expect(tokenCalls()).toHaveLength(0);
    expect((readFile().oauth as JsonObject).refreshToken).toBe(rotated.refreshToken);
  });

  it("force-refreshes a still-valid token after a 401 with that token", async () => {
    const g = grant();
    writeFile({ oauth: asJson(g) });
    const { fetchImpl, tokenCalls } = fakeServer();
    const cred = await new CredentialStore({ path, env: {}, fetchImpl }).fresh(HOST, {
      force: true,
      failedToken: g.accessToken,
    });
    expect(tokenCalls()).toHaveLength(1);
    expect(tokenCalls()[0]?.form.refresh_token).toBe(g.refreshToken);
    expect(cred?.token).not.toBe(g.accessToken);
    expect((readFile().oauth as JsonObject).accessToken).toBe(cred?.token);
  });

  it("turns invalid_grant into SignInExpiredError and stops retrying that grant", async () => {
    const g = grant({ accessExpiresAt: nowS() - 5 });
    writeFile({ oauth: asJson(g) });
    const before = readFileSync(path, "utf8");
    const { fetchImpl, tokenCalls } = fakeServer({
      token: () =>
        Response.json(
          { error: "invalid_grant", error_description: "Refresh token revoked" },
          { status: 400 },
        ),
    });
    const store = new CredentialStore({ path, env: {}, fetchImpl });
    const error = await store.fresh(HOST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignInExpiredError);
    expect((error as SignInExpiredError).cause).toBeInstanceOf(OAuthError);
    expect(((error as SignInExpiredError).cause as OAuthError).code).toBe("invalid_grant");
    expect(isGrantDead(g)).toBe(true);
    // The block stays, as honcho-cli keeps it
    expect(readFileSync(path, "utf8")).toBe(before);

    await expect(store.fresh(HOST)).rejects.toBeInstanceOf(SignInExpiredError);
    expect(tokenCalls()).toHaveLength(1);
  });

  it("treats invalid_client and unauthorized_client as permanent too", async () => {
    for (const code of ["invalid_client", "unauthorized_client"]) {
      writeFile({ oauth: asJson(grant({ accessExpiresAt: 0 })) });
      const { fetchImpl } = fakeServer({
        token: () => Response.json({ error: code }, { status: 401 }),
      });
      await expect(
        new CredentialStore({ path, env: {}, fetchImpl }).fresh(HOST),
      ).rejects.toBeInstanceOf(SignInExpiredError);
    }
  });

  it("switches to the shared key once the grant is dead", async () => {
    const g = grant({ accessExpiresAt: nowS() - 5 });
    writeFile({ apiKey: "root-key", oauth: asJson(g) });
    const { fetchImpl } = fakeServer({
      token: () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    });
    const store = new CredentialStore({ path, env: {}, fetchImpl });
    expect(await store.fresh(HOST)).toEqual({ source: "shared-key", token: "root-key" });
    expect(isGrantDead(g)).toBe(true);
    expect(await store.fresh(HOST)).toEqual({ source: "shared-key", token: "root-key" });
  });

  it("still throws SignInExpiredError for a dead grant with no key to fall back to", async () => {
    const g = grant({ accessExpiresAt: nowS() - 5, refreshToken: "hch-rt-dead-alone" });
    writeFile({ oauth: asJson(g) });
    const { fetchImpl } = fakeServer({
      token: () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    });
    const store = new CredentialStore({ path, env: {}, fetchImpl });
    await expect(store.fresh(HOST)).rejects.toBeInstanceOf(SignInExpiredError);
  });

  it("propagates a transient connection error and leaves the file unchanged", async () => {
    const g = grant({ accessExpiresAt: nowS() - 5 });
    writeFile({ oauth: asJson(g) });
    const before = readFileSync(path, "utf8");
    const { fetchImpl } = fakeServer({
      token: () => {
        throw new TypeError("fetch failed");
      },
    });
    const store = new CredentialStore({ path, env: {}, fetchImpl });
    const error = await store.fresh(HOST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).code).toBe("connection_error");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(isGrantDead(g)).toBe(false);
  });

  it("treats a 5xx from the token endpoint as transient", async () => {
    const g = grant({ accessExpiresAt: nowS() - 5 });
    writeFile({ oauth: asJson(g) });
    const { fetchImpl } = fakeServer({ token: () => new Response("bad gateway", { status: 502 }) });
    const error = await new CredentialStore({ path, env: {}, fetchImpl })
      .fresh(HOST)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).permanent).toBe(false);
    expect(isGrantDead(g)).toBe(false);
  });

  it("shares one refresh between concurrent callers on one store", async () => {
    writeFile({ oauth: asJson(grant({ accessExpiresAt: nowS() - 5 })) });
    const { fetchImpl, tokenCalls } = fakeServer();
    const store = new CredentialStore({ path, env: {}, fetchImpl });
    const results = await Promise.all([
      store.fresh(HOST),
      store.fresh(HOST),
      store.fresh(HOST, { force: true }),
    ]);
    expect(tokenCalls()).toHaveLength(1);
    expect(new Set(results.map((r) => r?.token)).size).toBe(1);
  });

  it("refreshes once across two stores in one process (two pi sessions)", async () => {
    writeFile({ oauth: asJson(grant({ accessExpiresAt: nowS() - 5 })) });
    const { fetchImpl, tokenCalls } = fakeServer();
    const a = new CredentialStore({ path, env: {}, fetchImpl });
    const b = new CredentialStore({ path, env: {}, fetchImpl });
    const [ra, rb] = await Promise.all([a.fresh(HOST), b.fresh(HOST)]);
    expect(tokenCalls()).toHaveLength(1);
    expect(ra?.token).toBe(rb?.token);
  });

  it("starts a new refresh after the previous one settled", async () => {
    writeFile({ oauth: asJson(grant({ accessExpiresAt: nowS() - 5 })) });
    const { fetchImpl, tokenCalls } = fakeServer({
      token: (() => {
        let first = true;
        return () => {
          if (first) {
            first = false;
            return Response.json({
              access_token: "short",
              refresh_token: `rt-${uid()}`,
              expires_in: 10,
            });
          }
          return Response.json({
            access_token: "long",
            refresh_token: `rt-${uid()}`,
            expires_in: 3600,
          });
        };
      })(),
    });
    const store = new CredentialStore({ path, env: {}, fetchImpl });
    expect((await store.fresh(HOST))?.token).toBe("short");
    // 10s of life is inside the skew, so the next call refreshes again
    expect((await store.fresh(HOST))?.token).toBe("long");
    expect(tokenCalls()).toHaveLength(2);
  });
});

describe("CredentialStore writes", () => {
  it("saveGrant writes root oauth in honcho-cli shape and drops the pi key", () => {
    writeFile({
      apiKey: "root-key",
      hosts: { pi: { apiKey: "pi-key", auth: { apiKey: "nested", other: 1 }, workspace: "w" } },
    });
    const store = new CredentialStore({ path, env: {} });
    const saved = store.saveGrant(
      {
        access_token: "hch-at-1",
        refresh_token: "hch-rt-1",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "write",
      },
      "honcho-pi",
      `${HOST}/`,
    );
    const onDisk = readFile();
    expect(onDisk.oauth).toEqual(saved);
    expect(saved).toEqual({
      accessToken: "hch-at-1",
      refreshToken: "hch-rt-1",
      accessExpiresAt: expect.any(Number) as number,
      clientId: "honcho-pi",
      scope: "write",
      host: HOST,
    });
    expect(saved.accessExpiresAt).toBeGreaterThan(nowS() + 3590);
    expect(saved.accessExpiresAt).toBeLessThan(nowS() + 3610);
    expect(onDisk.apiKey).toBe("root-key");
    expect(onDisk.hosts).toEqual({ pi: { auth: { other: 1 }, workspace: "w" } });
    expect(store.resolve(HOST)).toEqual({ source: "oauth", token: "hch-at-1", grant: saved });
  });

  it("savePiKey and removePiKey touch only hosts.pi", () => {
    writeFile({
      apiKey: "root-key",
      oauth: asJson(grant()),
      hosts: { claude_code: { apiKey: "cc" } },
    });
    const store = new CredentialStore({ path, env: {} });
    store.savePiKey("pi-key");
    expect(readFile().hosts).toEqual({ claude_code: { apiKey: "cc" }, pi: { apiKey: "pi-key" } });
    expect(store.resolve(HOST)).toEqual({ source: "pi-key", token: "pi-key" });

    writeFile({
      ...readFile(),
      hosts: {
        claude_code: { apiKey: "cc" },
        pi: { apiKey: "pi-key", auth: { apiKey: "nested" }, workspace: "w" },
      },
    });
    store.removePiKey();
    const onDisk = readFile();
    expect(onDisk.hosts).toEqual({
      claude_code: { apiKey: "cc" },
      pi: { auth: {}, workspace: "w" },
    });
    expect(onDisk.apiKey).toBe("root-key");
    expect(store.resolve(HOST)?.source).toBe("oauth");
  });

  it("removePiKey on a file without hosts.pi changes nothing", () => {
    writeFile({ apiKey: "root-key" });
    new CredentialStore({ path, env: {} }).removePiKey();
    expect(readFile()).toEqual({ apiKey: "root-key" });
  });

  it("remembers a registered client id in hosts.pi", () => {
    writeFile({});
    const store = new CredentialStore({ path, env: {} });
    expect(store.registeredClientId()).toBeUndefined();
    store.rememberClient("dyn-123");
    expect(store.registeredClientId()).toBe("dyn-123");
    expect(readFile()).toEqual({ hosts: { pi: { oauthClientId: "dyn-123" } } });
  });

  it("removeGrant revokes with the refresh token, then deletes root oauth and keeps the root apiKey", async () => {
    const g = grant({ clientId: "honcho-pi" });
    writeFile({ apiKey: "root-key", oauth: asJson(g), hosts: { pi: { workspace: "w" } } });
    const { fetchImpl, calls } = fakeServer();
    const store = new CredentialStore({ path, env: {}, fetchImpl });
    await store.removeGrant(HOST);
    const revoke = calls.find((c) => c.url.endsWith("/revoke"));
    expect(revoke).toEqual({
      url: `${HOST}/as/revoke`,
      method: "POST",
      form: { token: g.refreshToken, client_id: "honcho-pi", token_type_hint: "refresh_token" },
    });
    expect(readFile()).toEqual({ apiKey: "root-key", hosts: { pi: { workspace: "w" } } });
    expect(isGrantDead(g)).toBe(true);
    expect(store.resolve(HOST)).toEqual({ source: "shared-key", token: "root-key" });
  });

  it("removeGrant falls back to the default revocation endpoint and survives a revoke failure", async () => {
    const g = grant();
    writeFile({ oauth: asJson(g) });
    const calls: string[] = [];
    const fetchImpl: Fetch = async (input) => {
      calls.push(urlOf(input));
      if (urlOf(input).endsWith("/oauth/revoke")) {
        throw new TypeError("fetch failed");
      }
      return new Response("no", { status: 404 });
    };
    await new CredentialStore({ path, env: {}, fetchImpl }).removeGrant(HOST);
    expect(calls).toEqual([
      `${HOST}/.well-known/oauth-authorization-server`,
      `${HOST}/oauth/revoke`,
    ]);
    expect(readFile()).toEqual({});
  });

  it("removeGrant leaves a grant that belongs to another host alone", async () => {
    const theirs = grant({ host: OTHER_HOST });
    writeFile({ oauth: asJson(theirs) });
    const { fetchImpl, calls } = fakeServer();
    await new CredentialStore({ path, env: {}, fetchImpl }).removeGrant(HOST);
    expect(calls).toEqual([]);
    expect(readFile()).toEqual({ oauth: asJson(theirs) });
    expect(isGrantDead(theirs)).toBe(false);
  });

  it("removeGrant also clears a harness-core auth.oauth grant", async () => {
    writeFile({
      auth: {
        apiKey: "v1-key",
        oauth: { accessToken: "a", refreshToken: `r-${uid()}`, expiresAt: "2030-01-01T00:00:00Z" },
      },
    });
    const { fetchImpl } = fakeServer();
    const store = new CredentialStore({ path, env: {}, fetchImpl });
    await store.removeGrant(HOST);
    expect(readFile()).toEqual({ auth: { apiKey: "v1-key" } });
    expect(store.resolve(HOST)).toEqual({ source: "shared-key", token: "v1-key" });
  });
});
