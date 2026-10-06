import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLI_CLIENT_ID,
  DEVICE_GRANT,
  OAuthError,
  PI_CLIENT_ID,
  chooseClient,
  clientSupports,
  defaultRevocationEndpoint,
  defaultTokenEndpoint,
  discover,
  pkcePair,
  pollDeviceToken,
  refreshTokens,
  registerClient,
  requestDeviceCode,
  revokeToken,
  startBrowserLogin,
} from "../extensions/auth/oauth.js";
import type { AuthServer, DeviceCode, Fetch } from "../extensions/auth/oauth.js";

const BASE = "https://api.honcho.test";

const AS: AuthServer = {
  issuer: BASE,
  authorizationEndpoint: "https://app.honcho.test/authorize",
  tokenEndpoint: `${BASE}/oauth/token`,
  deviceAuthorizationEndpoint: `${BASE}/oauth/device_authorization`,
  revocationEndpoint: `${BASE}/oauth/revoke`,
  registrationEndpoint: `${BASE}/oauth/register`,
  grantTypes: ["authorization_code", "refresh_token", DEVICE_GRANT],
};

const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

interface Call {
  url: string;
  method: string;
  form: Record<string, string>;
  json?: unknown;
  headers: Record<string, string>;
}

type Handler = (call: Call) => Response | Promise<Response>;

/** A fetch that records requests and answers from `handler`. */
const recorder = (handler: Handler) => {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const body = init?.body;
    const call: Call = {
      url: urlOf(input),
      method: init?.method ?? "GET",
      form: body instanceof URLSearchParams ? Object.fromEntries(body) : {},
      json: typeof body === "string" ? (JSON.parse(body) as unknown) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

const token = (n = 1): Record<string, unknown> => ({
  access_token: `hch-at-${n}`,
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: `hch-rt-${n}`,
  scope: "write",
  config: {},
});

const metadata = {
  issuer: BASE,
  authorization_endpoint: "https://app.honcho.test/authorize",
  token_endpoint: `${BASE}/oauth/token`,
  device_authorization_endpoint: `${BASE}/oauth/device_authorization`,
  revocation_endpoint: `${BASE}/oauth/revoke`,
  registration_endpoint: `${BASE}/oauth/register`,
  grant_types_supported: ["authorization_code", "refresh_token", DEVICE_GRANT, 7],
};

const rejection = async (promise: Promise<unknown>): Promise<OAuthError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OAuthError);
  return error as OAuthError;
};

describe("discover", () => {
  it("parses RFC 8414 metadata from the well-known path", async () => {
    const { fetchImpl, calls } = recorder(() => json(metadata));
    expect(await discover(`${BASE}//`, fetchImpl)).toEqual(AS);
    expect(calls[0]?.url).toBe(`${BASE}/.well-known/oauth-authorization-server`);
    expect(calls[0]?.headers.accept).toBe("application/json");
  });

  it("defaults the issuer and optional endpoints", async () => {
    const { fetchImpl } = recorder(() =>
      json({ authorization_endpoint: "a", token_endpoint: "t" }),
    );
    expect(await discover(BASE, fetchImpl)).toEqual({
      issuer: BASE,
      authorizationEndpoint: "a",
      tokenEndpoint: "t",
      deviceAuthorizationEndpoint: undefined,
      revocationEndpoint: undefined,
      registrationEndpoint: undefined,
      grantTypes: [],
    });
  });

  it("returns null for 404, bad JSON, missing endpoints or a network failure", async () => {
    expect(
      await discover(BASE, recorder(() => new Response("nope", { status: 404 })).fetchImpl),
    ).toBeNull();
    expect(
      await discover(BASE, recorder(() => new Response("<html>", { status: 200 })).fetchImpl),
    ).toBeNull();
    expect(
      await discover(BASE, recorder(() => json({ token_endpoint: "t" })).fetchImpl),
    ).toBeNull();
    expect(
      await discover(
        BASE,
        recorder(() => json({ authorization_endpoint: "a", token_endpoint: 5 })).fetchImpl,
      ),
    ).toBeNull();
    const failing: Fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await discover(BASE, failing)).toBeNull();
  });
});

