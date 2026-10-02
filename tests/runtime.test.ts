import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AuthenticationError, ServerError } from "@honcho-ai/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CredentialStore,
  SignInExpiredError,
  isGrantDead,
} from "../extensions/auth/credentials.js";
import type { StoredGrant } from "../extensions/auth/credentials.js";
import type { Fetch } from "../extensions/auth/oauth.js";
import { setEnabled } from "../extensions/commands.js";
import type { JsonObject } from "../extensions/config-file.js";
import { tokenOf } from "../extensions/honcho.js";
import { HonchoRuntime } from "../extensions/runtime.js";
import { MockHoncho } from "./integration/mock-honcho.js";

const TIMEOUT = 5_000;
const API_KEY = "hch-pi-key";
const SHARED_KEY = "hch-shared-key";
const OFF = "Honcho is off for pi. Run /honcho on to turn it back on.";
const SIGNED_OUT = "Not signed in to Honcho. Run /honcho login.";

const mock = new MockHoncho();
const savedEnv = { ...process.env };
// Captured before any test fakes timers, so waits can still let sockets make progress
const realSetTimeout = globalThis.setTimeout;
let root = "";
let configPath = "";
const runtimes: HonchoRuntime[] = [];

beforeAll(async () => {
  await mock.start();
  root = mkdtempSync(join(tmpdir(), "pi-honcho-runtime-"));
  configPath = join(root, ".honcho", "config.json");
  mkdirSync(join(root, ".honcho"), { recursive: true });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("HONCHO_") || key.startsWith("PI_")) {
      delete process.env[key];
    }
  }
  process.env.HOME = root;
  process.env.HONCHO_CONFIG_PATH = configPath;
  process.env.HONCHO_BASE_URL = mock.baseUrl;
});

afterAll(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  await mock.stop();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  mock.reset();
});

const nap = (ms: number) =>
  new Promise<void>((resolve) => {
    realSetTimeout(resolve, ms);
  });

/** Waits until the mock has answered everything and no new requests arrive. */
const quiesce = async (): Promise<void> => {
  let seen = -1;
  for (let i = 0; i < 80; i += 1) {
    const count = mock.requests.length;
    if (count === seen && mock.requests.every((r) => r.status !== 0)) {
      return;
    }
    seen = count;
    await nap(25);
  }
};

afterEach(async () => {
  vi.useRealTimers();
  for (const runtime of runtimes.splice(0)) {
    runtime.dispose();
  }
  // Startup memory and counts load in the background; keep them out of the next test's log
  await quiesce();
});

// The dead-grant registry is process-wide, so every grant gets unique tokens
const uid = () => randomBytes(6).toString("hex");
const nowS = () => Date.now() / 1000;

const makeGrant = (over: Partial<StoredGrant> = {}): StoredGrant => ({
  accessToken: `hch-at-${uid()}`,
  refreshToken: `hch-rt-${uid()}`,
  accessExpiresAt: nowS() + 3600,
  clientId: "honcho-cli",
  scope: "write",
  host: mock.baseUrl,
  ...over,
});

const writeConfig = (config: JsonObject) => {
  writeFileSync(configPath, JSON.stringify(config, null, 2));
};

const readConfig = (): JsonObject => JSON.parse(readFileSync(configPath, "utf8")) as JsonObject;

/** A pi-scoped API key; `pi` merges into `hosts.pi`. */
const keyConfig = (pi: JsonObject = {}): JsonObject => ({
  peerName: "user",
  hosts: { pi: { apiKey: API_KEY, workspace: "ws1", aiPeer: "ai", ...pi } },
});

/** A root OAuth grant in honcho-cli's shape and no pi key. */
const oauthConfig = (grant: StoredGrant, extra: JsonObject = {}): JsonObject => ({
  peerName: "user",
  ...extra,
  oauth: { ...grant },
  hosts: { pi: { workspace: "ws1", aiPeer: "ai" } },
});

const signedOutConfig = (): JsonObject => ({
  peerName: "user",
  hosts: { pi: { workspace: "ws1", aiPeer: "ai" } },
});

const tokenResponse = (access: string, refresh: string) =>
  Response.json({
    access_token: access,
    refresh_token: refresh,
    token_type: "Bearer",
    expires_in: 3600,
    scope: "write",
  });

