import {
  SkillInvocationMessageComponent,
  UserMessageComponent,
  getMarkdownTheme,
  parseSkillBlock,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { fit } from "./render/layout.js";
import { FRAME_MS, SPINNER, formatSeconds } from "./status.js";

export const PENDING_WIDGET_KEY = "honcho-pending";

/** `◐ honcho  checking memory · 1.2s`, in the slot the turn card will take. */
export const formatPendingLine = (
  label: string,
  elapsedMs: number,
  frame: number,
  width: number,
  theme: Theme,
  pad = 1,
): string => {
  const spinner = SPINNER[frame % SPINNER.length] ?? "◐";
  const line = `${" ".repeat(pad)}${theme.fg("accent", `${spinner} honcho`)}${theme.fg("dim", `  ${label} · ${formatSeconds(elapsedMs)}`)}`;
  return fit(line, width - pad);
};

class PendingLine implements Component {
  private readonly since = Date.now();
  private frame = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly theme: Theme;
  private readonly label: string;

  constructor(tui: TUI, theme: Theme, label: string) {
    this.theme = theme;
    this.label = label;
    this.timer = setInterval(() => {
      this.frame += 1;
      tui.requestRender();
    }, FRAME_MS);
    this.timer.unref?.();
  }

  render(width: number): string[] {
    return [formatPendingLine(this.label, Date.now() - this.since, this.frame, width, this.theme)];
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }
}

/** The prompt as pi will render it, so the swap to the real message doesn't shift the transcript. */
const promptComponents = (prompt: string): Component[] => {
  const markdown = getMarkdownTheme();
  const skill = parseSkillBlock(prompt);
  if (!skill) {
    return [new UserMessageComponent(prompt, markdown)];
  }
  const parts: Component[] = [new SkillInvocationMessageComponent(skill, markdown)];
  if (skill.userMessage) {
    parts.push(new Spacer(1), new UserMessageComponent(skill.userMessage, markdown));
  }
  return parts;
};

class PendingPrompt extends Container {
  private line: PendingLine | undefined;
  private readonly tail: Component[];
  private readonly tui: TUI;

  constructor(tui: TUI, theme: Theme, prompt: string, label: string) {
    super();
    this.tui = tui;
    for (const part of promptComponents(prompt)) {
      this.addChild(part);
    }
    this.line = new PendingLine(tui, theme, label);
    this.tail = [new Spacer(1), this.line, new Spacer(1)];
    for (const part of this.tail) {
      this.addChild(part);
    }
  }

  /** Drops the spinner once Honcho is done but pi hasn't rendered the message yet. */
  settle(): void {
    this.line?.dispose();
    this.line = undefined;
    for (const part of this.tail.slice(0, -1)) {
      this.removeChild(part);
    }
    this.tui.requestRender();
  }

  dispose(): void {
    this.line?.dispose();
  }
}

/**
 * Shows the submitted prompt and a working line above the editor while `before_agent_start`
 * blocks, since pi only renders the user message once every handler has returned.
 */
export class PendingTurn {
  private widget: PendingPrompt | undefined;
  private ctx: ExtensionContext | undefined;

  show(ctx: ExtensionContext | undefined, prompt: string, label: string): void {
    this.clear();
    if (!ctx || ctx.mode !== "tui" || !prompt.trim()) {
      return;
    }
    this.ctx = ctx;
    this.apply((ui) =>
      ui.setWidget(PENDING_WIDGET_KEY, (tui, theme) => {
        this.widget = new PendingPrompt(tui, theme, prompt, label);
        return this.widget;
      }),
    );
  }

  settle(): void {
    this.widget?.settle();
  }

  clear(): void {
    if (!this.ctx) {
      return;
    }
    this.apply((ui) => ui.setWidget(PENDING_WIDGET_KEY, undefined));
    this.widget = undefined;
    this.ctx = undefined;
  }

  private apply(fn: (ui: ExtensionContext["ui"]) => void): void {
    try {
      if (this.ctx) {
        fn(this.ctx.ui);
      }
    } catch {
      // The ctx can go stale after a session replacement
      this.widget = undefined;
      this.ctx = undefined;
    }
  }
}
