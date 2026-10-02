import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AuthServer } from "../../auth/oauth.js";
import { checkKey, describeLoginError, isCancelled, methodOptions } from "./flow.js";
import type { LoginDeps, LoginResult, LoginTarget } from "./flow.js";
import type { LoginMethod } from "./screens.js";

type Dialogs = Pick<ExtensionUIContext, "select" | "input" | "notify">;

const keyLogin = async (
  ui: Dialogs,
  target: LoginTarget,
  deps: LoginDeps,
): Promise<LoginResult> => {
  const key = (await ui.input(`Honcho API key for ${target.endpoint}`, "hch-v3-…"))?.trim();
  if (!key) {
    return { kind: "cancelled" };
  }
  const problem = await checkKey(key, target, deps);
  return problem ? { kind: "failed", message: problem } : { kind: "key", key };
};

const browserLogin = async (
  ui: Dialogs,
  as: AuthServer,
  target: LoginTarget,
  deps: LoginDeps,
): Promise<LoginResult> => {
  const remembered = target.registeredClientId();
  const choice = await deps.chooseClient(as, "browser", { registeredClientId: remembered });
  if (choice.registered && choice.clientId !== remembered) {
    target.rememberClient(choice.clientId);
  }
  const login = await deps.startBrowserLogin(as, choice.clientId);
  const dialog = new AbortController();
  try {
    deps.openBrowser(login.authorizeUrl);
    ui.notify(`honcho: approve the sign-in in your browser: ${login.authorizeUrl}`, "info");
    // The input closes itself once the loopback callback lands
    void ui
      .input(
        "Approve in the browser, or paste the URL it was redirected to",
        `http://127.0.0.1:${login.port}/callback?code=…`,
        {
          signal: dialog.signal,
        },
      )
      .then((value) => {
        if (dialog.signal.aborted) {
          return;
        }
        if (value?.trim()) {
          login.submitRedirectUrl(value.trim());
        } else {
          login.cancel();
        }
      });
    const token = await login.result;
    return { kind: "oauth", token, clientId: choice.clientId };
  } finally {
    dialog.abort();
    login.cancel();
  }
};

const deviceLogin = async (
  ui: Dialogs,
  as: AuthServer,
  target: LoginTarget,
  deps: LoginDeps,
): Promise<LoginResult> => {
  const choice = await deps.chooseClient(as, "device");
  const polling = new AbortController();
  const code = await deps.requestDeviceCode(as, choice.clientId, { signal: polling.signal });
  const dialog = new AbortController();
  try {
    ui.notify(
      `honcho: open ${code.verification_uri} and enter ${code.user_code}${choice.note ? `. ${choice.note}` : ""}`,
      "info",
    );
    void ui
      .select(`Open ${code.verification_uri} and enter ${code.user_code}`, ["Cancel sign-in"], {
        signal: dialog.signal,
      })
      .then(() => {
        if (!dialog.signal.aborted) {
          polling.abort();
        }
      });
    const token = await deps.pollDeviceToken(as, choice.clientId, code, { signal: polling.signal });
    return { kind: "oauth", token, clientId: choice.clientId };
  } finally {
    dialog.abort();
  }
};

/** RPC fallback built from pi's dialogs: no masking, no live countdown. */
export const plainLogin = async (
  ui: Dialogs,
  target: LoginTarget,
  method: LoginMethod | undefined,
  deps: LoginDeps,
): Promise<LoginResult> => {
  try {
    const as = method === "key" ? null : await deps.discover(target.baseUrl);
    let chosen = method;
    if (!chosen || !as) {
      const options = methodOptions(as);
      if (!as && method && method !== "key") {
        ui.notify(
          `honcho: browser and device sign-in aren't available on ${target.endpoint}.`,
          "warning",
        );
      }
      const label = await ui.select(
        `Sign in to Honcho (${target.endpoint})`,
        options.map((o) => o.label),
      );
      chosen = options.find((o) => o.label === label)?.method;
      if (!chosen) {
        return { kind: "cancelled" };
      }
    }
    if (!as || chosen === "key") {
      return await keyLogin(ui, target, deps);
    }
    return chosen === "browser"
      ? await browserLogin(ui, as, target, deps)
      : await deviceLogin(ui, as, target, deps);
  } catch (error) {
    if (isCancelled(error)) {
      return { kind: "cancelled" };
    }
    return { kind: "failed", message: describeLoginError(error, target.endpoint) };
  }
};
