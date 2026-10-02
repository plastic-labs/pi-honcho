import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ConfigParseError, displayPath } from "../config-file.js";
import { errorMessage } from "../honcho.js";
import type { HonchoRuntime } from "../runtime.js";
import { ConfigModel, TEMPLATE_EDITOR_TITLE, buildRows, saveTemplate } from "./config/model.js";
import { ConfigOverlay } from "./config/overlay.js";
import type { OverlayResult, ViewState } from "./config/overlay.js";
import { runLogin, runLogout } from "./login.js";

/** Rows kept free for pi's footer while the settings replace the editor. */
const FOOTER_ROWS = 6;

const gitBranch = async (runtime: HonchoRuntime, cwd: string): Promise<string | undefined> => {
  const result = await runtime.pi
    .exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 3_000 })
    .catch(() => undefined);
  return result && result.code === 0 ? result.stdout.trim() || undefined : undefined;
};

const unreadable = (path: string, error: unknown): string =>
  error instanceof ConfigParseError
    ? `honcho: ${displayPath(path)} is not valid JSON. Fix it, then run /honcho config again.`
    : `honcho: could not read ${displayPath(path)} (${errorMessage(error)})`;

const editTemplate = async (ctx: ExtensionCommandContext, model: ConfigModel): Promise<void> => {
  const text = await ctx.ui.editor(TEMPLATE_EDITOR_TITLE, model.settings.injection.template);
  if (text === undefined) {
    return;
  }
  try {
    saveTemplate(model, text);
  } catch (error) {
    ctx.ui.notify(`honcho: could not save the chat prompt (${errorMessage(error)})`, "error");
  }
};

/** `/honcho config`: every change is saved as it is made; the runtime picks them up on close. */
export const openConfig = async (
  ctx: ExtensionCommandContext,
  runtime: HonchoRuntime,
): Promise<void> => {
  const { path } = runtime.store;
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      `honcho: /honcho config needs the interactive terminal. Settings live in ${displayPath(path)}.`,
      "warning",
    );
    return;
  }
  let model: ConfigModel;
  try {
    model = new ConfigModel({
      path,
      cwd: ctx.cwd,
      instanceId: ctx.sessionManager.getSessionId(),
      expired: runtime.phase === "expired",
    });
  } catch (error) {
    ctx.ui.notify(unreadable(path, error), "error");
    return;
  }
  model.branch = await gitBranch(runtime, ctx.cwd);

  const rows = buildRows(model);
  const view: ViewState = { selected: 0, scroll: 0, box: 0 };
  let result: OverlayResult | undefined;
  for (;;) {
    result = await ctx.ui.custom<OverlayResult | undefined>(
      (tui, theme, _keybindings, done) =>
        new ConfigOverlay(model, rows, theme, view, {
          maxLines: () => Math.max(10, tui.terminal.rows - FOOTER_ROWS),
          requestRender: () => tui.requestRender(),
          done,
        }),
    );
    if (result?.action !== "template") {
      break;
    }
    await editTemplate(ctx, model);
    try {
      model.reload();
    } catch (error) {
      ctx.ui.notify(unreadable(path, error), "error");
      result = undefined;
      break;
    }
  }

  await runtime.refreshSettings();
  if (result?.action === "login") {
    await runLogin(ctx, runtime);
  } else if (result?.action === "logout") {
    await runLogout(ctx, runtime);
  }
};
