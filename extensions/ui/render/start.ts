import type { Theme } from "@earendil-works/pi-coding-agent";
import type { StartEntryData } from "../../memory.js";
import { formatAnswer } from "./turn.js";
import { cardHeader, count, gutter, gutterWidth, hanging, relativeTime, words } from "./layout.js";
import type { RenderOptions } from "./layout.js";

/** Collapsed detail, e.g. `session start · summary 310 words · peer card 14 facts · in system prompt`. */
export const startDetail = (data: StartEntryData): string => {
  const facts = data.peerCardSelected ? (data.peerCard ?? []).length : 0;
  const summary = data.summarySelected ? data.summary : undefined;
  if (!data.summarySelected && !data.peerCardSelected) {
    return "session start · nothing injected";
  }
  if (!summary && !facts) {
    return `session start · nothing stored yet for ${data.peer}`;
  }
  const parts = ["session start"];
  if (data.summarySelected) {
    parts.push(summary ? `summary ${count(summary.words, "word")}` : "no summary yet");
  }
  if (data.peerCardSelected) {
    parts.push(facts ? `peer card ${count(facts, "fact")}` : "no peer card yet");
  }
  parts.push("in system prompt");
  return parts.join(" · ");
};

const peerCardLines = (data: StartEntryData, width: number, theme: Theme): string[] => {
  const facts = data.peerCard ?? [];
  const lines = [`${theme.bold("Peer card")}${theme.fg("dim", ` · ${data.peer}`)}`];
  if (!facts.length) {
    return [...lines, theme.fg("dim", "no facts yet")];
  }
  for (const fact of facts) {
    lines.push(...hanging(`${theme.fg("dim", "-")} `, words(fact), width));
  }
  return lines;
};

const summaryLines = (
  data: StartEntryData,
  width: number,
  theme: Theme,
  now?: number,
): string[] => {
  const ago = relativeTime(data.summary?.createdAt, now);
  const meta = [data.session, ago].filter(Boolean).join(" · ");
  const heading = `${theme.bold("Session summary")}${theme.fg("dim", ` · ${meta}`)}`;
  if (!data.summary) {
    return [heading, theme.fg("dim", "no summary yet for this session")];
  }
  return [heading, ...formatAnswer(data.summary.text, width, theme)];
};

/** The `honcho-start` entry: one line collapsed, peer card and summary under a gutter when expanded. */
export const formatStartEntry = (
  data: StartEntryData,
  expanded: boolean,
  width: number,
  theme: Theme,
  opts: RenderOptions = {},
): string[] => {
  const pad = opts.pad ?? 1;
  const header = cardHeader(startDetail(data), expanded, width, theme, opts);
  if (!expanded) {
    return [header];
  }
  const inner = gutterWidth(width, pad);
  const sections: string[][] = [];
  if (data.peerCardSelected) {
    sections.push(peerCardLines(data, inner, theme));
  }
  if (data.summarySelected) {
    sections.push(summaryLines(data, inner, theme, opts.now));
  }
  const body: string[] = [];
  for (const section of sections) {
    if (body.length) {
      body.push("");
    }
    body.push(...section);
  }
  return [header, ...gutter(body, theme, pad)];
};
