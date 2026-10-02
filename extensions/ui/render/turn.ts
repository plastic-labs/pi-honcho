import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { countWords } from "../../memory.js";
import type { Conclusion, TurnDetails } from "../../memory.js";
import { formatCount, formatSeconds } from "../status.js";
import {
  cardHeader,
  clip,
  count,
  gutter,
  gutterWidth,
  hanging,
  words,
  wrapWords,
} from "./layout.js";
import type { RenderOptions } from "./layout.js";

const SHOWN_CONCLUSIONS = 8;
const STAMP_WIDTH = 10;
const MAX_INDENT = 6;

/** What the `honcho-turn` renderer reads from a custom message. */
export interface TurnView {
  details?: TurnDetails;
  content: string | readonly { type: string; text?: string }[];
}

const contentText = (content: TurnView["content"]): string =>
  typeof content === "string"
    ? content
    : content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");

/** The recalled text without the bracketed preamble that tells the model it is background. */
export const recalledText = (content: TurnView["content"]): string =>
  contentText(content)
    .replace(/^\[Honcho memory[^\n]*\]\n?/, "")
    .trim();

/** Styles `**bold**` and `code` word by word; markers are dropped. */
export const styleWords = (text: string, theme: Theme): string[] => {
  let bold = false;
  let code = false;
  return words(text)
    .map((raw) =>
      raw
        .split(/(\*\*|`)/)
        .map((part) => {
          if (part === "`") {
            code = !code;
            return "";
          }
          if (part === "**" && !code) {
            bold = !bold;
            return "";
          }
          let out = part;
          if (out && code) {
            out = theme.fg("warning", out);
          }
          if (out && bold) {
            out = theme.bold(out);
          }
          return out;
        })
        .join(""),
    )
    .filter(Boolean);
};

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
const FENCE = /^\s*```/;

/** Markdown-ish answer: dim list markers, bold headings and `**spans**`, wrapped to `width`. */
export const formatAnswer = (text: string, width: number, theme: Theme): string[] => {
  const out: string[] = [];
  let fenced = false;
  for (const raw of text.split("\n")) {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      out.push(clip(raw.replace(/\t/g, "  "), width));
      continue;
    }
    if (!raw.trim()) {
      if (out.length && out.at(-1) !== "") {
        out.push("");
      }
      continue;
    }
    const heading = HEADING.exec(raw);
    if (heading) {
      out.push(
        ...wrapWords(
          styleWords(heading[1] ?? "", theme).map((word) => theme.bold(word)),
          width,
        ),
      );
      continue;
    }
    const item = LIST_ITEM.exec(raw);
    if (item) {
      const indent = " ".repeat(Math.min(item[1]?.length ?? 0, MAX_INDENT));
      const marker = /^[-*+]$/.test(item[2] ?? "") ? "-" : (item[2] ?? "-");
      out.push(
        ...hanging(`${indent}${theme.fg("dim", marker)} `, styleWords(item[3] ?? "", theme), width),
      );
      continue;
    }
    out.push(...wrapWords(styleWords(raw, theme), width));
  }
  while (out.at(-1) === "") {
    out.pop();
  }
  return out;
};

const UNDATED: Record<Conclusion["level"], string> = {
  explicit: "",
  deductive: "",
  inductive: "pattern",
  contradiction: "conflict",
};

const stamp = (conclusion: Conclusion): string => conclusion.at ?? UNDATED[conclusion.level] ?? "";

const conclusionLines = (
  conclusions: readonly Conclusion[],
  width: number,
  theme: Theme,
): string[] => {
  if (!conclusions.length) {
    return [theme.fg("dim", "no conclusions")];
  }
  const lines = conclusions
    .slice(0, SHOWN_CONCLUSIONS)
    .flatMap((c) =>
      hanging(`${theme.fg("dim", stamp(c).padEnd(STAMP_WIDTH))}  `, words(c.text), width),
    );
  const more = conclusions.length - SHOWN_CONCLUSIONS;
  if (more > 0) {
    lines.push(theme.fg("dim", `… ${formatCount(more)} more`));
  }
  return lines;
};

const askedLine = (query: string, width: number, theme: Theme): string => {
  const frame = 'asked  Relevant to: ""';
  const text = clip(query.replace(/\s+/g, " ").trim(), width - visibleWidth(frame));
  return theme.fg("dim", `asked  Relevant to: "${text}"`);
};

/** Collapsed detail, e.g. `chat · medium · 1.8s · 140 words` or `context · 8 conclusions · 0.3s · 180 words`. */
export const turnDetail = (view: TurnView): string => {
  const d = view.details;
  if (!d) {
    return `memory · ${count(countWords(recalledText(view.content)), "word")}`;
  }
  const parts: string[] = [d.mode];
  if (d.mode === "chat" && d.reasoning) {
    parts.push(d.reasoning);
  }
  if (d.mode === "context") {
    parts.push(count(d.conclusions?.length ?? 0, "conclusion"));
  }
  parts.push(formatSeconds(d.ms), count(d.words, "word"));
  return parts.join(" · ");
};

/** The `honcho-turn` message: one line collapsed, the recalled memory under a gutter when expanded. */
export const formatTurnMessage = (
  view: TurnView,
  expanded: boolean,
  width: number,
  theme: Theme,
  opts: RenderOptions = {},
): string[] => {
  const pad = opts.pad ?? 1;
  const header = cardHeader(turnDetail(view), expanded, width, theme, opts);
  if (!expanded) {
    return [header];
  }
  const inner = gutterWidth(width, pad);
  const d = view.details;
  if (d?.mode === "context" && d.conclusions) {
    return [header, ...gutter(conclusionLines(d.conclusions, inner, theme), theme, pad)];
  }
  const body = formatAnswer(
    d?.mode === "chat" && d.answer ? d.answer : recalledText(view.content),
    inner,
    theme,
  );
  if (d?.mode === "chat") {
    body.unshift(askedLine(d.query, inner, theme));
  }
  return [header, ...gutter(body, theme, pad)];
};
