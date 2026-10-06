import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { AuthenticationError, PermissionDeniedError } from "@honcho-ai/sdk";
import {
  OAuthError,
  chooseClient,
  discover,
  openBrowser,
  pollDeviceToken,
  requestDeviceCode,
  startBrowserLogin,
} from "../../auth/oauth.js";
import type { AuthServer, TokenResponse } from "../../auth/oauth.js";
import { abortable, classify, errorMessage, probe } from "../../honcho.js";
import { METHOD_OPTIONS, TITLES } from "./screens.js";
import type { LoginMethod, MethodOption } from "./screens.js";
import { ApiKeyScreen, BrowserScreen, BusyScreen, DeviceScreen, PickerScreen } from "./view.js";
import type { LoginView } from "./view.js";

type Env = Record<string, string | undefined>;

/** Network, clipboard and browser seams; tests swap them for fakes. */
export interface LoginDeps {
  discover: (baseUrl: string) => Promise<AuthServer | null>;
  chooseClient: typeof chooseClient;
  startBrowserLogin: typeof startBrowserLogin;
  requestDeviceCode: typeof requestDeviceCode;
  pollDeviceToken: typeof pollDeviceToken;
  openBrowser: (url: string) => void;
  copy: (text: string) => Promise<void>;
  probe: (opts: { token: string; baseUrl: string; workspace: string }) => Promise<number>;
  env: Env;
  now: () => number;
}

export const defaultLoginDeps = (): LoginDeps => ({
  discover: (baseUrl) => discover(baseUrl),
  chooseClient,
  startBrowserLogin,
  requestDeviceCode,
  pollDeviceToken,
  openBrowser,
  copy: copyToClipboard,
  probe,
  env: process.env,
  now: Date.now,
});

export type LoginResult =
  | { kind: "oauth"; token: TokenResponse; clientId: string }
  | { kind: "key"; key: string }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

/** What the flow needs from the runtime. */
export interface LoginTarget {
  baseUrl: string;
  /** Host label, e.g. `api.honcho.dev`. */
  endpoint: string;
  workspace: string;
  registeredClientId(): string | undefined;
  rememberClient(clientId: string): void;
  /** Footer shows "signing in…" while true. */
  setSigningIn(on: boolean): void;
}

export const isCancelled = (error: unknown): boolean =>
  (error as { name?: string } | null)?.name === "AbortError" ||
  (error instanceof OAuthError && error.code === "cancelled");

/** SSH sessions usually can't open a local browser. */
const preferredMethod = (env: Env): LoginMethod =>
  env.SSH_CONNECTION || env.SSH_TTY ? "device" : "browser";

export const methodOptions = (as: AuthServer | null): MethodOption[] =>
  METHOD_OPTIONS.filter((o) =>
    as ? o.method !== "device" || Boolean(as.deviceAuthorizationEndpoint) : o.method === "key",
  );

export const describeKeyError = (error: unknown, endpoint: string, workspace: string): string => {
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    if (/permissioned|unauthorized access/i.test(error.message)) {
      return `This key is valid but not for workspace ${workspace}. Change the workspace in /honcho config.`;
    }
    return `${endpoint} rejected this key (${error.status}). Check it was copied in full.`;
  }
  switch (classify(error)) {
    case "unreachable":
      return `Couldn't reach ${endpoint}: ${errorMessage(error)}`;
    case "rate-limited":
      return `${endpoint} is rate limiting requests. Wait a minute and try again.`;
    default:
      return `Couldn't check the key: ${errorMessage(error)}`;
  }
};

/** Undefined when the key works for the configured workspace, else what to show under the field. */
export const checkKey = async (
  key: string,
  target: Pick<LoginTarget, "baseUrl" | "endpoint" | "workspace">,
  deps: Pick<LoginDeps, "probe">,
): Promise<string | undefined> => {
  try {
    await deps.probe({ token: key, baseUrl: target.baseUrl, workspace: target.workspace });
    return undefined;
  } catch (error) {
    return describeKeyError(error, target.endpoint, target.workspace);
  }
};

export const describeLoginError = (error: unknown, endpoint: string): string => {
  if (error instanceof OAuthError) {
    switch (error.code) {
      case "access_denied":
        return "Sign-in was denied on the approval page.";
      case "expired_token":
        return "The code expired before it was approved. Run /honcho login to get a new one.";
      case "rate_limited":
        return "Too many sign-in attempts. Wait a minute and try again.";
      case "timeout":
        return "No approval within 5 minutes. Run /honcho login to try again, or sign in with an API key.";
      case "state_mismatch":
        return "That URL belongs to a different sign-in attempt. Run /honcho login to start over.";
      case "connection_error":
        return `Couldn't reach ${endpoint}${error.description ? `: ${error.description}` : ""}.`;
      case "unsupported_grant_type":
        return `Device sign-in isn't available on ${endpoint}. Try /honcho login browser or /honcho login key.`;
      case "registration_unavailable":
        return `Browser sign-in isn't available on ${endpoint}. Try /honcho login device or /honcho login key.`;
      default:
        return `Sign-in failed: ${error.description ?? error.code}`;
    }
  }
  if (classify(error) === "unreachable") {
    return `Couldn't reach ${endpoint}: ${errorMessage(error)}`;
  }
  return `Sign-in failed: ${errorMessage(error)}`;
};

