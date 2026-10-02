import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { AuthenticationError, ConnectionError } from "@honcho-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../extensions/auth/credentials.js";
import type { Credential } from "../extensions/auth/credentials.js";
import { OAuthError } from "../extensions/auth/oauth.js";
import type {
  AuthServer,
  BrowserLogin,
  DeviceCode,
  TokenResponse,
} from "../extensions/auth/oauth.js";
import type { HonchoRuntime, RuntimePhase } from "../extensions/runtime.js";
import { resolveSettings } from "../extensions/settings.js";
import { LOGIN_ENTRY_TYPE } from "../extensions/ui/entries.js";
import { runLogin, runLogout } from "../extensions/ui/login.js";
import { describeLoginError, driveLogin } from "../extensions/ui/login/flow.js";
import type { LoginDeps, LoginTarget } from "../extensions/ui/login/flow.js";
import {
  ApiKeyScreen,
  BrowserScreen,
  DeviceScreen,
  LoginView,
  PickerScreen,
} from "../extensions/ui/login/view.js";
import { FooterStatus } from "../extensions/ui/status.js";
import { plainTheme } from "./helpers/theme.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const strip = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));

const AS: AuthServer = {
  issuer: "https://api.honcho.dev",
  authorizationEndpoint: "https://app.honcho.dev/authorize",
  tokenEndpoint: "https://api.honcho.dev/oauth/token",
  deviceAuthorizationEndpoint: "https://api.honcho.dev/oauth/device_authorization",
  revocationEndpoint: "https://api.honcho.dev/oauth/revoke",
  grantTypes: [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:device_code",
  ],
};

const TOKEN: TokenResponse = {
  access_token: "hch-at-1",
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: "hch-rt-1",
  scope: "write",
};

const CODE: DeviceCode = {
  device_code: "dc",
  user_code: "WDJB-MJHT",
  verification_uri: "https://app.honcho.dev/device",
  verification_uri_complete: "https://app.honcho.dev/device?user_code=WDJB-MJHT",
  expires_in: 600,
  interval: 5,
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Polls until resolved, or rejects with OAuthError("cancelled") on abort, like the real poller. */
const pollUntil = (result: Promise<TokenResponse>) =>
  vi.fn(
    (_as: AuthServer, _id: string, _code: DeviceCode, opts: { signal?: AbortSignal } = {}) =>
      new Promise<TokenResponse>((resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new OAuthError("cancelled")), {
          once: true,
        });
        result.then(resolve, reject);
      }),
  );

const fakeBrowserLogin = () => {
  const result = deferred<TokenResponse>();
  result.promise.catch(() => {});
  const submit = vi.fn<(url: string) => void>();
  const cancel = vi.fn(() => result.reject(new OAuthError("cancelled")));
  const login: BrowserLogin = {
    authorizeUrl: "https://app.honcho.dev/authorize?client_id=dyn-123&state=s",
    redirectUri: "http://127.0.0.1:53682/callback",
    port: 53682,
    deadline: 1_000 + 300_000,
    result: result.promise,
    submitRedirectUrl: submit,
    cancel,
  };
  return { login, result, submit, cancel };
};

const fakeDeps = (over: Partial<LoginDeps> = {}): LoginDeps => ({
  discover: vi.fn(async () => AS),
  chooseClient: vi.fn(async () => ({ clientId: "honcho-pi" })),
  startBrowserLogin: vi.fn(async () => fakeBrowserLogin().login),
  requestDeviceCode: vi.fn(async () => CODE),
  pollDeviceToken: vi.fn(async () => TOKEN),
  openBrowser: vi.fn(),
  copy: vi.fn(async () => {}),
  probe: vi.fn(async () => 12),
  env: {},
  now: () => 1_000,
  ...over,
});

const fakeTarget = () => ({
  baseUrl: "https://api.honcho.dev",
  endpoint: "api.honcho.dev",
  workspace: "claude_code",
  registeredClientId: (): string | undefined => undefined,
  rememberClient: vi.fn<LoginTarget["rememberClient"]>(),
  setSigningIn: vi.fn<LoginTarget["setSigningIn"]>(),
});

