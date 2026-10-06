import { keyText } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

/** Width of the `   │ ` gutter that answers and result lists hang from. */
export const GUTTER_WIDTH = 5;

/** Width-aware block of lines; every line is clipped to the render width, and render never throws. */
export class Lines implements Component {
  private cache: { width: number; lines: string[] } | undefined;

  constructor(
    private readonly build: (width: number) => string[],
    private readonly cached = true,
  ) {}

  render(width: number): string[] {
    if (this.cached && this.cache?.width === width) {
      return this.cache.lines;
    }
    let built: string[];
    try {
      built = this.build(width);
    } catch {
      // Details restored from an older session can be malformed
      built = [" honcho: could not render this result"];
    }
    const lines = built.map((line) =>
      visibleWidth(line) > width ? truncateToWidth(line, width, "") : line,
    );
    if (this.cached) {
      this.cache = { width, lines };
    }
    return lines;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}

export const plural = (n: number, word: string): string =>
  `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

export const toolTitle = (name: string, theme: Theme): string =>
  theme.fg("toolTitle", theme.bold(name));

const expandKey = (): string => {
  try {
    return keyText("app.tools.expand") || "ctrl+o";
  } catch {
    return "ctrl+o";
  }
};

/** Left text with `right` flush against the right edge; `right` is dropped when both don't fit. */
export const rightAlign = (left: string, right: string, width: number): string => {
  const lw = visibleWidth(left);
  const rw = visibleWidth(right);
  if (!right || lw + 2 + rw > width) {
    return truncateToWidth(left, width, "…");
  }
  return left + " ".repeat(width - lw - rw) + right;
};

/** A header with `ctrl+o expand` / `collapse` at the right edge; narrow widths keep only the key, then nothing. */
export const withExpandHint = (
  left: string,
  expanded: boolean,
  width: number,
  theme: Theme,
): string => {
  const key = expandKey();
  const full = `${theme.fg("dim", `${key} `)}${expanded ? "collapse" : "expand"}`;
  for (const hint of [full, theme.fg("dim", key)]) {
    if (visibleWidth(left) + 2 + visibleWidth(hint) <= width) {
      return rightAlign(left, hint, width);
    }
  }
  return rightAlign(left, "", width);
};

/** Prefixes each line with the accent gutter; blank lines keep the bar. */
export const withGutter = (lines: string[], theme: Theme): string[] => {
  const bar = `   ${theme.fg("accent", "│")}`;
  return lines.map((line) => (line ? `${bar} ${line}` : bar));
};

export const wrap = (text: string, width: number): string[] =>
  wrapTextWithAnsi(text, Math.max(1, width));

/** Wraps `body` after `first`, indenting continuation lines by `rest`. */
export const hanging = (first: string, rest: string, body: string, width: number): string[] =>
  wrap(body, width - visibleWidth(first)).map((line, i) => (i === 0 ? first : rest) + line);

/** Caps wrapped lines at `max`, marking the cut with an ellipsis. */
export const capLines = (lines: string[], max: number, width: number): string[] => {
  if (lines.length <= max) {
    return lines;
  }
  const kept = lines.slice(0, max);
  const last = kept[max - 1] ?? "";
  kept[max - 1] = truncateToWidth(`${last} …`, width, "…");
  return kept;
};

const INLINE = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])/g;

/** Bold, inline code and italics; everything else stays literal. */
const inlineMarkdown = (text: string, theme: Theme): string =>
  text.replace(INLINE, (_m, bold?: string, under?: string, code?: string, italic?: string) => {
    if (bold ?? under) {
      return theme.bold(bold ?? under ?? "");
    }
    if (code) {
      return theme.fg("warning", code);
    }
    return theme.italic(italic ?? "");
  });

const stripInline = (text: string): string =>
  text.replace(
    INLINE,
    (_m, a?: string, b?: string, c?: string, d?: string) => a ?? b ?? c ?? d ?? "",
  );

/** Renders a dialectic answer's markdown subset (headings, bullets, numbered items, paragraphs) at `width`. */
export const answerLines = (text: string, width: number, theme: Theme): string[] => {
  const out: string[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      if (out.length && out.at(-1) !== "") {
        out.push("");
      }
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push(...wrap(theme.fg("accent", theme.bold(stripInline(heading[1] ?? ""))), width));
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const indent = " ".repeat(Math.min(Math.floor((bullet[1] ?? "").length / 2) * 2, 6));
      out.push(
        ...hanging(
          `${indent}${theme.fg("dim", "-")} `,
          `${indent}  `,
          inlineMarkdown(bullet[2] ?? "", theme),
          width,
        ),
      );
      continue;
    }
    const numbered = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line);
    if (numbered) {
      const marker = `${numbered[2] ?? ""} `;
      out.push(
        ...hanging(
          theme.fg("dim", marker),
          " ".repeat(marker.length),
          inlineMarkdown(numbered[3] ?? "", theme),
          width,
        ),
      );
      continue;
    }
    out.push(...wrap(inlineMarkdown(line.trim(), theme), width));
  }
  while (out.at(-1) === "") {
    out.pop();
  }
  return out;
};

/** Cuts unstyled text to `width` columns, ending in "…" when shortened. */
export const cutPlain = (text: string, width: number): string => {
  if (visibleWidth(text) <= width) {
    return text;
  }
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = visibleWidth(ch);
    if (used + w > width - 1) {
      break;
    }
    out += ch;
    used += w;
  }
  return `${out.trimEnd()}…`;
};

/** `YYYY-MM-DD` from an ISO timestamp, or "" when it isn't one. */
export const isoDate = (value: string | undefined): string =>
  /^\d{4}-\d{2}-\d{2}/.exec(value ?? "")?.[0] ?? "";

/** One line, whitespace collapsed, cut at `max` characters. */
export const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** First text block of a tool result, e.g. the message of a thrown error. */
const resultText = (result: AgentToolResult<unknown>, fallback: string): string => {
  const block = result.content.find((c) => c.type === "text");
  return block?.type === "text" && block.text ? block.text : fallback;
};

/** A thrown error's message after `prefix`: the first 3 lines collapsed, all of it expanded. */
export const errorLines = (
  result: AgentToolResult<unknown>,
  opts: { expanded: boolean; prefix: string; fallback: string },
  width: number,
  theme: Theme,
): string[] => {
  const indent = " ".repeat(Math.min(visibleWidth(opts.prefix), 2));
  const lines = hanging(
    opts.prefix,
    indent,
    theme.fg("error", resultText(result, opts.fallback)),
    width,
  );
  return opts.expanded ? lines : capLines(lines, 3, width);
};
