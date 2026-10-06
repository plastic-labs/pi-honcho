import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, decodeKittyPrintable, getKeybindings } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { MaskedInput } from "./masked-input.js";
import {
  frame,
  renderApiKey,
  renderBrowser,
  renderBusy,
  renderDevice,
  renderPicker,
} from "./screens.js";
import type {
  ApiKeyState,
  BrowserState,
  DeviceState,
  LoginMethod,
  MethodOption,
  PickerState,
} from "./screens.js";

const TICK_MS = 100;
const PASTE_START = "\x1b[200~";

type Clock = () => number;
type Env = Record<string, string | undefined>;

/** Over SSH and mosh, pi's clipboard only emits an OSC 52 write it can't confirm. */
const isRemote = (env: Env): boolean =>
  Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);

/** One step of the login flow, rendered inside the view's rules. */
export interface Screen {
  render(width: number, theme: Theme, now: number): string[];
  /** Returns true when the key was consumed; an unconsumed cancel key cancels the login. */
  handleInput?(data: string): boolean;
  /** Spinners and countdowns re-render on a timer. */
  readonly animated: boolean;
}

export interface Renderer {
  requestRender(): void;
}

/** Plain characters, including Kitty CSI-u encoded ones. */
const charOf = (data: string): string => decodeKittyPrintable(data) ?? data;

const isCancel = (data: string): boolean => getKeybindings().matches(data, "tui.select.cancel");

/** Inline replacement for the editor that hosts one screen at a time. */
export class LoginView implements Component {
  private screen: Screen | undefined;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: Renderer,
    private readonly theme: Theme,
    private readonly now: Clock = Date.now,
  ) {
    this.timer = setInterval(() => {
      if (this.screen?.animated) {
        this.tui.requestRender();
      }
    }, TICK_MS);
    this.timer.unref?.();
  }

  /** Aborts on esc and when pi disposes the view. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get current(): Screen | undefined {
    return this.screen;
  }

  show(screen: Screen): void {
    this.screen = screen;
    this.tui.requestRender();
  }

  cancel(): void {
    this.controller.abort();
  }

  render(width: number): string[] {
    return frame(this.screen?.render(width, this.theme, this.now()) ?? [], width, this.theme);
  }

  handleInput(data: string): void {
    const consumed = this.screen?.handleInput?.(data) ?? false;
    if (!consumed && isCancel(data)) {
      this.cancel();
    }
    this.tui.requestRender();
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
    this.controller.abort();
  }
}

export class BusyScreen implements Screen {
  readonly animated = true;

  constructor(
    readonly title: string,
    readonly message: string,
  ) {}

  render(width: number, theme: Theme, now: number): string[] {
    return renderBusy(this.title, this.message, width, theme, now);
  }
}

export class PickerScreen implements Screen {
  readonly state: PickerState;
  onSelect?: (method: LoginMethod) => void;

  constructor(endpoint: string, envKey: boolean) {
    this.state = { endpoint, selected: 0, oauth: true, envKey };
  }

  get animated(): boolean {
    return !this.state.options;
  }

  setOptions(options: readonly MethodOption[], oauth: boolean, preferred?: LoginMethod): void {
    this.state.options = options;
    this.state.oauth = oauth;
    this.state.selected = Math.max(
      0,
      options.findIndex((o) => o.method === preferred),
    );
  }

  handleInput(data: string): boolean {
    const { options } = this.state;
    if (!options?.length) {
      return false;
    }
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up") || data === "k") {
      this.state.selected = Math.max(0, this.state.selected - 1);
      return true;
    }
    if (kb.matches(data, "tui.select.down") || data === "j") {
      this.state.selected = Math.min(options.length - 1, this.state.selected + 1);
      return true;
    }
    if (kb.matches(data, "tui.select.confirm") || data === "\n") {
      const option = options[this.state.selected];
      if (option) {
        this.onSelect?.(option.method);
      }
      return true;
    }
    return false;
  }

  render(width: number, theme: Theme, now: number): string[] {
    return renderPicker(this.state, width, theme, now);
  }
}

export interface BrowserActions {
  copy(text: string): Promise<void>;
  submitRedirectUrl(url: string): void;
}

/** Why a pasted string can't be the loopback redirect, or undefined when it can. */
export const checkRedirectUrl = (value: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Paste the full URL from the browser's address bar.";
  }
  if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
    return "That URL has no sign-in code. Paste the address the browser landed on after you approved.";
  }
  return undefined;
};