const views: LoginView[] = [];
const newView = () => {
  const view = new LoginView({ requestRender() {} }, plainTheme(), () => 1_000);
  views.push(view);
  return view;
};

afterEach(() => {
  for (const view of views.splice(0)) {
    view.dispose();
  }
});

describe("driveLogin", () => {
  it("API key: validates against the configured workspace and returns the key", async () => {
    const deps = fakeDeps();
    const target = fakeTarget();
    const view = newView();
    const done = driveLogin(view, target, "key", deps);
    const screen = view.current as ApiKeyScreen;
    expect(screen).toBeInstanceOf(ApiKeyScreen);
    view.handleInput("hch-v3-goodkey1234");
    view.handleInput("\r");
    await expect(done).resolves.toEqual({ kind: "key", key: "hch-v3-goodkey1234" });
    expect(deps.probe).toHaveBeenCalledWith({
      token: "hch-v3-goodkey1234",
      baseUrl: "https://api.honcho.dev",
      workspace: "claude_code",
    });
    expect(deps.discover).not.toHaveBeenCalled();
    expect(target.setSigningIn).toHaveBeenCalledWith(true);
  });

  it("API key: keeps the input after a rejection so the user can retry", async () => {
    const probe = vi
      .fn<LoginDeps["probe"]>()
      .mockRejectedValueOnce(new AuthenticationError("Invalid API key"))
      .mockRejectedValueOnce(new ConnectionError("fetch failed"))
      .mockResolvedValueOnce(12);
    const target = fakeTarget();
    const view = newView();
    const done = driveLogin(view, target, "key", fakeDeps({ probe }));
    const screen = view.current as ApiKeyScreen;
    view.handleInput("hch-v3-badkey12345");
    view.handleInput("\r");
    await flush();
    expect(screen.render(100, plainTheme(), 0)).toContain(
      " ✗ api.honcho.dev rejected this key (401). Check it was copied in full.",
    );
    expect(screen.state.value).toBe("hch-v3-badkey12345");
    expect(target.setSigningIn).toHaveBeenLastCalledWith(false);
    view.handleInput("\r");
    await flush();
    expect(screen.render(100, plainTheme(), 0)).toContain(
      " ✗ Couldn't reach api.honcho.dev: fetch failed",
    );
    view.handleInput("\r");
    await expect(done).resolves.toEqual({ kind: "key", key: "hch-v3-badkey12345" });
  });

  it("picker: shows a checking state, then runs the device flow", async () => {
    const discovered = deferred<AuthServer | null>();
    const poll = deferred<TokenResponse>();
    const note = 'The approval page will say "Honcho CLI".';
    const deps = fakeDeps({
      discover: vi.fn(() => discovered.promise),
      chooseClient: vi.fn(async () => ({ clientId: "honcho-cli", note })),
      pollDeviceToken: pollUntil(poll.promise),
    });
    const target = fakeTarget();
    const view = newView();
    const done = driveLogin(view, target, undefined, deps);
    expect(strip(view.render(100))).toContain(" ⠹ Checking api.honcho.dev…");
    discovered.resolve(AS);
    await flush();
    expect(view.current).toBeInstanceOf(PickerScreen);
    view.handleInput("\x1b[B");
    view.handleInput("\r");
    await flush();
    expect(view.current).toBeInstanceOf(DeviceScreen);
    const lines = strip(view.render(100));
    expect(lines).toContain("        WDJB-MJHT");
    expect(lines).toContain(" ⠹ Waiting for approval · code expires in 10:00");
    expect(lines).toContain(` ${note}`);
    expect(deps.chooseClient).toHaveBeenCalledWith(AS, "device");
    expect(target.setSigningIn).toHaveBeenCalledWith(true);
    poll.resolve(TOKEN);
    await expect(done).resolves.toEqual({ kind: "oauth", token: TOKEN, clientId: "honcho-cli" });
  });

  it("device: esc cancels polling", async () => {
    const deps = fakeDeps({ pollDeviceToken: pollUntil(new Promise(() => {})) });
    const view = newView();
    const done = driveLogin(view, fakeTarget(), "device", deps);
    await flush();
    expect(view.current).toBeInstanceOf(DeviceScreen);
    view.handleInput("\x1b");
    await expect(done).resolves.toEqual({ kind: "cancelled" });
  });

  it("device: maps a denial to the approval-page message", async () => {
    const deps = fakeDeps({
      pollDeviceToken: vi.fn(async () =>
        Promise.reject(new OAuthError("access_denied", "The user denied the request")),
      ),
    });
    const done = driveLogin(newView(), fakeTarget(), "device", deps);
    await expect(done).resolves.toEqual({
      kind: "failed",
      message: "Sign-in was denied on the approval page.",
    });
  });

  it("falls back to an API-key-only picker when the endpoint has no OAuth", async () => {
    const deps = fakeDeps({ discover: vi.fn(async () => null) });
    const view = newView();
    const done = driveLogin(view, { ...fakeTarget(), endpoint: "localhost:8000" }, "browser", deps);
    await flush();
    const lines = strip(view.render(100));
    expect(lines).toContain("→ API key              Paste a key from your Honcho dashboard");
    expect(lines).toContain(" Browser and device sign-in aren't available on localhost:8000.");
    expect(lines.some((l) => l.includes("Device code"))).toBe(false);
    view.handleInput("\r");
    await flush();
    expect(view.current).toBeInstanceOf(ApiKeyScreen);
    view.handleInput("\x1b");
    await expect(done).resolves.toEqual({ kind: "cancelled" });
  });

  it("browser: remembers a registered client, opens the browser and accepts a pasted redirect", async () => {
    const { login, result, submit, cancel } = fakeBrowserLogin();
    const deps = fakeDeps({
      chooseClient: vi.fn(async () => ({ clientId: "dyn-123", registered: true })),
      startBrowserLogin: vi.fn(async () => login),
    });
    const target = fakeTarget();
    const view = newView();
    const done = driveLogin(view, target, "browser", deps);
    await flush();
    expect(target.rememberClient).toHaveBeenCalledWith("dyn-123");
    expect(deps.openBrowser).toHaveBeenCalledWith(login.authorizeUrl);
    expect(view.current).toBeInstanceOf(BrowserScreen);
    expect(strip(view.render(100))).toContain(" Callback on 127.0.0.1:53682 · times out in 5:00");
    view.handleInput("p");
    view.handleInput("http://127.0.0.1:53682/callback?code=abc&state=s");
    view.handleInput("\r");
    expect(submit).toHaveBeenCalledWith("http://127.0.0.1:53682/callback?code=abc&state=s");
    result.resolve(TOKEN);
    await expect(done).resolves.toEqual({ kind: "oauth", token: TOKEN, clientId: "dyn-123" });
    expect(cancel).toHaveBeenCalled();
  });

  it("browser: does not re-remember a client it already registered", async () => {
    const deps = fakeDeps({
      chooseClient: vi.fn(async () => ({ clientId: "dyn-123", registered: true })),
    });
    const target = { ...fakeTarget(), registeredClientId: () => "dyn-123" };
    const view = newView();
    void driveLogin(view, target, "browser", deps);
    await flush();
    expect(deps.chooseClient).toHaveBeenCalledWith(AS, "browser", {
      registeredClientId: "dyn-123",
    });
    expect(target.rememberClient).not.toHaveBeenCalled();
  });

  it("browser: esc closes the loopback server", async () => {
    const { login, cancel } = fakeBrowserLogin();
    const view = newView();
    const done = driveLogin(
      view,
      fakeTarget(),
      "browser",
      fakeDeps({ startBrowserLogin: vi.fn(async () => login) }),
    );
    await flush();
    view.handleInput("\x1b");
    await expect(done).resolves.toEqual({ kind: "cancelled" });
    expect(cancel).toHaveBeenCalled();
  });

  it("browser: esc while the server is starting still closes it", async () => {
    const { login, cancel } = fakeBrowserLogin();
    const starting = deferred<BrowserLogin>();
    const view = newView();
    const done = driveLogin(
      view,
      fakeTarget(),
      "browser",
      fakeDeps({ startBrowserLogin: vi.fn(() => starting.promise) }),
    );
    await flush();
    view.handleInput("\x1b");
    await expect(done).resolves.toEqual({ kind: "cancelled" });
    starting.resolve(login);
    await flush();
    expect(cancel).toHaveBeenCalled();
  });
});