describe("clientSupports", () => {
  it("probes the token endpoint with only grant_type and client_id", async () => {
    const { fetchImpl, calls } = recorder(() =>
      json({ error: "invalid_request", error_description: "device_code is required" }, 400),
    );
    expect(await clientSupports(AS, "honcho-cli", DEVICE_GRANT, fetchImpl)).toBe(true);
    expect(calls).toEqual([
      expect.objectContaining({
        url: AS.tokenEndpoint,
        method: "POST",
        form: { grant_type: DEVICE_GRANT, client_id: "honcho-cli" },
      }),
    ]);
  });

  it("maps invalid_client and unauthorized_client to false", async () => {
    expect(
      await clientSupports(
        AS,
        "x",
        "authorization_code",
        recorder(() => json({ error: "invalid_client" }, 401)).fetchImpl,
      ),
    ).toBe(false);
    expect(
      await clientSupports(
        AS,
        "x",
        "authorization_code",
        recorder(() => json({ error: "unauthorized_client" }, 400)).fetchImpl,
      ),
    ).toBe(false);
    expect(
      await clientSupports(
        AS,
        "x",
        "authorization_code",
        recorder(() => new Response("oops", { status: 500 })).fetchImpl,
      ),
    ).toBe(false);
  });

  it("propagates a connection failure", async () => {
    const failing: Fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect((await rejection(clientSupports(AS, "x", "authorization_code", failing))).code).toBe(
      "connection_error",
    );
  });
});

/** Answers the no-code probe per client and grant. */
const probeServer = (supported: Record<string, string[]>, extra?: Handler) =>
  recorder((call) => {
    if (call.url === AS.tokenEndpoint) {
      const grants = supported[call.form.client_id ?? ""];
      if (!grants) {
        return json({ error: "invalid_client" }, 401);
      }
      return grants.includes(call.form.grant_type ?? "")
        ? json({ error: "invalid_request" }, 400)
        : json({ error: "unauthorized_client" }, 400);
    }
    if (extra) {
      return extra(call);
    }
    return new Response("unexpected", { status: 500 });
  });