const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/** Fake authorization server: no discovery document, so the default token and revoke endpoints. */
const authServer = (onToken: () => Response | Promise<Response>) => {
  const tokenCalls: Record<string, string>[] = [];
  const revokeCalls: Record<string, string>[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = urlOf(input);
    const form = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {};
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return new Response("not found", { status: 404 });
    }
    if (url.endsWith("/oauth/token")) {
      tokenCalls.push(form);
      return onToken();
    }
    if (url.endsWith("/oauth/revoke")) {
      revokeCalls.push(form);
      return Response.json({});
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetchImpl, tokenCalls, revokeCalls };
};

const deferred = <T>() => {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: T) => settle(value) };
};

const fakePi = () => {
  let active = ["read", "honcho_chat", "honcho_search"];
  const api = {
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names];
    },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
    appendEntry: () => {},
  };
  return {
    api: api as unknown as ExtensionAPI,
    honchoTools: () => active.filter((name) => name.startsWith("honcho_")),
  };
};

const fakeCtx = () =>
  ({
    cwd: join(root, "proj"),
    mode: "print",
    hasUI: false,
    model: { id: "faux-1" },
    sessionManager: { getSessionId: () => "s1" },
    ui: { setStatus: () => {}, notify: () => {}, theme: {} },
  }) as unknown as ExtensionContext;

/** A runtime on a fake pi; `fetchImpl` backs its credential store's OAuth calls. */
const makeRuntime = (fetchImpl?: Fetch) => {
  const pi = fakePi();
  const runtime = new HonchoRuntime(pi.api);
  if (fetchImpl) {
    Object.assign(runtime, { store: new CredentialStore({ path: configPath, fetchImpl }) });
  }
  runtimes.push(runtime);
  return { runtime, pi };
};

/** Starts the runtime as session_start does and returns its connect attempt. */
const start = (runtime: HonchoRuntime) => {
  runtime.start(fakeCtx());
  return runtime.connect();
};

const reconnectTimer = (runtime: HonchoRuntime): unknown =>
  (runtime as unknown as { reconnectTimer?: unknown }).reconnectTimer;

const authHeaders = (route: Parameters<MockHoncho["calls"]>[0]) =>
  mock.calls(route).map((r) => r.headers.authorization);

/** Steps fake time forward while real sockets make progress, until `check` passes. */
const advanceUntil = async (check: () => void, maxFakeMs = 5_000): Promise<void> => {
  for (let elapsed = 0; ; elapsed += 50) {
    try {
      check();
      return;
    } catch (error) {
      if (elapsed >= maxFakeMs) {
        throw error;
      }
    }
    await vi.advanceTimersByTimeAsync(50);
    await nap(3);
  }
};

describe("connect with an OAuth grant", () => {
  it(
    "refreshes a token rejected at connect and retries on fresh clients",
    { timeout: TIMEOUT },
    async () => {
      const old = makeGrant();
      const next = { access: `hch-at-${uid()}`, refresh: `hch-rt-${uid()}` };
      writeConfig(oauthConfig(old));
      // The access token was superseded server-side, e.g. honcho-cli refreshed it
      mock.fail("workspace", { status: 401, detail: "Invalid or expired access token", times: 1 });
      const auth = authServer(() => tokenResponse(next.access, next.refresh));
      const { runtime } = makeRuntime(auth.fetchImpl);

      const connection = await start(runtime);

      expect(runtime.phase).toBe("connected");
      // The SDK memoizes the rejected workspace call, so only fresh clients reach the network again
      expect(authHeaders("workspace")).toEqual([
        `Bearer ${old.accessToken}`,
        `Bearer ${next.access}`,
      ]);
      expect(authHeaders("session")).toEqual([`Bearer ${next.access}`]);
      expect(auth.tokenCalls).toEqual([
        expect.objectContaining({ grant_type: "refresh_token", refresh_token: old.refreshToken }),
      ]);
      expect(readConfig().oauth).toMatchObject({
        accessToken: next.access,
        refreshToken: next.refresh,
      });
      expect(runtime.credential?.token).toBe(next.access);
      expect(connection?.credential.token).toBe(next.access);
      expect(connection && tokenOf(connection.clients)).toBe(next.access);
    },
  );

  it(
    "falls back to the root API key when the grant is dead at startup",
    { timeout: TIMEOUT },
    async () => {
      const dead = makeGrant({ accessExpiresAt: nowS() - 10 });
      writeConfig(oauthConfig(dead, { apiKey: SHARED_KEY }));
      const auth = authServer(() =>
        Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 }),
      );
      const { runtime } = makeRuntime(auth.fetchImpl);

      const connection = await start(runtime);

      expect(connection).toBeDefined();
      expect(runtime.phase).toBe("connected");
      expect(runtime.credential).toEqual({ source: "shared-key", token: SHARED_KEY });
      expect(isGrantDead(dead)).toBe(true);
      expect(auth.tokenCalls).toHaveLength(1);

      // Later calls keep using the key without retrying the dead grant
      await runtime.call((c) => c.userPeer.getCard());
      expect(auth.tokenCalls).toHaveLength(1);
      expect(new Set(mock.requests.map((r) => r.headers.authorization))).toEqual(
        new Set([`Bearer ${SHARED_KEY}`]),
      );
    },
  );
});

