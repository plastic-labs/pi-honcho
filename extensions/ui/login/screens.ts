import type { Theme } from "@earendil-works/pi-coding-agent";
import { hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type LoginMethod = "browser" | "device" | "key";

export const TITLES = {
  picker: "Sign in to Honcho",
  browser: "Sign in to Honcho · browser",
  device: "Sign in to Honcho · device code",
  key: "Sign in to Honcho · API key",
} as const;

export interface MethodOption {
  method: LoginMethod;
  label: string;
  description: string;
}

export const METHOD_OPTIONS: readonly MethodOption[] = [
  {
    method: "browser",
    label: "Browser",
    description: "Approve in your browser, then come back here",
  },
  {
    method: "device",
    label: "Device code",
    description: "For SSH and headless machines: enter a code on any device",
  },
  { method: "key", label: "API key", description: "Paste a key from your Honcho dashboard" },
];

export const ENV_KEY_NOTE = "HONCHO_API_KEY in your environment takes precedence over a saved key.";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;
const LABEL_WIDTH = 21;
const CODE_INDENT = "        ";
export const FLASH_MS = 2_000;

/** `[key, label]`; the key renders dim, the label in the default color. */
export type Hint = readonly [key: string, label: string];

/** Transient feedback that replaces one hint's label, e.g. `c copied`. */
export interface Flash {
  key: string;
  label: string;
  ok: boolean;
  at: number;
}

export const spinner = (theme: Theme, now: number): string =>
  theme.fg("accent", SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length] ?? "⠋");

/** `M:SS`, rounded up so it reads 0:00 only once time is up. */
export const formatClock = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/** First 7 and last 4 characters around bullets, all bullets under 12 characters; bullets shrink to fit `maxWidth`. */
export const maskKey = (key: string, maxWidth = Number.POSITIVE_INFINITY): string => {
  const chars = Array.from(key);
  if (chars.length < 12) {
    return "•".repeat(Math.max(0, Math.min(chars.length, maxWidth)));
  }
  const bullets = Math.max(1, Math.min(chars.length - 11, maxWidth - 11));
  return `${chars.slice(0, 7).join("")}${"•".repeat(bullets)}${chars.slice(-4).join("")}`;
};

const hintText = (
  hints: readonly Hint[],
  theme: Theme,
  flash: Flash | undefined,
  now: number,
): string =>
  hints
    .map(([key, label]) => {
      const flashing = flash && flash.key === key && now - flash.at < FLASH_MS;
      const text = flashing ? theme.fg(flash.ok ? "success" : "warning", flash.label) : label;
      return `${theme.fg("dim", key)} ${text}`;
    })
    .join(theme.fg("dim", " · "));

/** Bold title on the left, key hints right-aligned; hints drop first when the row is too narrow. */
export const titleRow = (
  title: string,
  hints: readonly Hint[],
  width: number,
  theme: Theme,
  flash?: Flash,
  now = 0,
): string => {
  const left = ` ${theme.bold(title)}`;
  const right = hintText(hints, theme, flash, now);
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap < 2 ? left : left + " ".repeat(gap) + right;
};

/** Accent rules above and below, like the editor this replaces; every line fits `width`. */
export const frame = (lines: readonly string[], width: number, theme: Theme): string[] => {
  const rule = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
  return [rule, ...lines.map((line) => truncateToWidth(line, width, "…")), rule];
};

/** Clickable URL truncated to `max` columns; `target` is what the link opens. */
const link = (url: string, max: number, theme: Theme, target = url): string =>
  hyperlink(theme.fg("mdLink", truncateToWidth(url, Math.max(1, max), "…")), target);

/** The URL in rows of `width - 1` columns, each opening the whole URL, so it stays usable without OSC 8. */
const urlRows = (url: string, width: number, theme: Theme): string[] => {
  const size = Math.max(1, width - 1);
  const chars = Array.from(url);
  const rows: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    rows.push(` ${hyperlink(theme.fg("mdLink", chars.slice(i, i + size).join("")), url)}`);
  }
  return rows;
};

const dim = (theme: Theme, text: string) => theme.fg("dim", text);

type Color = Parameters<Theme["fg"]>[0];

/** `text` after ` ${marker}`, wrapped to `width` with continuation lines indented under the text. */
const wrapped = (
  theme: Theme,
  color: Color,
  text: string,
  width: number,
  marker = "",
): string[] => {
  const lead = ` ${marker}`;
  const indent = " ".repeat(visibleWidth(lead));
  return wrapTextWithAnsi(text, Math.max(1, width - visibleWidth(lead))).map((line, i) =>
    theme.fg(color, `${i === 0 ? lead : indent}${line}`),
  );
};

export const renderBusy = (
  title: string,
  message: string,
  width: number,
  theme: Theme,
  now: number,
): string[] => [
  titleRow(title, [["esc", "cancel"]], width, theme),
  "",
  ` ${spinner(theme, now)} ${message}`,
  "",
];

export interface PickerState {
  endpoint: string;
  /** Undefined while the endpoint is being checked. */
  options?: readonly MethodOption[];
  selected: number;
  /** False when the endpoint has no authorization server. */
  oauth: boolean;
  envKey: boolean;
}

const PICKER_HINTS: readonly Hint[] = [
  ["↑↓", "select"],
  ["enter", "confirm"],
  ["esc", "cancel"],
];