describe("chooseClient", () => {
  it("uses honcho-pi when the server has it", async () => {
    const { fetchImpl, calls } = probeServer({
      [PI_CLIENT_ID]: ["authorization_code", DEVICE_GRANT],
    });
    expect(await chooseClient(AS, "browser", { fetchImpl })).toEqual({ clientId: PI_CLIENT_ID });
    expect(await chooseClient(AS, "device", { fetchImpl })).toEqual({ clientId: PI_CLIENT_ID });
    expect(calls.map((c) => c.form.grant_type)).toEqual(["authorization_code", DEVICE_GRANT]);
  });

  it("falls back to honcho-cli for device sign-in, with a note", async () => {
    const { fetchImpl, calls } = probeServer({ [CLI_CLIENT_ID]: [DEVICE_GRANT, "refresh_token"] });
    expect(await chooseClient(AS, "device", { fetchImpl })).toEqual({
      clientId: CLI_CLIENT_ID,
      note: 'The approval page will say "Honcho CLI".',
    });
    expect(calls.map((c) => c.form.client_id)).toEqual([PI_CLIENT_ID, CLI_CLIENT_ID]);
  });

  it("fails device sign-in when neither client has the grant", async () => {
    const { fetchImpl } = probeServer({ [CLI_CLIENT_ID]: ["refresh_token"] });
    expect((await rejection(chooseClient(AS, "device", { fetchImpl }))).code).toBe(
      "unsupported_grant_type",
    );
  });

  it("reuses a registered client for browser sign-in", async () => {
    const { fetchImpl, calls } = probeServer({ "dyn-1": ["authorization_code"] });
    expect(await chooseClient(AS, "browser", { fetchImpl, registeredClientId: "dyn-1" })).toEqual({
      clientId: "dyn-1",
      registered: true,
    });
    expect(calls.some((c) => c.url === AS.registrationEndpoint)).toBe(false);
  });

  it("registers a new client when there is none or the old one is gone", async () => {
    for (const registeredClientId of [undefined, "dyn-gone"]) {
      const { fetchImpl, calls } = probeServer({}, (call) =>
        call.url === AS.registrationEndpoint
          ? json({ client_id: "dyn-new" }, 201)
          : new Response("", { status: 500 }),
      );
      expect(await chooseClient(AS, "browser", { fetchImpl, registeredClientId })).toEqual({
        clientId: "dyn-new",
        registered: true,
      });
      expect(calls.at(-1)).toMatchObject({
        url: AS.registrationEndpoint,
        method: "POST",
        json: {
          client_name: "pi",
          redirect_uris: ["http://127.0.0.1/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          scope: "write",
        },
      });
      expect(calls.at(-1)?.headers["content-type"]).toBe("application/json");
    }
  });

  it("honors an override without probing", async () => {
    const { fetchImpl, calls } = recorder(() => json({}));
    expect(await chooseClient(AS, "device", { fetchImpl, override: "custom" })).toEqual({
      clientId: "custom",
    });
    expect(calls).toEqual([]);
  });
});

describe("registerClient", () => {
  it("fails clearly without a registration endpoint", async () => {
    const { registrationEndpoint: _r, ...noReg } = AS;
    expect((await rejection(registerClient(noReg, recorder(() => json({})).fetchImpl))).code).toBe(
      "registration_unavailable",
    );
  });

  it("surfaces server errors and incomplete responses", async () => {
    const denied = await rejection(
      registerClient(
        AS,
        recorder(() => json({ error: "access_denied", error_description: "disabled" }, 403))
          .fetchImpl,
      ),
    );
    expect([denied.code, denied.description, denied.status]).toEqual([
      "access_denied",
      "disabled",
      403,
    ]);
    expect(
      (await rejection(registerClient(AS, recorder(() => json({}, 201)).fetchImpl))).code,
    ).toBe("invalid_response");
    expect(
      (
        await rejection(
          registerClient(AS, recorder(() => json({ detail: "slow down" }, 429)).fetchImpl),
        )
      ).code,
    ).toBe("rate_limited");
  });
});

describe("requestDeviceCode", () => {
  const deviceBody = {
    device_code: "d".repeat(48),
    user_code: "WDJB-MJHT",
    verification_uri: "https://app.honcho.test/device",
    verification_uri_complete: "https://app.honcho.test/device?user_code=WDJB-MJHT",
    expires_in: 600,
    interval: 5,
  };

  it("posts client_id, scope and source, and returns the fields", async () => {
    const { fetchImpl, calls } = recorder(() => json(deviceBody));
    expect(await requestDeviceCode(AS, "honcho-cli", { fetchImpl })).toEqual(deviceBody);
    expect(calls[0]).toMatchObject({
      url: AS.deviceAuthorizationEndpoint,
      method: "POST",
      form: { client_id: "honcho-cli", scope: "write", source: "pi" },
    });
  });

  it("builds verification_uri_complete and defaults expiry and interval", async () => {
    const { verification_uri_complete: _c, expires_in: _e, interval: _i, ...partial } = deviceBody;
    const code = await requestDeviceCode(AS, "c", {
      fetchImpl: recorder(() => json({ ...partial, user_code: "AB CD" })).fetchImpl,
    });
    expect(code.verification_uri_complete).toBe("https://app.honcho.test/device?user_code=AB%20CD");
    expect(code.expires_in).toBe(600);
    expect(code.interval).toBe(5);
  });

  it("maps 429 to rate_limited and rejects incomplete responses", async () => {
    const limited = await rejection(
      requestDeviceCode(AS, "c", {
        fetchImpl: recorder(() => json({ error: "Rate limit exceeded: 5 per 1 minute" }, 429))
          .fetchImpl,
      }),
    );
    expect([limited.code, limited.status]).toEqual(["rate_limited", 429]);
    expect(
      (
        await rejection(
          requestDeviceCode(AS, "c", {
            fetchImpl: recorder(() => json({ device_code: "d" })).fetchImpl,
          }),
        )
      ).code,
    ).toBe("invalid_response");
    expect(
      (
        await rejection(
          requestDeviceCode(AS, "c", {
            fetchImpl: recorder(() => json({ error: "unauthorized_client" }, 400)).fetchImpl,
          }),
        )
      ).code,
    ).toBe("unauthorized_client");
  });

  it("refuses when the server has no device endpoint", async () => {
    const { deviceAuthorizationEndpoint: _d, ...noDevice } = AS;
    expect(
      (
        await rejection(
          requestDeviceCode(noDevice, "c", { fetchImpl: recorder(() => json({})).fetchImpl }),
        )
      ).code,
    ).toBe("unsupported_grant_type");
  });
});

describe("pollDeviceToken", () => {
  const code = (over: Partial<DeviceCode> = {}): DeviceCode => ({
    device_code: "dev-code",
    user_code: "ABCD-EFGH",
    verification_uri: "https://app.honcho.test/device",
    verification_uri_complete: "https://app.honcho.test/device?user_code=ABCD-EFGH",
    expires_in: 600,
    interval: 5,
    ...over,
  });

  /** Fake clock: sleeping advances `now`. */
  const clock = () => {
    let t = 1_000_000;
    const waits: number[] = [];
    return {
      waits,
      now: () => t,
      sleepImpl: async (ms: number, signal?: AbortSignal) => {
        if (signal?.aborted) {
          throw new OAuthError("cancelled");
        }
        waits.push(ms);
        t += ms;
      },
    };
  };

  const scripted = (responses: (() => Response)[]) => {
    let i = 0;
    return recorder(() => {
      const next = responses[i++];
      if (!next) {
        throw new Error("no more scripted responses");
      }
      return next();
    });
  };

  it("waits 5, 5, 10 seconds across pending, slow_down, success", async () => {
    const c = clock();
    const { fetchImpl, calls } = scripted([
      () => json({ error: "authorization_pending" }, 400),
      () => json({ error: "slow_down" }, 400),
      () => json(token()),
    ]);
    let polls = 0;
    const result = await pollDeviceToken(AS, "honcho-cli", code(), {
      fetchImpl,
      now: c.now,
      sleepImpl: c.sleepImpl,
      onPoll: () => polls++,
    });
    expect(result).toEqual({ ...token(), config: {} });
    expect(c.waits).toEqual([5_000, 5_000, 10_000]);
    expect(polls).toBe(3);
    expect(calls[0]).toMatchObject({
      url: AS.tokenEndpoint,
      form: { grant_type: DEVICE_GRANT, device_code: "dev-code", client_id: "honcho-cli" },
    });
  });

  it("clamps the interval to 1..60 and caps slow_down at 60", async () => {
    const c = clock();
    const { fetchImpl } = scripted([() => json({ error: "slow_down" }, 400), () => json(token())]);
    await pollDeviceToken(AS, "c", code({ interval: 58 }), {
      fetchImpl,
      now: c.now,
      sleepImpl: c.sleepImpl,
    });
    expect(c.waits).toEqual([58_000, 60_000]);
    const c2 = clock();
    await pollDeviceToken(AS, "c", code({ interval: 0 }), {
      fetchImpl: scripted([() => json(token())]).fetchImpl,
      now: c2.now,
      sleepImpl: c2.sleepImpl,
    });
    expect(c2.waits).toEqual([1_000]);
  });

  it("stops on denial", async () => {
    const c = clock();
    const { fetchImpl } = scripted([
      () => json({ error: "access_denied", error_description: "The user denied the request" }, 400),
    ]);
    const error = await rejection(
      pollDeviceToken(AS, "c", code(), { fetchImpl, now: c.now, sleepImpl: c.sleepImpl }),
    );
    expect([error.code, error.description]).toEqual([
      "access_denied",
      "The user denied the request",
    ]);
  });

  it("stops on server-side expiry", async () => {
    const c = clock();
    const { fetchImpl } = scripted([() => json({ error: "expired_token" }, 400)]);
    expect(
      (
        await rejection(
          pollDeviceToken(AS, "c", code(), { fetchImpl, now: c.now, sleepImpl: c.sleepImpl }),
        )
      ).code,
    ).toBe("expired_token");
  });

  it("gives up locally before the code expires", async () => {
    const c = clock();
    const { fetchImpl, calls } = recorder(() => json({ error: "authorization_pending" }, 400));
    const error = await rejection(
      pollDeviceToken(AS, "c", code({ expires_in: 12 }), {
        fetchImpl,
        now: c.now,
        sleepImpl: c.sleepImpl,
      }),
    );
    expect(error.code).toBe("expired_token");
    expect(c.waits).toEqual([5_000, 5_000]);
    expect(calls).toHaveLength(2);
  });

  it("tolerates connection blips and 5xx responses", async () => {
    const c = clock();
    let i = 0;
    const fetchImpl: Fetch = async () => {
      i += 1;
      if (i === 1) {
        throw new TypeError("fetch failed");
      }
      if (i === 2) {
        return new Response("bad gateway", { status: 502 });
      }
      return json(token());
    };
    expect(
      (await pollDeviceToken(AS, "c", code(), { fetchImpl, now: c.now, sleepImpl: c.sleepImpl }))
        .access_token,
    ).toBe("hch-at-1");
    expect(c.waits).toEqual([5_000, 5_000, 5_000]);
  });

  it("stops on invalid_grant", async () => {
    const c = clock();
    const { fetchImpl } = scripted([
      () => json({ error: "invalid_grant", error_description: "Invalid device code" }, 400),
    ]);
    expect(
      (
        await rejection(
          pollDeviceToken(AS, "c", code(), { fetchImpl, now: c.now, sleepImpl: c.sleepImpl }),
        )
      ).code,
    ).toBe("invalid_grant");
  });

  it("aborts promptly while sleeping, with the real timer", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = recorder(() => json({ error: "authorization_pending" }, 400));
    const pending = pollDeviceToken(AS, "c", code(), { fetchImpl, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    expect((await rejection(pending)).code).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toHaveLength(0);
  });

  it("aborts an in-flight poll request", async () => {
    const controller = new AbortController();
    const fetchImpl: Fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        setTimeout(() => controller.abort(), 10);
      });
    const sleepImpl = async () => {};
    expect(
      (
        await rejection(
          pollDeviceToken(AS, "c", code(), { fetchImpl, signal: controller.signal, sleepImpl }),
        )
      ).code,
    ).toBe("cancelled");
  });
});