describe("restart while work is in flight", () => {
  it("/honcho off during a slow connect leaves the runtime off", { timeout: TIMEOUT }, async () => {
    writeConfig(keyConfig());
    mock.fail("workspace", { delayMs: 300, times: 1 });
    const { runtime, pi } = makeRuntime();
    const first = start(runtime);
    await mock.waitFor((log) => log.some((r) => r.route === "workspace"));

    setEnabled(false, configPath);
    await runtime.restart();
    expect(runtime.phase).toBe("off");

    // The stale attempt finishes on the network but installs nothing
    expect(await first).toBeUndefined();
    expect(mock.calls("session")).toHaveLength(1);
    expect(runtime.phase).toBe("off");
    expect(runtime.connection).toBeUndefined();
    expect(runtime.footer.current).toEqual({ kind: "off" });
    expect(pi.honchoTools()).toEqual([]);
  });

  it(
    "a workspace change during a slow connect ends on the new workspace",
    { timeout: TIMEOUT },
    async () => {
      writeConfig(keyConfig());
      mock.fail("workspace", { delayMs: 300, times: 1 });
      const { runtime } = makeRuntime();
      const first = start(runtime);
      await mock.waitFor((log) => log.some((r) => r.route === "workspace"));

      writeConfig(keyConfig({ workspace: "ws2" }));
      await runtime.refreshSettings();
      expect(runtime.phase).toBe("connected");
      expect(runtime.connection?.session.workspaceId).toBe("ws2");

      expect(await first).toBeUndefined();
      expect(mock.calls("workspace").map((r) => (r.body as { id?: string }).id)).toEqual([
        "ws1",
        "ws2",
      ]);
      expect(runtime.connection?.session.workspaceId).toBe("ws2");
      expect(runtime.footer.current).toMatchObject({ kind: "connected", workspace: "ws2" });
    },
  );

  it("a stale connect failure leaves the runtime off", { timeout: TIMEOUT }, async () => {
    writeConfig(keyConfig());
    mock.fail("workspace", { status: 500, delayMs: 150, times: 2 });
    const { runtime } = makeRuntime();
    const first = start(runtime);
    await mock.waitFor((log) => log.some((r) => r.route === "workspace"));

    setEnabled(false, configPath);
    await runtime.restart();

    expect(await first).toBeUndefined();
    expect(mock.calls("workspace")).toHaveLength(2);
    expect(runtime.phase).toBe("off");
    expect(runtime.lastError).toBeUndefined();
    expect(reconnectTimer(runtime)).toBeUndefined();
  });

  it("a stale call() failure cannot turn off into unreachable", { timeout: TIMEOUT }, async () => {
    writeConfig(keyConfig());
    const { runtime, pi } = makeRuntime();
    await start(runtime);
    await runtime.startupReady(2_000);
    const cards = mock.calls("card").length;
    mock.fail("card", { status: 503, delayMs: 100, times: 2 });
    const call = runtime.call((c) => c.userPeer.getCard()).catch((error: unknown) => error);
    await mock.waitFor((log) => log.filter((r) => r.route === "card").length > cards);

    setEnabled(false, configPath);
    await runtime.restart();

    expect(await call).toBeInstanceOf(ServerError);
    expect(runtime.phase).toBe("off");
    expect(reconnectTimer(runtime)).toBeUndefined();
    expect(pi.honchoTools()).toEqual([]);
  });

  it(
    "a stale call() success cannot turn off back into connected",
    { timeout: TIMEOUT },
    async () => {
      writeConfig(keyConfig());
      mock.data.peerCard = ["Name: Ada"];
      const { runtime } = makeRuntime();
      await start(runtime);
      await runtime.startupReady(2_000);
      const cards = mock.calls("card").length;
      mock.fail("card", { delayMs: 150, times: 1 });
      const call = runtime.call((c) => c.userPeer.getCard());
      await mock.waitFor((log) => log.filter((r) => r.route === "card").length > cards);

      setEnabled(false, configPath);
      await runtime.restart();

      expect(await call).toEqual(["Name: Ada"]);
      expect(runtime.phase).toBe("off");
      expect(runtime.connection).toBeUndefined();
    },
  );

  it(
    "connect() and call() stay off the network when off or signed out",
    { timeout: TIMEOUT },
    async () => {
      writeConfig(keyConfig({ enabled: false }));
      const off = makeRuntime().runtime;
      expect(await start(off)).toBeUndefined();
      expect(off.phase).toBe("off");
      expect(await off.connect()).toBeUndefined();
      await expect(off.call((c) => c.userPeer.getCard())).rejects.toThrow(OFF);

      writeConfig(signedOutConfig());
      const signedOut = makeRuntime().runtime;
      expect(await start(signedOut)).toBeUndefined();
      expect(signedOut.phase).toBe("signed-out");
      expect(await signedOut.connect()).toBeUndefined();
      await expect(signedOut.call((c) => c.userPeer.getCard())).rejects.toThrow(SIGNED_OUT);

      expect(mock.requests).toEqual([]);
    },
  );

  it(
    "reconnects when a sign-in lands while the phase is still signed-out",
    { timeout: TIMEOUT },
    async () => {
      writeConfig(signedOutConfig());
      const { runtime } = makeRuntime();
      expect(await start(runtime)).toBeUndefined();
      expect(runtime.phase).toBe("signed-out");

      writeConfig(oauthConfig(makeGrant()));
      const connection = await runtime.restart();

      expect(connection?.sessionName).toBeTruthy();
      expect(runtime.phase).toBe("connected");
      expect(runtime.credential?.source).toBe("oauth");
    },
  );
});

