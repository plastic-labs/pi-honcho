import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Credential } from "../auth/credentials.js";
import { CLI_CLIENT_ID } from "../auth/oauth.js";
import { displayPath, readConfigStrict } from "../config-file.js";
import { errorMessage } from "../honcho.js";
import type { HonchoRuntime } from "../runtime.js";
import { deriveSessionName, sessionsMap } from "../session-name.js";
import { LOGIN_ENTRY_TYPE } from "./entries.js";
import type { LoginEntryData } from "./entries.js";
import { defaultLoginDeps, driveLogin } from "./login/flow.js";
import type { LoginDeps, LoginResult, LoginTarget } from "./login/flow.js";
import { plainLogin } from "./login/plain.js";
import type { LoginMethod } from "./login/screens.js";
import { LoginView } from "./login/view.js";
import type { FooterState } from "./status.js";

export type { LoginMethod } from "./login/screens.js";

type Notify = ExtensionCommandContext["ui"]["notify"];

/** Shows "signing in…" in the footer and puts back whatever the runtime's phase says afterwards. */
const footerHold = (runtime: HonchoRuntime) => {
  const previous: FooterState = runtime.footer.base;
  return {
    hold: () => runtime.footer.set({ kind: "signing-in" }),
    release: () => {
      if (runtime.footer.current.kind !== "signing-in") {
        return;
      }
      if (runtime.phase === "idle") {
        runtime.footer.set(previous);
      } else {
        runtime.setPhase(runtime.phase);
      }
    },
  };
};

const loginTarget = (
  runtime: HonchoRuntime,
  footer: ReturnType<typeof footerHold>,
): LoginTarget => ({
  baseUrl: runtime.settings.baseUrl,
  endpoint: runtime.host,
  workspace: runtime.settings.workspace,
  registeredClientId: () => runtime.store.registeredClientId(),
  rememberClient: (clientId) => runtime.store.rememberClient(clientId),
  setSigningIn: (on) => (on ? footer.hold() : footer.release()),
});

const sessionFor = (ctx: ExtensionCommandContext, runtime: HonchoRuntime): string =>
  runtime.connection?.sessionName ??
  deriveSessionName({
    strategy: runtime.settings.sessionStrategy,
    cwd: ctx.cwd,
    peerName: runtime.settings.peerName,
    sessions: sessionsMap(runtime.file),
    instanceId: ctx.sessionManager.getSessionId(),
  });

const loginEntry = (
  ctx: ExtensionCommandContext,
  runtime: HonchoRuntime,
  result: { kind: "oauth"; clientId: string } | { kind: "key" },
): LoginEntryData => {
  const { settings } = runtime;
  const entry: LoginEntryData = {
    user: settings.peerName,
    method: result.kind === "oauth" ? "oauth" : "api key",
    endpoint: runtime.host,
    workspace: settings.workspace,
    peer: settings.peerName,
    aiPeer: settings.aiPeer,
    session: sessionFor(ctx, runtime),
    strategy: settings.sessionStrategy,
    savedTo: displayPath(runtime.store.path),
    sharedWith: result.kind === "oauth" ? "shared with the honcho CLI" : "pi only",
  };
  if (result.kind === "oauth" && result.clientId === CLI_CLIENT_ID) {
    entry.note = "Signed in with the honcho-cli client.";
  }
  return entry;
};