describe("describeLoginError", () => {
  it("maps device and browser outcomes to user-facing copy", () => {
    const say = (code: string, description?: string) =>
      describeLoginError(new OAuthError(code, description), "api.honcho.dev");
    expect(say("expired_token")).toBe(
      "The code expired before it was approved. Run /honcho login to get a new one.",
    );
    expect(say("rate_limited")).toBe("Too many sign-in attempts. Wait a minute and try again.");
    expect(say("connection_error", "ECONNREFUSED")).toBe(
      "Couldn't reach api.honcho.dev: ECONNREFUSED.",
    );
    expect(say("invalid_grant", "Invalid device code")).toBe("Sign-in failed: Invalid device code");
    expect(describeLoginError(new Error("boom"), "api.honcho.dev")).toBe("Sign-in failed: boom");
  });
});

// ── runLogin / runLogout against a fake runtime ─────────────────────

interface FakeStore {
  path: string;
  saveGrant: ReturnType<typeof vi.fn>;
  savePiKey: ReturnType<typeof vi.fn>;
  removePiKey: ReturnType<typeof vi.fn>;
  removeGrant: ReturnType<typeof vi.fn>;
  rememberClient: ReturnType<typeof vi.fn>;
  registeredClientId: () => string | undefined;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-honcho-login-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fakeStore = (): FakeStore => ({
  path: join(dir, "config.json"),
  saveGrant: vi.fn(),
  savePiKey: vi.fn(),
  removePiKey: vi.fn(),
  removeGrant: vi.fn(async () => {}),
  rememberClient: vi.fn(),
  registeredClientId: () => undefined,
});

const fakeRuntime = (
  opts: {
    store?: unknown;
    credential?: Credential | null;
    phase?: RuntimePhase;
    afterRestart?: (rt: Record<string, unknown>) => void;
  } = {},
) => {
  const footer = new FooterStatus();
  const rt: Record<string, unknown> = {
    footer,
    store: opts.store ?? fakeStore(),
    settings: {
      ...resolveSettings({}, {}),
      peerName: "aakash",
      workspace: "claude_code",
      aiPeer: "pi",
    },
    file: {},
    credential: opts.credential ?? null,
    connection: undefined,
    phase: opts.phase ?? "signed-out",
    active: false,
    host: "api.honcho.dev",
    pi: { appendEntry: vi.fn() },
    safe: (fn: () => void) => fn(),
    describeUnavailable: () => "api.honcho.dev is unreachable; Honcho memory is paused.",
    setPhase: vi.fn((phase: RuntimePhase) => {
      rt.phase = phase;
      if (phase === "signed-out" || phase === "off" || phase === "connecting") {
        footer.set({ kind: phase });
      }
    }),
  };
  const restart = vi.fn(async () => {
    rt.phase = "connected";
    rt.active = true;
    rt.connection = { sessionName: "aakash-demo" };
    footer.set({
      kind: "connected",
      peer: "aakash",
      workspace: "claude_code",
      session: "aakash-demo",
    });
    opts.afterRestart?.(rt);
    return rt.connection;
  });
  rt.restart = restart;
  footer.set({ kind: rt.phase === "signed-out" ? "signed-out" : "connecting" });
  return {
    runtime: rt as unknown as HonchoRuntime,
    rt,
    footer,
    restart,
    store: rt.store as FakeStore,
    appendEntry: (rt.pi as { appendEntry: ReturnType<typeof vi.fn> }).appendEntry,
  };
};

const fakeCtx = (
  mode: ExtensionCommandContext["mode"] = "tui",
  ui: Record<string, unknown> = {},
) => {
  const captured: { view?: LoginView } = {};
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: join(dir, "demo"),
    sessionManager: { getSessionId: () => "s1" },
    ui: {
      notify: vi.fn(),
      confirm: vi.fn(async () => true),
      select: vi.fn(async () => undefined),
      input: vi.fn(async () => undefined),
      custom: vi.fn(
        (
          factory: (
            tui: unknown,
            theme: unknown,
            kb: unknown,
            done: (value: unknown) => void,
          ) => LoginView,
        ) =>
          new Promise((resolve) => {
            const view = factory({ requestRender() {} }, plainTheme(), undefined, (value) => {
              view.dispose();
              resolve(value);
            });
            captured.view = view;
          }),
      ),
      ...ui,
    },
  };
  return { ctx: ctx as unknown as ExtensionCommandContext, ui: ctx.ui, captured };
};