describe("transient connect failures", () => {
  it(
    "a 500 at connect is unreachable with a reconnect scheduled, not an error",
    { timeout: TIMEOUT },
    async () => {
      writeConfig(keyConfig());
      mock.fail("workspace", { status: 500, detail: "database is restarting", times: 2 });
      const { runtime, pi } = makeRuntime();

      expect(await start(runtime)).toBeUndefined();

      expect(mock.calls("workspace")).toHaveLength(2);
      expect(runtime.phase).toBe("unreachable");
      expect(runtime.lastError).toBe("database is restarting");
      expect(reconnectTimer(runtime)).toBeDefined();
      expect(runtime.describeUnavailable()).toBe(
        `${runtime.host} is unreachable; Honcho memory is paused.`,
      );
      expect(pi.honchoTools().sort()).toEqual(["honcho_chat", "honcho_search"]);
    },
  );

  it(
    "a 429 at connect is unreachable with a reconnect scheduled",
    { timeout: TIMEOUT },
    async () => {
      writeConfig(keyConfig());
      mock.fail("workspace", { status: 429, detail: "slow down", times: 2 });
      const { runtime } = makeRuntime();

      expect(await start(runtime)).toBeUndefined();

      expect(runtime.phase).toBe("unreachable");
      expect(runtime.lastError).toBe("slow down");
      expect(reconnectTimer(runtime)).toBeDefined();

      // The next turn's ready() reconnects once the server answers again
      expect(await runtime.ready(2_000)).toBeDefined();
      expect(runtime.phase).toBe("connected");
    },
  );

  it("the reconnect probe re-arms after another failed connect", { timeout: TIMEOUT }, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    writeConfig(keyConfig());
    // Two attempts (one SDK retry) for the startup connect, two for the first probe
    mock.fail("workspace", { status: 500, times: 4 });
    const { runtime } = makeRuntime();

    const first = start(runtime);
    await advanceUntil(() => expect(runtime.phase).toBe("unreachable"));
    expect(await first).toBeUndefined();
    expect(mock.calls("workspace")).toHaveLength(2);
    expect(reconnectTimer(runtime)).toBeDefined();

    await vi.advanceTimersByTimeAsync(30_000);
    await advanceUntil(() => {
      expect(mock.calls("workspace")).toHaveLength(4);
      expect(runtime.phase).toBe("unreachable");
    });
    expect(reconnectTimer(runtime)).toBeDefined();

    // The server is back; the next probe connects and probing stops
    await vi.advanceTimersByTimeAsync(30_000);
    await advanceUntil(() => expect(runtime.phase).toBe("connected"));
    expect(mock.calls("workspace")).toHaveLength(5);
    expect(reconnectTimer(runtime)).toBeUndefined();
  });

  it(
    "the reconnect probe re-arms when its card call fails with a plain 500",
    { timeout: TIMEOUT },
    async () => {
      writeConfig(keyConfig());
      const { runtime } = makeRuntime();
      await start(runtime);
      await runtime.startupReady(2_000);
      const cards = mock.calls("card").length;

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      mock.fail("card", { status: 503, times: 2 });
      const failing = runtime.call((c) => c.userPeer.getCard()).catch((error: unknown) => error);
      await advanceUntil(() => expect(runtime.phase).toBe("unreachable"));
      expect(await failing).toBeInstanceOf(ServerError);
      expect(reconnectTimer(runtime)).toBeDefined();

      // A 500 is not "unreachable", so call() arms nothing; the probe itself must re-arm
      mock.fail("card", { status: 500, times: 2 });
      await vi.advanceTimersByTimeAsync(30_000);
      await advanceUntil(() => {
        expect(mock.calls("card")).toHaveLength(cards + 4);
        expect(reconnectTimer(runtime)).toBeDefined();
      });
      expect(runtime.phase).toBe("unreachable");

      await vi.advanceTimersByTimeAsync(30_000);
      await advanceUntil(() => expect(runtime.phase).toBe("connected"));
      expect(reconnectTimer(runtime)).toBeUndefined();
    },
  );
});