/** Saves the credential, reconnects, then records the signed-in block. */
const completeLogin = async (
  ctx: ExtensionCommandContext,
  runtime: HonchoRuntime,
  result: LoginResult,
  footer: ReturnType<typeof footerHold>,
): Promise<void> => {
  const notify: Notify = (message, type) => runtime.safe(() => ctx.ui.notify(message, type));
  if (result.kind === "cancelled") {
    footer.release();
    notify("honcho: sign-in cancelled. Nothing was saved.", "info");
    return;
  }
  if (result.kind === "failed") {
    footer.release();
    notify(`honcho: ${result.message}`, "error");
    return;
  }
  try {
    if (result.kind === "oauth") {
      runtime.store.saveGrant(result.token, result.clientId, runtime.settings.baseUrl);
    } else {
      runtime.store.savePiKey(result.key);
    }
  } catch (error) {
    footer.release();
    notify(`honcho: could not save the sign-in (${errorMessage(error)})`, "error");
    return;
  }
  footer.hold();
  await runtime.restart();
  footer.release();
  const usable = runtime.active || runtime.phase === "off" || runtime.phase === "unreachable";
  if (usable) {
    const entry = loginEntry(ctx, runtime, result);
    if (ctx.mode === "tui") {
      runtime.safe(() => runtime.pi.appendEntry(LOGIN_ENTRY_TYPE, entry));
    } else {
      notify(`honcho: signed in to ${entry.endpoint} as ${entry.user}`, "info");
    }
  }
  if (!runtime.active) {
    notify(`honcho: ${runtime.describeUnavailable()}`, usable ? "warning" : "error");
  }
  if (runtime.credential?.source === "env") {
    notify(
      "honcho: HONCHO_API_KEY in your environment still takes precedence over this login.",
      "warning",
    );
  }
};

/** `/honcho login [browser|device|key]`. */
export const runLogin = async (
  ctx: ExtensionCommandContext,
  runtime: HonchoRuntime,
  method?: LoginMethod,
  deps: LoginDeps = defaultLoginDeps(),
): Promise<void> => {
  try {
    readConfigStrict(runtime.store.path);
  } catch (error) {
    ctx.ui.notify(`honcho: ${errorMessage(error)}. Fix it, then run /honcho login again.`, "error");
    return;
  }
  const footer = footerHold(runtime);
  const target = loginTarget(runtime, footer);
  if (ctx.mode !== "tui") {
    if (!ctx.hasUI) {
      ctx.ui.notify("honcho: /honcho login needs the interactive TUI.", "warning");
      return;
    }
    await completeLogin(ctx, runtime, await plainLogin(ctx.ui, target, method, deps), footer);
    return;
  }
  const result = await ctx.ui.custom<LoginResult>((tui, theme, _keybindings, done) => {
    const view = new LoginView(tui, theme, deps.now);
    void (async () => done(await driveLogin(view, target, method, deps)))();
    return view;
  });
  await completeLogin(ctx, runtime, result ?? { kind: "cancelled" }, footer);
};

const signedOutMessage = (next: Credential | null, configPath: string): string => {
  switch (next?.source) {
    case undefined:
      return "honcho: signed out of Honcho.";
    case "shared-key":
      return `honcho: signed out. pi now uses the shared apiKey in ${configPath}.`;
    case "oauth":
      return "honcho: removed pi's key. pi now uses the Honcho sign-in it shares with the honcho CLI.";
    case "env":
      return "honcho: signed out. pi still uses HONCHO_API_KEY from your environment.";
    case "pi-key":
      return "honcho: signed out.";
  }
};

/** `/honcho logout`: removes only what pi can safely remove. */
export const runLogout = async (
  ctx: ExtensionCommandContext,
  runtime: HonchoRuntime,
): Promise<void> => {
  const configPath = displayPath(runtime.store.path);
  try {
    switch (runtime.credential?.source) {
      case undefined:
        ctx.ui.notify("honcho: not signed in, so there is nothing to sign out of.", "info");
        return;
      case "env":
        ctx.ui.notify(
          "honcho: pi is using HONCHO_API_KEY from your environment. Unset it to sign out.",
          "warning",
        );
        return;
      case "shared-key":
        ctx.ui.notify(
          `honcho: pi uses the apiKey in ${configPath}, which other Honcho tools share, so pi won't remove it. Run /honcho off to stop using Honcho in pi.`,
          "warning",
        );
        return;
      case "pi-key":
        runtime.store.removePiKey();
        break;
      case "oauth": {
        const ok = await ctx.ui.confirm(
          "Sign out of Honcho?",
          "This revokes the sign-in for pi and the honcho CLI, which share it.",
        );
        if (!ok) {
          return;
        }
        await runtime.footer.working("signing out", () =>
          runtime.store.removeGrant(runtime.settings.baseUrl),
        );
        break;
      }
    }
  } catch (error) {
    ctx.ui.notify(`honcho: could not sign out (${errorMessage(error)})`, "error");
    return;
  }
  await runtime.restart();
  runtime.safe(() => ctx.ui.notify(signedOutMessage(runtime.credential, configPath), "info"));
};