describe("runLogin", () => {
  it("saves a checked API key, reconnects and appends the signed-in block", async () => {
    const { runtime, store, footer, appendEntry, restart } = fakeRuntime();
    const { ctx, captured } = fakeCtx();
    const done = runLogin(ctx, runtime, "key", fakeDeps());
    const view = captured.view as LoginView;
    view.handleInput("hch-v3-goodkey1234");
    view.handleInput("\r");
    await flush();
    await done;
    expect(store.savePiKey).toHaveBeenCalledWith("hch-v3-goodkey1234");
    expect(restart).toHaveBeenCalled();
    expect(appendEntry).toHaveBeenCalledWith(LOGIN_ENTRY_TYPE, {
      user: "aakash",
      method: "api key",
      endpoint: "api.honcho.dev",
      workspace: "claude_code",
      peer: "aakash",
      aiPeer: "pi",
      session: "aakash-demo",
      strategy: "per-directory",
      savedTo: store.path,
      sharedWith: "pi only",
    });
    expect(footer.current.kind).toBe("connected");
  });

  it("saves an OAuth grant and notes, after the fact, a sign-in through the honcho-cli client", async () => {
    const { runtime, store, appendEntry } = fakeRuntime();
    const { ctx } = fakeCtx();
    await runLogin(
      ctx,
      runtime,
      "device",
      fakeDeps({
        chooseClient: vi.fn(async () => ({
          clientId: "honcho-cli",
          note: 'The approval page will say "Honcho CLI".',
        })),
      }),
    );
    expect(store.saveGrant).toHaveBeenCalledWith(TOKEN, "honcho-cli", runtime.settings.baseUrl);
    expect(appendEntry).toHaveBeenCalledWith(
      LOGIN_ENTRY_TYPE,
      expect.objectContaining({
        method: "oauth",
        sharedWith: "shared with the honcho CLI",
        note: "Signed in with the honcho-cli client.",
      }),
    );
  });

  it("adds no note for pi's own OAuth client", async () => {
    const { runtime, appendEntry } = fakeRuntime();
    const { ctx } = fakeCtx();
    await runLogin(ctx, runtime, "device", fakeDeps());
    const [, entry] = appendEntry.mock.calls[0] ?? [];
    expect(entry).toMatchObject({ method: "oauth" });
    expect(entry).not.toHaveProperty("note");
  });

  it("derives the session name when the reconnect fails, and says why", async () => {
    const { runtime, appendEntry } = fakeRuntime({
      afterRestart: (rt) => {
        rt.phase = "unreachable";
        rt.active = false;
        rt.connection = undefined;
      },
    });
    const { ctx, ui } = fakeCtx();
    await runLogin(ctx, runtime, "device", fakeDeps());
    expect(appendEntry).toHaveBeenCalledWith(
      LOGIN_ENTRY_TYPE,
      expect.objectContaining({ session: "aakash-demo" }),
    );
    expect(ui.notify).toHaveBeenCalledWith(
      "honcho: api.honcho.dev is unreachable; Honcho memory is paused.",
      "warning",
    );
  });

  it("warns when HONCHO_API_KEY still wins after the login", async () => {
    const { runtime } = fakeRuntime({
      afterRestart: (rt) => (rt.credential = { source: "env", token: "t" }),
    });
    const { ctx, ui } = fakeCtx();
    await runLogin(ctx, runtime, "device", fakeDeps());
    expect(ui.notify).toHaveBeenCalledWith(
      "honcho: HONCHO_API_KEY in your environment still takes precedence over this login.",
      "warning",
    );
  });

  it("cancelling saves nothing and restores the footer", async () => {
    const { runtime, store, footer, restart } = fakeRuntime();
    const { ctx, captured, ui } = fakeCtx();
    const done = runLogin(
      ctx,
      runtime,
      "device",
      fakeDeps({ pollDeviceToken: pollUntil(new Promise(() => {})) }),
    );
    await flush();
    expect(footer.current.kind).toBe("signing-in");
    captured.view?.handleInput("\x1b");
    await done;
    expect(store.saveGrant).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(footer.current.kind).toBe("signed-out");
    expect(ui.notify).toHaveBeenCalledWith("honcho: sign-in cancelled. Nothing was saved.", "info");
  });

  it("reports a failed flow as an error and saves nothing", async () => {
    const { runtime, store } = fakeRuntime();
    const { ctx, ui } = fakeCtx();
    await runLogin(
      ctx,
      runtime,
      "device",
      fakeDeps({
        pollDeviceToken: vi.fn(async () => Promise.reject(new OAuthError("expired_token"))),
      }),
    );
    expect(store.saveGrant).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(
      "honcho: The code expired before it was approved. Run /honcho login to get a new one.",
      "error",
    );
  });

  it("refuses to start when the config file is not valid JSON", async () => {
    const store = fakeStore();
    writeFileSync(store.path, "{ not json");
    const { runtime } = fakeRuntime({ store });
    const { ctx, ui } = fakeCtx();
    await runLogin(ctx, runtime, undefined, fakeDeps());
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/is not valid JSON/), "error");
  });

  it("writes hosts.pi.apiKey with a real store, leaving the shared key alone", async () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ apiKey: "root-key" }));
    const { runtime } = fakeRuntime({ store: new CredentialStore({ path, env: {} }) });
    const { ctx, captured } = fakeCtx();
    const done = runLogin(ctx, runtime, "key", fakeDeps());
    captured.view?.handleInput("hch-v3-goodkey1234");
    captured.view?.handleInput("\r");
    await done;
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      apiKey: "root-key",
      hosts: { pi: { apiKey: "hch-v3-goodkey1234" } },
    });
  });

  it("needs the TUI in print mode", async () => {
    const { runtime } = fakeRuntime();
    const { ctx, ui } = fakeCtx("print");
    await runLogin(ctx, runtime, undefined, fakeDeps());
    expect(ui.notify).toHaveBeenCalledWith(
      "honcho: /honcho login needs the interactive TUI.",
      "warning",
    );
    expect(ui.custom).not.toHaveBeenCalled();
  });

  it("falls back to pi's dialogs in RPC mode", async () => {
    const { runtime, store } = fakeRuntime();
    const { ctx, ui } = fakeCtx("rpc", {
      select: vi.fn(async () => "API key"),
      input: vi.fn(async () => " hch-v3-goodkey1234 "),
    });
    await runLogin(ctx, runtime, undefined, fakeDeps({ discover: vi.fn(async () => null) }));
    expect(ui.select).toHaveBeenCalledWith("Sign in to Honcho (api.honcho.dev)", ["API key"]);
    expect(store.savePiKey).toHaveBeenCalledWith("hch-v3-goodkey1234");
    expect(ui.notify).toHaveBeenCalledWith("honcho: signed in to api.honcho.dev as aakash", "info");
  });

  it("RPC device sign-in can be cancelled from the dialog", async () => {
    const { runtime, store } = fakeRuntime();
    const { ctx, ui } = fakeCtx("rpc", { select: vi.fn(async () => "Cancel sign-in") });
    await runLogin(
      ctx,
      runtime,
      "device",
      fakeDeps({ pollDeviceToken: pollUntil(new Promise(() => {})) }),
    );
    expect(store.saveGrant).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(
      "honcho: open https://app.honcho.dev/device and enter WDJB-MJHT",
      "info",
    );
    expect(ui.notify).toHaveBeenCalledWith("honcho: sign-in cancelled. Nothing was saved.", "info");
  });
});