describe("call() against credential changes", () => {
  it(
    "retries with a token a concurrent call already swapped in, without refreshing",
    { timeout: TIMEOUT },
    async () => {
      const first = makeGrant();
      writeConfig(oauthConfig(first));
      const auth = authServer(() => tokenResponse(`hch-at-${uid()}`, `hch-rt-${uid()}`));
      const { runtime } = makeRuntime(auth.fetchImpl);
      await start(runtime);
      await runtime.startupReady(2_000);

      // Sent with the first token, rejected only after another process rotated the pair
      const gate = deferred<undefined>();
      let attempts = 0;
      const slow = runtime.call(async (c) => {
        attempts += 1;
        if (attempts === 1) {
          await gate.promise;
          throw new AuthenticationError("Invalid or expired access token");
        }
        return tokenOf(c.clients);
      });
      await vi.waitFor(() => expect(attempts).toBe(1));

      const rotated = makeGrant();
      writeConfig(oauthConfig(rotated));
      await runtime.call((c) => c.userPeer.getCard());
      expect(mock.calls("card").at(-1)?.headers.authorization).toBe(
        `Bearer ${rotated.accessToken}`,
      );

      gate.resolve(undefined);
      expect(await slow).toBe(rotated.accessToken);
      expect(attempts).toBe(2);
      expect(auth.tokenCalls).toEqual([]);
      expect(readConfig().oauth).toEqual({ ...rotated });
      expect(runtime.phase).toBe("connected");
    },
  );

  it("goes signed-out when another terminal removed the key", { timeout: TIMEOUT }, async () => {
    writeConfig(keyConfig());
    const { runtime, pi } = makeRuntime();
    await start(runtime);
    await runtime.startupReady(2_000);
    await mock.waitFor((log) => log.some((r) => r.route === "conclusions.list"));
    const sent = mock.requests.length;

    writeConfig(signedOutConfig());

    await expect(runtime.call((c) => c.userPeer.getCard())).rejects.toThrow(SIGNED_OUT);
    expect(runtime.phase).toBe("signed-out");
    expect(runtime.connection).toBeUndefined();
    expect(runtime.startup).toBeUndefined();
    expect(runtime.credential).toBeNull();
    expect(pi.honchoTools()).toEqual([]);
    expect(await runtime.connect()).toBeUndefined();
    await expect(runtime.call((c) => c.userPeer.getCard())).rejects.toThrow(SIGNED_OUT);
    expect(mock.requests).toHaveLength(sent);
  });
});