describe("refreshTokens / revokeToken", () => {
  it("posts the refresh form and parses the rotated pair", async () => {
    const { fetchImpl, calls } = recorder(() => json(token(2)));
    const result = await refreshTokens(`${BASE}/oauth/token`, "honcho-pi", "hch-rt-1", fetchImpl);
    expect(result.refresh_token).toBe("hch-rt-2");
    expect(calls[0]).toMatchObject({
      url: `${BASE}/oauth/token`,
      method: "POST",
      form: { grant_type: "refresh_token", refresh_token: "hch-rt-1", client_id: "honcho-pi" },
    });
    expect(calls[0]?.headers.accept).toBe("application/json");
  });

  it("classifies refresh failures", async () => {
    const dead = await rejection(
      refreshTokens(
        "t",
        "c",
        "r",
        recorder(() => json({ error: "invalid_grant", error_description: "revoked" }, 400))
          .fetchImpl,
      ),
    );
    expect([dead.code, dead.permanent, dead.message]).toEqual([
      "invalid_grant",
      true,
      "invalid_grant: revoked",
    ]);
    const server = await rejection(
      refreshTokens(
        "t",
        "c",
        "r",
        recorder(() => new Response("<html>", { status: 503 })).fetchImpl,
      ),
    );
    expect([server.code, server.permanent, server.status]).toEqual(["http_503", false, 503]);
    const detail = await rejection(
      refreshTokens(
        "t",
        "c",
        "r",
        recorder(() => json({ detail: "Missing API key" }, 401)).fetchImpl,
      ),
    );
    expect([detail.code, detail.description]).toEqual(["http_401", "Missing API key"]);
    expect(
      (
        await rejection(
          refreshTokens("t", "c", "r", recorder(() => json({ token_type: "Bearer" })).fetchImpl),
        )
      ).code,
    ).toBe("invalid_response");
  });

  it("defaults token fields the server leaves out", async () => {
    const result = await refreshTokens(
      "t",
      "c",
      "r",
      recorder(() => json({ access_token: "a" })).fetchImpl,
    );
    expect(result).toEqual({
      access_token: "a",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: undefined,
      scope: undefined,
      config: undefined,
    });
  });

  it("revokes with the refresh token hint and swallows failures", async () => {
    const { fetchImpl, calls } = recorder(() => json({}));
    await revokeToken(`${BASE}/oauth/revoke`, "honcho-cli", "hch-rt-9", fetchImpl);
    expect(calls[0]).toMatchObject({
      url: `${BASE}/oauth/revoke`,
      method: "POST",
      form: { token: "hch-rt-9", client_id: "honcho-cli", token_type_hint: "refresh_token" },
    });
    const failing: Fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(revokeToken("x", "c", "t", failing)).resolves.toBeUndefined();
  });

  it("derives default endpoints from the host", () => {
    expect(defaultTokenEndpoint(`${BASE}/`)).toBe(`${BASE}/oauth/token`);
    expect(defaultRevocationEndpoint(BASE)).toBe(`${BASE}/oauth/revoke`);
  });
});

