import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ensureHostBlock, updateConfig } from "./config-file.js";
import { errorMessage } from "./honcho.js";
import type { HonchoRuntime } from "./runtime.js";
import { openConfig } from "./ui/config.js";
import { STATUS_ENTRY_TYPE } from "./ui/entries.js";
import { runLogin, runLogout } from "./ui/login.js";
import type { LoginMethod } from "./ui/login.js";
import { collectStatus } from "./ui/status-panel.js";

const SUBCOMMANDS: AutocompleteItem[] = [
  { value: "login", label: "login", description: "Sign in: browser, device code or API key" },
  { value: "login browser", label: "login browser", description: "Sign in through your browser" },
  {
    value: "login device",
    label: "login device",
    description: "Sign in with a code on any device",
  },
  { value: "login key", label: "login key", description: "Paste an API key" },
  { value: "logout", label: "logout", description: "Clear the saved login" },
  { value: "config", label: "config", description: "Honcho settings" },
  { value: "on", label: "on", description: "Turn Honcho on for pi" },
  { value: "off", label: "off", description: "Turn Honcho off for pi" },
  { value: "status", label: "status", description: "Connection, memory and settings" },
];

const LOGIN_METHODS: Record<string, LoginMethod> = {
  browser: "browser",
  device: "device",
  code: "device",
  key: "key",
  "api-key": "key",
  apikey: "key",
};

export const setEnabled = (enabled: boolean, path: string): void => {
  updateConfig((config) => {
    ensureHostBlock(config).enabled = enabled;
  }, path);
};

const toggle = async (runtime: HonchoRuntime, ctx: ExtensionCommandContext, enabled: boolean) => {
  try {
    setEnabled(enabled, runtime.store.path);
  } catch (error) {
    ctx.ui.notify(`honcho: could not save the setting (${errorMessage(error)})`, "error");
    return;
  }
  await runtime.restart();
  if (!enabled) {
    ctx.ui.notify("honcho: off for pi. Nothing is injected or saved until /honcho on.", "info");
  } else if (runtime.settings.enabled) {
    ctx.ui.notify(
      runtime.active ? "honcho: on" : `honcho: on. ${runtime.describeUnavailable()}`,
      "info",
    );
  } else {
    ctx.ui.notify(
      "honcho: still off because HONCHO_ENABLED=false is set in your environment.",
      "warning",
    );
  }
};

const showStatus = async (runtime: HonchoRuntime, ctx: ExtensionCommandContext) => {
  const snapshot = await runtime.footer.working("checking status", () => collectStatus(runtime));
  if (ctx.mode === "tui") {
    runtime.pi.appendEntry(STATUS_ENTRY_TYPE, snapshot);
  } else {
    ctx.ui.notify(`honcho: ${snapshot.state} · ${snapshot.endpoint}`, "info");
  }
};

export const registerCommands = (pi: ExtensionAPI, runtime: HonchoRuntime): void => {
  pi.registerCommand("honcho", {
    description: "Honcho memory: status, login, logout, config, on, off",
    getArgumentCompletions: (prefix) => {
      const p = prefix.trim().toLowerCase();
      const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(p));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      switch (sub.toLowerCase()) {
        case "":
        case "status":
          await showStatus(runtime, ctx);
          return;
        case "login": {
          const method = rest[0] ? LOGIN_METHODS[rest[0].toLowerCase()] : undefined;
          if (rest[0] && !method) {
            ctx.ui.notify(
              `honcho: unknown login method "${rest[0]}". Use browser, device or key.`,
              "warning",
            );
            return;
          }
          await runLogin(ctx, runtime, method);
          return;
        }
        case "logout":
          await runLogout(ctx, runtime);
          return;
        case "config":
        case "settings":
          await openConfig(ctx, runtime);
          return;
        case "on":
          await toggle(runtime, ctx, true);
          return;
        case "off":
          await toggle(runtime, ctx, false);
          return;
        default:
          ctx.ui.notify(
            `honcho: unknown command "${sub}". Try /honcho, login, logout, config, on or off.`,
            "warning",
          );
      }
    },
  });
};
