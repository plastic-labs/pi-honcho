import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { formatCount } from "../status.js";

export const ELLIPSIS = "…";
export const DEFAULT_EXPAND_KEY = "ctrl+o";

export interface RenderOptions {
  /** Left indent and right margin, in columns. */
  pad?: number;
  /** Label of pi's expand toggle. */
  expandKey?: string;
  /** Epoch ms used for relative times. */
  now?: number;
}

/** Cuts a possibly styled line to `width` columns. */
export const fit = (line: string, width: number): string => {
  if (width <= 0) {
    return "";
  }
  return visibleWidth(line) <= width ? line : truncateToWidth(line, width, ELLIPSIS);
};

/** Cuts unstyled text without the reset codes `truncateToWidth` adds, so it can sit inside a styled span. */
export const clip = (text: string, width: number): string => {
  if (width <= 0) {
    return "";
  }
  if (visibleWidth(text) <= width) {
    return text;
  }
  return `${sliceByColumn(text, 0, width - 1, true)}${ELLIPSIS}`;
};

/** Below this many columns for the left side, `spread` drops the right side instead. */
const MIN_LEFT = 8;

/** `left` with `right` flush to column `width`; the left side gives way first so the hint stays readable. */
export const spread = (left: string, right: string, width: number, gap = 2): string => {
  const rightWidth = visibleWidth(right);
  if (rightWidth + gap + MIN_LEFT > width) {
    return fit(left, width);
  }
  const room = width - rightWidth - gap;
  const head = fit(left, room);
  return `${head}${" ".repeat(width - visibleWidth(head) - rightWidth)}${right}`;
};

/** Greedy wrap over pre-styled words, so no style spans a line break. */
export const wrapWords = (words: readonly string[], width: number): string[] => {
  const lines: string[] = [];
  let line = "";
  let used = 0;
  for (const word of words) {
    const size = visibleWidth(word);
    if (used && used + 1 + size > width) {
      lines.push(line);
      line = "";
      used = 0;
    }
    if (size > width) {
      const parts = wrapTextWithAnsi(word, Math.max(1, width));
      lines.push(...parts.slice(0, -1));
      line = parts.at(-1) ?? "";
      used = visibleWidth(line);
      continue;
    }
    line = used ? `${line} ${word}` : word;
    used += (used ? 1 : 0) + size;
  }
  if (line || !lines.length) {
    lines.push(line);
  }
  return lines;
};

export const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** Wraps plain text, keeping its paragraph breaks. */
export const wrapPlain = (text: string, width: number): string[] => {
  const lines: string[] = [];
  for (const paragraph of text.trim().split(/\n\s*\n/)) {
    if (lines.length) {
      lines.push("");
    }
    lines.push(...wrapWords(words(paragraph), width));
  }
  return lines;
};

/** First line wrapped after `marker`, the rest indented under the text. */
export const hanging = (marker: string, body: readonly string[], width: number): string[] => {
  const indent = visibleWidth(marker);
  const lines = wrapWords(body, Math.max(1, width - indent));
  return lines.map((line, i) => (i ? `${" ".repeat(indent)}${line}` : `${marker}${line}`));
};

/** Lines under the accent `│` used by expanded entries; `body` is already sized for `gutterWidth`. */
export const gutter = (body: readonly string[], theme: Theme, pad: number): string[] => {
  const bar = `${" ".repeat(pad)}${theme.fg("accent", "│")}`;
  return body.map((line) => (line ? `${bar} ${line}` : bar));
};

export const gutterWidth = (width: number, pad: number): number => Math.max(1, width - pad * 2 - 2);

/** `◆ honcho  <detail>` with the expand hint at the right edge; narrow widths keep only the key. */
export const cardHeader = (
  detail: string,
  expanded: boolean,
  width: number,
  theme: Theme,
  opts: RenderOptions,
): string => {
  const pad = opts.pad ?? 1;
  const edge = width - pad;
  const left = `${" ".repeat(pad)}${theme.fg("accent", "◆ honcho")}${theme.fg("dim", `  ${detail}`)}`;
  const key = opts.expandKey ?? DEFAULT_EXPAND_KEY;
  const hint = `${theme.fg("dim", `${key} `)}${expanded ? "collapse" : "expand"}`;
  if (visibleWidth(left) + 2 + visibleWidth(hint) <= edge) {
    return spread(left, hint, edge);
  }
  return spread(left, theme.fg("dim", key), edge);
};

/** Words styled one at a time, so a wrap never leaves a style open across lines. */
export const styled = (text: string, style?: (word: string) => string): string[] =>
  style ? words(text).map((word) => style(word)) : words(text);

/** Parts of a ` · ` list as wrap units, so no part splits across lines. */
export const units = (parts: readonly string[], style?: (unit: string) => string): string[] =>
  parts.map((part, i) => {
    const unit = i < parts.length - 1 ? `${part} ·` : part;
    return style ? style(unit) : unit;
  });

/** `prefix` then `value` wrapped under itself, with an optional `tag` flush right on the first line. */
export const field = (
  prefix: string,
  value: readonly string[],
  width: number,
  tag?: string,
): string[] => {
  const indent = visibleWidth(prefix);
  const tagRoom = tag ? visibleWidth(tag) + 2 : 0;
  const lines = wrapWords(value, Math.max(MIN_LEFT, width - indent - tagRoom));
  return lines.map((line, i) => {
    if (i) {
      return fit(`${" ".repeat(indent)}${line}`, width);
    }
    return tag ? spread(`${prefix}${line}`, tag, width) : fit(`${prefix}${line}`, width);
  });
};

export const count = (n: number, one: string, many = `${one}s`): string =>
  `${formatCount(n)} ${n === 1 ? one : many}`;

const UNITS: [limit: number, size: number, name: string][] = [
  [3_600, 60, "minute"],
  [86_400, 3_600, "hour"],
  [2_592_000, 86_400, "day"],
  [31_536_000, 2_592_000, "month"],
  [Number.POSITIVE_INFINITY, 31_536_000, "year"],
];

/** "3 days ago"; undefined for a missing or unparsable date. */
export const relativeTime = (iso: string | undefined, now = Date.now()): string | undefined => {
  if (!iso) {
    return undefined;
  }
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return undefined;
  }
  const seconds = Math.max(0, (now - at) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  for (const [limit, size, name] of UNITS) {
    if (seconds < limit) {
      return `${count(Math.floor(seconds / size), name)} ago`;
    }
  }
  return undefined;
};

const RENDER_FAILED = " honcho: could not render this entry";

/** Adapts a pure line formatter to pi's Component; never throws from render. */
export class FormattedLines implements Component {
  private readonly format: (width: number) => string[];
  private cache: { width: number; lines: string[] } | undefined;

  constructor(format: (width: number) => string[]) {
    this.format = format;
  }

  render(width: number): string[] {
    if (width <= 0) {
      return [];
    }
    if (this.cache?.width === width) {
      return this.cache.lines;
    }
    const lines = this.safeFormat(width).map((line) => fit(line, width));
    this.cache = { width, lines };
    return lines;
  }

  private safeFormat(width: number): string[] {
    try {
      return this.format(width);
    } catch {
      // Entries persist across versions, so old data may not match the current shape
      return [RENDER_FAILED];
    }
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