/** Resolves with the callback's value, or rejects with an AbortError when the view is cancelled. */
const until = <T>(view: LoginView, bind: (resolve: (value: T) => void) => void): Promise<T> =>
  abortable(new Promise<T>(bind), view.signal);

const keyFlow = async (
  view: LoginView,
  target: LoginTarget,
  deps: LoginDeps,
): Promise<LoginResult> => {
  const screen = new ApiKeyScreen(target.endpoint, Boolean(deps.env.HONCHO_API_KEY));
  view.show(screen);
  for (;;) {
    const key = await until<string>(view, (resolve) => {
      screen.onSubmit = resolve;
    });
    screen.setChecking();
    target.setSigningIn(true);
    const problem = await abortable(checkKey(key, target, deps), view.signal);
    if (!problem) {
      return { kind: "key", key };
    }
    target.setSigningIn(false);
    screen.setError(problem);
    view.show(screen);
  }
};

const browserFlow = async (
  view: LoginView,
  as: AuthServer,
  target: LoginTarget,
  deps: LoginDeps,
): Promise<LoginResult> => {
  const { signal } = view;
  view.show(new BusyScreen(TITLES.browser, "Preparing browser sign-in…"));
  const remembered = target.registeredClientId();
  const choice = await abortable(
    deps.chooseClient(as, "browser", { registeredClientId: remembered }),
    signal,
  );
  // A registered client is kept even if this attempt is cancelled, so retries reuse it instead of registering again
  if (choice.registered && choice.clientId !== remembered) {
    target.rememberClient(choice.clientId);
  }
  const starting = deps.startBrowserLogin(as, choice.clientId);
  signal.addEventListener(
    "abort",
    () =>
      void starting.then(
        (login) => login.cancel(),
        () => {},
      ),
    { once: true },
  );
  const login = await abortable(starting, signal);
  try {
    deps.openBrowser(login.authorizeUrl);
    target.setSigningIn(true);
    view.show(
      new BrowserScreen(
        { url: login.authorizeUrl, port: login.port, deadline: login.deadline },
        { copy: deps.copy, submitRedirectUrl: (url) => login.submitRedirectUrl(url) },
        deps.now,
        deps.env,
      ),
    );
    const token = await abortable(login.result, signal);
    return { kind: "oauth", token, clientId: choice.clientId };
  } finally {
    login.cancel();
  }
};

const deviceFlow = async (
  view: LoginView,
  as: AuthServer,
  target: LoginTarget,
  deps: LoginDeps,
): Promise<LoginResult> => {
  const { signal } = view;
  view.show(new BusyScreen(TITLES.device, `Requesting a code from ${target.endpoint}…`));
  const choice = await abortable(deps.chooseClient(as, "device"), signal);
  const code = await deps.requestDeviceCode(as, choice.clientId, { signal });
  target.setSigningIn(true);
  view.show(
    new DeviceScreen(
      {
        verificationUri: code.verification_uri,
        verificationUriComplete: code.verification_uri_complete,
        userCode: code.user_code,
        expiresAt: deps.now() + code.expires_in * 1000,
        note: choice.note,
      },
      { copy: deps.copy, open: deps.openBrowser },
      deps.now,
      deps.env,
    ),
  );
  const token = await deps.pollDeviceToken(as, choice.clientId, code, { signal });
  return { kind: "oauth", token, clientId: choice.clientId };
};

const pickAndRun = async (
  view: LoginView,
  target: LoginTarget,
  method: LoginMethod | undefined,
  deps: LoginDeps,
): Promise<LoginResult> => {
  if (method === "key") {
    return keyFlow(view, target, deps);
  }
  const picker = new PickerScreen(target.endpoint, Boolean(deps.env.HONCHO_API_KEY));
  view.show(method ? new BusyScreen(TITLES[method], `Checking ${target.endpoint}…`) : picker);
  const as = await abortable(deps.discover(target.baseUrl), view.signal);
  let chosen: LoginMethod | undefined = method;
  // An explicit browser or device request falls back to the picker when the endpoint has no OAuth
  if (!chosen || !as) {
    picker.setOptions(methodOptions(as), Boolean(as), as ? preferredMethod(deps.env) : "key");
    view.show(picker);
    chosen = await until<LoginMethod>(view, (resolve) => {
      picker.onSelect = resolve;
    });
  }
  if (!as || chosen === "key") {
    return keyFlow(view, target, deps);
  }
  return chosen === "browser"
    ? browserFlow(view, as, target, deps)
    : deviceFlow(view, as, target, deps);
};

/** Drives the TUI flow inside `view`; never rejects. */
export const driveLogin = async (
  view: LoginView,
  target: LoginTarget,
  method: LoginMethod | undefined,
  deps: LoginDeps,
): Promise<LoginResult> => {
  try {
    return await pickAndRun(view, target, method, deps);
  } catch (error) {
    if (view.signal.aborted || isCancelled(error)) {
      return { kind: "cancelled" };
    }
    return { kind: "failed", message: describeLoginError(error, target.endpoint) };
  }
};
