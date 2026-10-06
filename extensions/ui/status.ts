import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

export const STATUS_KEY = "honcho";
export const SPINNER = ["◐", "◓", "◑", "◒"];
export const FRAME_MS = 120;

export type FooterState =
  | { kind: "off" }
  | { kind: "signed-out" }
  | { kind: "connecting" }
  | { kind: "signing-in" }
  | { kind: "connected"; peer: string; workspace: string; session: string; conclusions?: number }
  | { kind: "working"; label: string; since: number }
  | { kind: "expired" }
  | { kind: "unreachable"; host: string }
  | { kind: "error"; message: string };

export const formatCount = (n: number): string => n.toLocaleString("en-US");

export const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** One footer line per state; pure so it can be tested and screenshotted. */
export const renderFooter = (
  state: FooterState,
  theme: Theme,
  frame = 0,
  now = Date.now(),
): string => {
  const label = theme.fg("accent", "honcho");
  const dim = (s: string) => theme.fg("dim", s);
  switch (state.kind) {
    case "connected": {
      const parts = [`${state.peer}@${state.workspace}`, state.session];
      if (state.conclusions !== undefined) {
        parts.push(
          `${formatCount(state.conclusions)} ${state.conclusions === 1 ? "conclusion" : "conclusions"}`,
        );
      }
      return `${theme.fg("success", "●")} ${label}${dim(`  ${parts.join(" · ")}`)}`;
    }
    case "working":
      return `${theme.fg("accent", SPINNER[frame % SPINNER.length] ?? "◐")} ${label}${dim(`  ${state.label} · ${formatSeconds(now - state.since)}`)}`;
    case "connecting":
      return `${theme.fg("accent", SPINNER[frame % SPINNER.length] ?? "◐")} ${label}${dim("  connecting…")}`;
    case "signing-in":
      return `${theme.fg("accent", SPINNER[frame % SPINNER.length] ?? "◐")} ${label}${dim("  signing in…")}`;
    case "signed-out":
      return `${dim("○")} ${label}${dim("  not signed in · /honcho login")}`;
    case "expired":
      return `${theme.fg("warning", "▲")} ${label}${theme.fg("warning", "  sign-in expired · /honcho login")}`;
    case "unreachable":
      return `${theme.fg("error", "▲")} ${label}${theme.fg("error", `  ${state.host} unreachable · memory paused, retrying`)}`;
    case "error":
      return `${theme.fg("error", "▲")} ${label}${theme.fg("error", `  ${state.message}`)}`;
    case "off":
      return dim("○ honcho  off · /honcho on");
  }
};

const animated = (state: FooterState) =>
  state.kind === "working" || state.kind === "connecting" || state.kind === "signing-in";

/** Owns the footer status line, including the spinner timer. */
export class FooterStatus {
  private state: FooterState = { kind: "connecting" };
  private resting: FooterState = { kind: "connecting" };
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private tasks = 0;
  private ctx: ExtensionContext | undefined;
  private disposed = false;

  attach(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.render();
  }

  get current(): FooterState {
    return this.state;
  }

  /** The state to return to after a transient `working` state. */
  get base(): FooterState {
    return this.resting;
  }

  set(state: FooterState): void {
    if (state.kind !== "working") {
      this.resting = state;
    }
    // A count refresh mid-task must not hide the spinner of a turn that is still blocked
    if (this.tasks > 0 && this.state.kind === "working" && state.kind === "connected") {
      return;
    }
    this.state = state;
    this.syncTimer();
    this.render();
  }

  /** Shows a working state for the duration of `task`, then restores the resting state. */
  async working<T>(label: string, task: () => Promise<T>): Promise<T> {
    this.tasks += 1;
    this.state = { kind: "working", label, since: Date.now() };
    this.syncTimer();
    this.render();
    try {
      return await task();
    } finally {
      this.tasks -= 1;
      if (this.state.kind === "working" && this.tasks === 0) {
        this.state = this.resting;
        this.syncTimer();
        this.render();
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = undefined;
  }

  private syncTimer(): void {
    if (animated(this.state) && !this.timer && !this.disposed) {
      this.timer = setInterval(() => {
        this.frame += 1;
        this.render();
      }, FRAME_MS);
      this.timer.unref?.();
    } else if (!animated(this.state) && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private render(): void {
    if (this.disposed || !this.ctx || this.ctx.mode !== "tui") {
      return;
    }
    try {
      this.ctx.ui.setStatus(STATUS_KEY, renderFooter(this.state, this.ctx.ui.theme, this.frame));
    } catch {
      // The ctx can go stale after a session replacement
      this.dispose();
    }
  }
}