describe("runLogout", () => {
  const signedOut = (rt: Record<string, unknown>) => {
    rt.credential = null;
    rt.phase = "signed-out";
    rt.active = false;
  };

  it("says there is nothing to do when not signed in", async () => {
    const { runtime, store, restart } = fakeRuntime();
    const { ctx, ui } = fakeCtx();
    await runLogout(ctx, runtime);
    expect(ui.notify).toHaveBeenCalledWith(
      "honcho: not signed in, so there is nothing to sign out of.",
      "info",
    );
    expect(store.removePiKey).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("tells the user to unset HONCHO_API_KEY", async () => {
    const { runtime, store } = fakeRuntime({ credential: { source: "env", token: "t" } });
    const { ctx, ui } = fakeCtx();
    await runLogout(ctx, runtime);
    expect(ui.notify).toHaveBeenCalledWith(
      "honcho: pi is using HONCHO_API_KEY from your environment. Unset it to sign out.",
      "warning",
    );
    expect(store.removePiKey).not.toHaveBeenCalled();
    expect(store.removeGrant).not.toHaveBeenCalled();
  });

  it("never removes the shared apiKey and suggests /honcho off", async () => {
    const { runtime, store, restart } = fakeRuntime({
      credential: { source: "shared-key", token: "t" },
    });
    const { ctx, ui } = fakeCtx();
    await runLogout(ctx, runtime);
    const [message, type] = ui.notify.mock.calls[0] ?? [];
    expect(type).toBe("warning");
    expect(message).toContain(`pi uses the apiKey in ${store.path}`);
    expect(message).toContain("/honcho off");
    expect(store.removePiKey).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("removes pi's own key and reports the shared key it falls back to", async () => {
    const { runtime, store, restart } = fakeRuntime({
      credential: { source: "pi-key", token: "t" },
      afterRestart: (rt) => (rt.credential = { source: "shared-key", token: "s" }),
    });
    const { ctx, ui } = fakeCtx();
    await runLogout(ctx, runtime);
    expect(store.removePiKey).toHaveBeenCalled();
    expect(restart).toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(
      `honcho: signed out. pi now uses the shared apiKey in ${store.path}.`,
      "info",
    );
  });

  it("revokes the OAuth grant only after confirming", async () => {
    const { runtime, store } = fakeRuntime({
      credential: { source: "oauth", token: "t" },
      afterRestart: signedOut,
    });
    const declined = fakeCtx("tui", { confirm: vi.fn(async () => false) });
    await runLogout(declined.ctx, runtime);
    expect(declined.ui.confirm).toHaveBeenCalledWith(
      "Sign out of Honcho?",
      "This revokes the sign-in for pi and the honcho CLI, which share it.",
    );
    expect(store.removeGrant).not.toHaveBeenCalled();

    const { ctx, ui } = fakeCtx();
    await runLogout(ctx, runtime);
    expect(store.removeGrant).toHaveBeenCalledWith(runtime.settings.baseUrl);
    expect(ui.notify).toHaveBeenCalledWith("honcho: signed out of Honcho.", "info");
  });

  it("reports a save failure instead of restarting", async () => {
    const store = {
      ...fakeStore(),
      removePiKey: vi.fn(() => {
        throw new Error("disk full");
      }),
    };
    const { runtime, restart } = fakeRuntime({
      store,
      credential: { source: "pi-key", token: "t" },
    });
    const { ctx, ui } = fakeCtx();
    await runLogout(ctx, runtime);
    expect(ui.notify).toHaveBeenCalledWith("honcho: could not sign out (disk full)", "error");
    expect(restart).not.toHaveBeenCalled();
  });

  it("removes only hosts.pi.apiKey from a real config", async () => {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        apiKey: "root-key",
        hosts: { pi: { apiKey: "pi-key", workspace: "claude_code" } },
      }),
    );
    const realStore = new CredentialStore({ path, env: {} });
    const { runtime } = fakeRuntime({
      store: realStore,
      credential: realStore.resolve("https://api.honcho.dev"),
      afterRestart: (rt) => (rt.credential = realStore.resolve("https://api.honcho.dev")),
    });
    const { ctx, ui } = fakeCtx();
    await runLogout(ctx, runtime);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      apiKey: "root-key",
      hosts: { pi: { workspace: "claude_code" } },
    });
    expect(ui.notify).toHaveBeenCalledWith(
      `honcho: signed out. pi now uses the shared apiKey in ${path}.`,
      "info",
    );
  });
});