describe("pkcePair", () => {
  it("makes an S256 pair within RFC 7636 limits", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(challenge).toHaveLength(43);
    expect(pkcePair().verifier).not.toBe(verifier);
  });
});

describe("startBrowserLogin", () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  const settledWithin = async (promise: Promise<unknown>, ms: number): Promise<boolean> => {
    let settled = false;
    promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((resolve) => setTimeout(resolve, ms));
    return settled;
  };

  const setup = async (handler: Handler = () => json(token()), timeoutMs?: number) => {
    const { fetchImpl, calls } = recorder(handler);
    const login = await startBrowserLogin(AS, "honcho-pi", { fetchImpl, timeoutMs });
    const params = new URL(login.authorizeUrl).searchParams;
    const callback = (query: Record<string, string>) =>
      fetch(`${login.redirectUri}?${new URLSearchParams(query).toString()}`);
    return { login, params, state: params.get("state") ?? "", callback, calls };
  };

  it("builds the authorize URL on the bound loopback port", async () => {
    const { login, params } = await setup();
    try {
      expect(login.redirectUri).toBe(`http://127.0.0.1:${login.port}/callback`);
      expect(login.authorizeUrl.startsWith(`${AS.authorizationEndpoint}?`)).toBe(true);
      expect(Object.fromEntries(params)).toEqual({
        client_id: "honcho-pi",
        redirect_uri: login.redirectUri,
        scope: "write",
        response_type: "code",
        code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as string,
        code_challenge_method: "S256",
        state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as string,
        source: "pi",
      });
      expect(login.deadline).toBeGreaterThan(Date.now() + 290_000);
    } finally {
      login.cancel();
    }
  });

  it("exchanges the code with the PKCE verifier and identical redirect_uri, then serves the success page", async () => {
    const { login, params, state, callback, calls } = await setup();
    const res = await callback({ code: "auth-code-1", state });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain(
      "Connected to Honcho. You can close this tab and return to pi.",
    );
    expect(await login.result).toEqual({ ...token(), config: {} });

    expect(calls).toHaveLength(1);
    const form = calls[0]?.form ?? {};
    expect(calls[0]?.url).toBe(AS.tokenEndpoint);
    expect(form).toMatchObject({
      grant_type: "authorization_code",
      client_id: "honcho-pi",
      code: "auth-code-1",
      redirect_uri: login.redirectUri,
    });
    expect(
      createHash("sha256")
        .update(form.code_verifier ?? "")
        .digest("base64url"),
    ).toBe(params.get("code_challenge"));

    // The server is closed once settled
    await expect(callback({ code: "again", state })).rejects.toThrow();
  });

  it("rejects a state mismatch with 400 and keeps waiting", async () => {
    const { login, state, callback, calls } = await setup();
    const bad = await callback({ code: "c", state: "forged" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("State mismatch. Start sign-in again from pi.");
    expect(await callback({ code: "c" }).then((r) => r.status)).toBe(400);
    expect(await settledWithin(login.result, 30)).toBe(false);
    expect(calls).toHaveLength(0);
    expect((await callback({ code: "good", state })).status).toBe(200);
    expect((await login.result).access_token).toBe("hch-at-1");
  });

  it("settles with the OAuth error when the user denies", async () => {
    const { login, state, callback } = await setup();
    const res = await callback({
      error: "access_denied",
      error_description: "The user denied",
      state,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(
      "Sign-in was not completed (access_denied). You can close this tab.",
    );
    const error = await rejection(login.result);
    expect([error.code, error.description]).toEqual(["access_denied", "The user denied"]);
  });

  it("escapes error text in the page", async () => {
    const { login, state, callback } = await setup();
    const res = await callback({ error: "<script>x</script>", state });
    const body = await res.text();
    expect(body).not.toContain("<script>x");
    expect(body).toContain("&#60;script&#62;x");
    await rejection(login.result);
  });

  it("shows a failed exchange in the browser and rejects", async () => {
    const { login, state, callback } = await setup(() =>
      json({ error: "invalid_grant", error_description: "code expired" }, 400),
    );
    const res = await callback({ code: "late", state });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("invalid_grant: code expired");
    expect((await rejection(login.result)).code).toBe("invalid_grant");
  });

  it("answers 400 without a code and 409 to a duplicate callback during the exchange", async () => {
    const gate = deferred<void>();
    const { login, state, callback, calls } = await setup(async () => {
      await gate.promise;
      return json(token());
    });
    expect((await callback({ state })).status).toBe(400);
    const first = callback({ code: "one", state });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await callback({ code: "two", state });
    expect(second.status).toBe(409);
    gate.resolve();
    expect((await first).status).toBe(200);
    await login.result;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.form.code).toBe("one");
  });

  it("serves 404 for other paths and methods", async () => {
    const { login, state } = await setup();
    try {
      expect((await fetch(`http://127.0.0.1:${login.port}/`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${login.port}/favicon.ico`)).status).toBe(404);
      expect(
        (await fetch(`${login.redirectUri}?state=${state}&code=x`, { method: "POST" })).status,
      ).toBe(404);
      expect(await settledWithin(login.result, 20)).toBe(false);
    } finally {
      login.cancel();
    }
  });

  it("accepts a pasted redirect URL", async () => {
    const { login, state, calls } = await setup();
    login.submitRedirectUrl(`  http://127.0.0.1:1/callback?code=pasted&state=${state}  `);
    expect((await login.result).access_token).toBe("hch-at-1");
    expect(calls[0]?.form).toMatchObject({ code: "pasted", redirect_uri: login.redirectUri });
  });

  it("rejects a pasted URL from another attempt, junk, or an error redirect", async () => {
    const other = await setup();
    other.login.submitRedirectUrl("http://127.0.0.1:1/callback?code=x&state=other");
    expect((await rejection(other.login.result)).code).toBe("state_mismatch");
    const junk = await setup();
    junk.login.submitRedirectUrl("not a url");
    expect((await rejection(junk.login.result)).code).toBe("invalid_request");
    const denied = await setup();
    denied.login.submitRedirectUrl(
      `http://127.0.0.1:1/callback?error=access_denied&state=${denied.state}`,
    );
    expect((await rejection(denied.login.result)).code).toBe("access_denied");
  });

  it("cancels and closes the server", async () => {
    const { login, state, callback } = await setup();
    login.cancel();
    expect((await rejection(login.result)).code).toBe("cancelled");
    await expect(callback({ code: "x", state })).rejects.toThrow();
  });

  it("times out", async () => {
    const { login } = await setup(undefined, 30);
    const error = await rejection(login.result);
    expect(error.code).toBe("timeout");
  });

  it("does not surface an unhandled rejection when nobody awaits the result", async () => {
    const { login } = await setup();
    login.cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

describe("OAuthError", () => {
  it("formats and classifies", () => {
    const e = new OAuthError("invalid_client", "Unknown client", 401);
    expect([e.name, e.message, e.permanent]).toEqual([
      "OAuthError",
      "invalid_client: Unknown client",
      true,
    ]);
    expect(new OAuthError("authorization_pending").permanent).toBe(false);
  });
});