export const renderPicker = (
  state: PickerState,
  width: number,
  theme: Theme,
  now: number,
): string[] => {
  const { options } = state;
  const lines = [
    titleRow(TITLES.picker, options ? PICKER_HINTS : [["esc", "cancel"]], width, theme),
    dim(theme, ` ${state.endpoint} · change the endpoint in /honcho config`),
    "",
  ];
  if (!options) {
    lines.push(` ${spinner(theme, now)} Checking ${state.endpoint}…`, "");
  } else {
    options.forEach((option, i) => {
      const label = option.label.padEnd(LABEL_WIDTH);
      lines.push(
        i === state.selected
          ? theme.fg("accent", `→ ${label}${option.description}`)
          : `  ${label}${dim(theme, option.description)}`,
      );
    });
    if (!state.oauth) {
      lines.push(
        "",
        ...wrapped(
          theme,
          "dim",
          `Browser and device sign-in aren't available on ${state.endpoint}.`,
          width,
        ),
      );
    }
    lines.push("");
  }
  if (state.envKey) {
    lines.push(
      ...wrapped(
        theme,
        "warning",
        "HONCHO_API_KEY is set in your environment and keeps taking precedence over any saved login.",
        width,
      ),
      "",
    );
  }
  return lines;
};

export interface BrowserState {
  url: string;
  port: number;
  /** Epoch ms when the loopback stops waiting. */
  deadline: number;
  flash?: Flash;
  /** Set while the user is pasting the redirected URL. */
  paste?: { input: { render(width: number): string[] }; error?: string };
  /** The pasted URL was accepted and the code is being exchanged. */
  finishing?: boolean;
}

export const renderBrowser = (
  state: BrowserState,
  width: number,
  theme: Theme,
  now: number,
): string[] => {
  const hints: readonly Hint[] = state.paste
    ? [
        ["enter", "submit"],
        ["esc", "back"],
      ]
    : [
        ["c", "copy link"],
        ["p", "paste URL"],
        ["esc", "cancel"],
      ];
  const waiting = state.finishing
    ? "Finishing sign-in…"
    : "Waiting for you to approve in the browser…";
  const lines = [
    titleRow(TITLES.browser, hints, width, theme, state.flash, now),
    "",
    ` ${spinner(theme, now)} ${waiting}`,
    "",
  ];
  if (state.paste) {
    lines.push(dim(theme, " Paste the URL the browser was redirected to:"));
    lines.push(...state.paste.input.render(Math.max(1, width - 1)).map((line) => ` ${line}`));
    if (state.paste.error) {
      lines.push(...wrapped(theme, "error", state.paste.error, width, "✗ "));
    }
  } else {
    lines.push(dim(theme, " Browser didn't open? Go to:"), ...urlRows(state.url, width, theme));
  }
  lines.push(
    "",
    dim(
      theme,
      ` Callback on 127.0.0.1:${state.port} · times out in ${formatClock(state.deadline - now)}`,
    ),
    "",
  );
  return lines;
};

export interface DeviceState {
  verificationUri: string;
  /** Opens with the code prefilled. */
  verificationUriComplete: string;
  userCode: string;
  /** Epoch ms when the code expires. */
  expiresAt: number;
  note?: string;
  flash?: Flash;
}

const DEVICE_HINTS: readonly Hint[] = [
  ["c", "copy code"],
  ["o", "open link"],
  ["esc", "cancel"],
];

export const renderDevice = (
  state: DeviceState,
  width: number,
  theme: Theme,
  now: number,
): string[] => {
  const open = " 1. On any device, open  ";
  const lines = [
    titleRow(TITLES.device, DEVICE_HINTS, width, theme, state.flash, now),
    "",
    open + link(state.verificationUri, width - open.length, theme, state.verificationUriComplete),
    " 2. Enter this code:",
    "",
    CODE_INDENT + theme.fg("warning", theme.bold(state.userCode)),
    "",
    ` ${spinner(theme, now)} Waiting for approval${dim(theme, ` · code expires in ${formatClock(state.expiresAt - now)}`)}`,
  ];
  if (state.note) {
    lines.push(dim(theme, ` ${state.note}`));
  }
  lines.push("");
  return lines;
};

export type KeyStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "error"; message: string };

export interface ApiKeyState {
  endpoint: string;
  value: string;
  status: KeyStatus;
  envKey: boolean;
}

const KEY_HINTS: readonly Hint[] = [
  ["enter", "save"],
  ["esc", "cancel"],
];

export const renderApiKey = (
  state: ApiKeyState,
  width: number,
  theme: Theme,
  now: number,
): string[] => {
  const cursor = theme.inverse(" ");
  const field = state.value
    ? `> ${maskKey(state.value, width - 3)}${cursor}`
    : `> ${cursor}${dim(theme, "paste your key")}`;
  const lines = [titleRow(TITLES.key, KEY_HINTS, width, theme), "", field, ""];
  if (state.status.kind === "checking") {
    lines.push(` ${spinner(theme, now)} Checking the key with ${state.endpoint}…`);
  } else if (state.status.kind === "error") {
    lines.push(...wrapped(theme, "error", state.status.message, width, "✗ "));
  }
  lines.push(...wrapped(theme, state.envKey ? "warning" : "dim", ENV_KEY_NOTE, width), "");
  return lines;
};