export class BrowserScreen implements Screen {
  readonly animated = true;
  readonly state: BrowserState;
  /** Resolves once the clipboard write settles; exposed for tests. */
  copying: Promise<void> = Promise.resolve();
  private input: Input | undefined;

  constructor(
    info: { url: string; port: number; deadline: number },
    private readonly actions: BrowserActions,
    private readonly now: Clock = Date.now,
    private readonly env: Env = process.env,
  ) {
    this.state = { ...info };
  }

  handleInput(data: string): boolean {
    if (!this.input && !this.state.finishing && data.includes(PASTE_START)) {
      this.openPaste();
    }
    if (this.input) {
      this.input.handleInput(data);
      return true;
    }
    const key = charOf(data);
    if (key === "c") {
      this.copying = this.copy();
      return true;
    }
    if (key === "p" && !this.state.finishing) {
      this.openPaste();
      return true;
    }
    return false;
  }

  render(width: number, theme: Theme, now: number): string[] {
    return renderBrowser(this.state, width, theme, now);
  }

  private async copy(): Promise<void> {
    try {
      await this.actions.copy(this.state.url);
      const label = isRemote(this.env) ? "sent to terminal" : "copied";
      this.state.flash = { key: "c", label, ok: true, at: this.now() };
    } catch {
      this.state.flash = { key: "c", label: "copy failed", ok: false, at: this.now() };
    }
  }

  private openPaste(): void {
    const input = new Input({ placeholder: "http://127.0.0.1:…/callback?code=…" });
    input.onSubmit = (value) => this.submit(value);
    input.onEscape = () => this.closePaste();
    this.input = input;
    this.state.paste = { input };
  }

  private closePaste(): void {
    this.input = undefined;
    this.state.paste = undefined;
  }

  private submit(value: string): void {
    const problem = checkRedirectUrl(value);
    if (problem) {
      if (this.state.paste) {
        this.state.paste.error = problem;
      }
      return;
    }
    this.closePaste();
    this.state.finishing = true;
    this.actions.submitRedirectUrl(value.trim());
  }
}

export interface DeviceActions {
  copy(text: string): Promise<void>;
  open(url: string): void;
}

export class DeviceScreen implements Screen {
  readonly animated = true;
  /** Resolves once the clipboard write settles; exposed for tests. */
  copying: Promise<void> = Promise.resolve();

  constructor(
    readonly state: DeviceState,
    private readonly actions: DeviceActions,
    private readonly now: Clock = Date.now,
    private readonly env: Env = process.env,
  ) {}

  handleInput(data: string): boolean {
    const key = charOf(data);
    if (key === "c") {
      this.copying = this.copy();
      return true;
    }
    if (key === "o") {
      this.actions.open(this.state.verificationUriComplete);
      this.state.flash = { key: "o", label: "opened", ok: true, at: this.now() };
      return true;
    }
    return false;
  }

  render(width: number, theme: Theme, now: number): string[] {
    return renderDevice(this.state, width, theme, now);
  }

  private async copy(): Promise<void> {
    try {
      await this.actions.copy(this.state.userCode);
      const label = isRemote(this.env) ? "sent to terminal" : "copied";
      this.state.flash = { key: "c", label, ok: true, at: this.now() };
    } catch {
      this.state.flash = { key: "c", label: "copy failed", ok: false, at: this.now() };
    }
  }
}

export class ApiKeyScreen implements Screen {
  readonly state: ApiKeyState;
  onSubmit?: (key: string) => void;
  private readonly input = new MaskedInput();

  constructor(endpoint: string, envKey: boolean) {
    this.state = { endpoint, value: "", status: { kind: "idle" }, envKey };
  }

  get animated(): boolean {
    return this.state.status.kind === "checking";
  }

  setChecking(): void {
    this.state.status = { kind: "checking" };
  }

  setError(message: string): void {
    this.state.status = { kind: "error", message };
  }

  handleInput(data: string): boolean {
    if (!this.input.pasting && isCancel(data)) {
      return false;
    }
    if (this.state.status.kind === "checking") {
      return true;
    }
    if (
      !this.input.pasting &&
      (getKeybindings().matches(data, "tui.input.submit") || data === "\n")
    ) {
      if (this.input.value) {
        this.onSubmit?.(this.input.value);
      }
      return true;
    }
    this.input.handleInput(data);
    if (this.input.value !== this.state.value) {
      this.state.value = this.input.value;
      if (this.state.status.kind === "error") {
        this.state.status = { kind: "idle" };
      }
    }
    return true;
  }

  render(width: number, theme: Theme, now: number): string[] {
    return renderApiKey(this.state, width, theme, now);
  }
}