describe("refresh against concurrent sign-in and sign-out", () => {
  const store = (fetchImpl: Fetch) => new CredentialStore({ path: configPath, env: {}, fetchImpl });

  it(
    "keeps a grant from a sign-in that landed during the exchange",
    { timeout: TIMEOUT },
    async () => {
      const old = makeGrant({ accessExpiresAt: nowS() - 5 });
      const signedIn = makeGrant();
      const rotated = { access: `hch-at-${uid()}`, refresh: `hch-rt-${uid()}` };
      writeConfig({ oauth: { ...old } });
      // The honcho CLI writes its new grant without taking pi's lock
      const auth = authServer(() => {
        writeConfig({ oauth: { ...signedIn } });
        return tokenResponse(rotated.access, rotated.refresh);
      });

      const credential = await store(auth.fetchImpl).fresh(mock.baseUrl);

      expect(auth.tokenCalls).toHaveLength(1);
      expect(credential).toMatchObject({ source: "oauth", token: signedIn.accessToken });
      expect(readConfig().oauth).toEqual({ ...signedIn });
      expect(JSON.stringify(readConfig())).not.toContain(rotated.refresh);
    },
  );

  it(
    "does not write a grant back after a sign-out during the exchange",
    { timeout: TIMEOUT },
    async () => {
      const old = makeGrant({ accessExpiresAt: nowS() - 5 });
      const rotated = { access: `hch-at-${uid()}`, refresh: `hch-rt-${uid()}` };
      writeConfig({ oauth: { ...old } });
      const auth = authServer(() => {
        writeConfig({ peerName: "user" });
        return tokenResponse(rotated.access, rotated.refresh);
      });

      await expect(store(auth.fetchImpl).fresh(mock.baseUrl)).rejects.toBeInstanceOf(
        SignInExpiredError,
      );
      expect(readConfig()).toEqual({ peerName: "user" });
    },
  );

  it(
    "yields to a root key left behind by a sign-out during the exchange",
    { timeout: TIMEOUT },
    async () => {
      const old = makeGrant({ accessExpiresAt: nowS() - 5 });
      const rotated = { access: `hch-at-${uid()}`, refresh: `hch-rt-${uid()}` };
      writeConfig({ apiKey: SHARED_KEY, oauth: { ...old } });
      const auth = authServer(() => {
        writeConfig({ apiKey: SHARED_KEY });
        return tokenResponse(rotated.access, rotated.refresh);
      });

      expect(await store(auth.fetchImpl).fresh(mock.baseUrl)).toEqual({
        source: "shared-key",
        token: SHARED_KEY,
      });
      expect(readConfig()).toEqual({ apiKey: SHARED_KEY });
    },
  );

  it(
    "removeGrant waits for an in-flight refresh and removes what it wrote",
    { timeout: TIMEOUT },
    async () => {
      const old = makeGrant({ accessExpiresAt: nowS() - 5 });
      const rotated = { access: `hch-at-${uid()}`, refresh: `hch-rt-${uid()}` };
      writeConfig({ oauth: { ...old } });
      const exchange = deferred<Response>();
      const auth = authServer(() => exchange.promise);
      const credentials = store(auth.fetchImpl);

      const refreshing = credentials.fresh(mock.baseUrl);
      await vi.waitFor(() => expect(auth.tokenCalls).toHaveLength(1));
      const removing = credentials.removeGrant(mock.baseUrl);
      // The lock is polled every 100ms; logout must not revoke while the refresh holds it
      await nap(250);
      expect(auth.revokeCalls).toEqual([]);
      expect(readConfig().oauth).toMatchObject({ refreshToken: old.refreshToken });

      exchange.resolve(tokenResponse(rotated.access, rotated.refresh));
      expect(await refreshing).toMatchObject({ source: "oauth", token: rotated.access });
      await removing;

      expect(auth.revokeCalls).toEqual([expect.objectContaining({ token: rotated.refresh })]);
      expect(readConfig()).not.toHaveProperty("oauth");
    },
  );
});
