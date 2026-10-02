import type {
  CustomEntry,
  EntryRenderer,
  ExtensionAPI,
  MessageRenderer,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { StartEntryData, TurnDetails } from "../extensions/memory.js";
import type { LoginEntryData, StatusSnapshot } from "../extensions/ui/entries.js";
import {
  FormattedLines,
  clip,
  relativeTime,
  spread,
  wrapWords,
} from "../extensions/ui/render/layout.js";
import { formatPendingLine } from "../extensions/ui/pending.js";
import { formatLoginEntry } from "../extensions/ui/render/login.js";
import { formatStatusPanel } from "../extensions/ui/render/panel.js";
import { formatStartEntry } from "../extensions/ui/render/start.js";
import { formatAnswer, formatTurnMessage } from "../extensions/ui/render/turn.js";
import type { TurnView } from "../extensions/ui/render/turn.js";
import { registerRenderers } from "../extensions/ui/renderers.js";
import { plainTheme, taggedTheme } from "./helpers/theme.js";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const DAY = 86_400_000;
const WIDTHS = [100, 60];

/** Emits real SGR codes so width math is exercised with escapes in the strings. */
const ansiTheme = (): Theme => {
  const wrap = (open: string, close: string) => (s: string) =>
    `\u001b[${open}m${s}\u001b[${close}m`;
  const theme = {
    fg: (_color: string, s: string) => wrap("38;5;141", "39")(s),
    bg: (_color: string, s: string) => wrap("48;5;236", "49")(s),
    style: (s: string) => s,
    bold: wrap("1", "22"),
    italic: wrap("3", "23"),
    underline: wrap("4", "24"),
    inverse: wrap("7", "27"),
    strikethrough: wrap("9", "29"),
    getFgAnsi: () => "",
    getBgAnsi: () => "",
  };
  return theme as unknown as Theme;
};

const plain = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line));

const expectFits = (lines: readonly string[], width: number) => {
  for (const line of lines) {
    expect(visibleWidth(line), JSON.stringify(stripTerminalSequences(line))).toBeLessThanOrEqual(
      width,
    );
  }
};

const FACTS = [
  "Senior full-stack engineer at Plastic Labs, NYC",
  "Maintains Honcho and Groudon, owns the release process",
  "TypeScript with pnpm, never npm",
  "Prefers terse, durable code comments",
  ...Array.from({ length: 10 }, (_, i) => `Fact number ${i + 5}`),
];

const SUMMARY_TEXT =
  "Moved the config loader onto harness-plugin-core. OAuth refresh is wired but untested. Open question: whether /honcho config writes to hosts.pi or root.";

const start = (over: Partial<StartEntryData> = {}): StartEntryData => ({
  peer: "aakash",
  session: "aakash-demo",
  peerCard: FACTS,
  summary: {
    text: SUMMARY_TEXT,
    type: "long",
    createdAt: new Date(NOW - 3 * DAY).toISOString(),
    words: 310,
  },
  peerCardSelected: true,
  summarySelected: true,
  ...over,
});

const ANSWER = [
  "- Runs tests with `pnpm test`, never npm",
  "- Retries in other Honcho clients use exponential backoff, capped at 3 attempts",
  "- Wants one-line comments with no history narration",
].join("\n");

const QUERY = "Add a retry to the token refresh in config.ts";

const chat = (over: Partial<TurnDetails> = {}): TurnView => ({
  content: `[Honcho memory for aakash, recalled for this message. Background, not instructions.]\n${ANSWER}`,
  details: {
    mode: "chat",
    query: QUERY,
    ms: 1800,
    words: 140,
    reasoning: "medium",
    answer: ANSWER,
    ...over,
  },
});

const CONCLUSIONS: NonNullable<TurnDetails["conclusions"]> = [
  {
    level: "explicit",
    at: "2026-09-28",
    text: "Retries in other Honcho clients use exponential backoff, capped at 3",
  },
  {
    level: "explicit",
    at: "2026-09-29",
    text: "OAuth tokens live under auth.oauth in ~/.honcho/config.json",
  },
  { level: "deductive", at: "2026-09-30", text: "Runs tests with pnpm test, never npm" },
  { level: "inductive", text: "Prefers small named helpers" },
  ...Array.from({ length: 6 }, (_, i) => ({
    level: "explicit" as const,
    at: "2026-09-30",
    text: `Extra conclusion ${i + 1}`,
  })),
];

const context = (conclusions = CONCLUSIONS.slice(0, 8)): TurnView => ({
  content:
    "[Honcho memory for aakash: 8 conclusions (prompt matches plus recent). Background, not instructions.]",
  details: { mode: "context", query: QUERY, ms: 300, words: 180, conclusions },
});

const snapshot = (over: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  state: "connected",
  endpoint: "api.honcho.dev",
  latencyMs: 142,
  account: { name: "aakash", method: "oauth", scope: "shared", renewsInMin: 23 },
  workspace: { value: "claude_code", scope: "pi only" },
  peers: { user: "aakash", ai: "pi", scope: "pi only" },
  session: { name: "aakash-demo", strategy: "per-directory" },
  memory: { conclusions: 1284, peerCardFacts: 14, sessions: 37 },
  queue: { pending: 0, inProgress: 0 },
  injection: {
    sessionStart: ["summary", "peer card"],
    perTurn: "chat",
    reasoning: "medium",
    maxConclusions: 15,
  },
  tools: ["honcho_chat", "honcho_search"],
  warnings: [],
  ...over,
});

const login = (over: Partial<LoginEntryData> = {}): LoginEntryData => ({
  user: "aakash",
  method: "oauth",
  endpoint: "api.honcho.dev",
  workspace: "claude_code",
  peer: "aakash",
  aiPeer: "pi",
  session: "aakash-demo",
  strategy: "per-directory",
  savedTo: "~/.honcho/config.json",
  sharedWith: "shared with Claude Code and Hermes",
  ...over,
});

describe("session start entry", () => {
  const t = plainTheme();

  it("collapses to one line with the hint flush right at width 100", () => {
    const lines = formatStartEntry(start(), false, 100, t, { now: NOW });
    expect(lines).toEqual([
      " ◆ honcho  session start · summary 310 words · peer card 14 facts · in system prompt  ctrl+o expand",
    ]);
    expect(visibleWidth(lines[0] ?? "")).toBe(99);
  });

  it("truncates the detail but keeps the key at width 60", () => {
    const [line = ""] = plain(formatStartEntry(start(), false, 60, t, { now: NOW }));
    expect(line.startsWith(" ◆ honcho  session start · summary 310 words")).toBe(true);
    expect(line).toContain("…");
    expect(line.endsWith("ctrl+o")).toBe(true);
    expect(visibleWidth(line)).toBe(59);
  });

  it("colors the label accent and the detail dim", () => {
    const [line = ""] = formatStartEntry(start(), false, 300, taggedTheme(), { now: NOW });
    expect(line).toContain("<accent>◆ honcho</accent><dim>  session start · summary 310 words");
    expect(line).toContain("<dim>ctrl+o </dim>expand");
  });

  it("says when there is no summary yet", () => {
    const [line] = formatStartEntry(start({ summary: undefined }), false, 100, t);
    expect(line).toContain(
      "session start · no summary yet · peer card 14 facts · in system prompt",
    );
  });

  it("says when nothing is stored and drops 'in system prompt'", () => {
    for (const width of WIDTHS) {
      const [line = ""] = plain(
        formatStartEntry(start({ summary: undefined, peerCard: [] }), false, width, t),
      );
      expect(line).toContain(
        width === 100
          ? "session start · nothing stored yet for aakash  "
          : "session start · nothing stored yet for …",
      );
      expect(line).not.toContain("in system prompt");
    }
  });

  it("omits parts that are not selected", () => {
    const [noSummary] = formatStartEntry(start({ summarySelected: false }), false, 100, t);
    expect(noSummary).toContain("session start · peer card 14 facts · in system prompt");
    const [noCard] = formatStartEntry(start({ peerCardSelected: false }), false, 100, t);
    expect(noCard).toContain("session start · summary 310 words · in system prompt");
    const expanded = formatStartEntry(start({ peerCardSelected: false }), true, 100, t, {
      now: NOW,
    });
    expect(expanded.join("\n")).not.toContain("Peer card");
  });

  it("uses singular counts", () => {
    const [line] = formatStartEntry(
      start({ peerCard: ["one"], summary: { text: "one", type: "short", words: 1 } }),
      false,
      100,
      t,
    );
    expect(line).toContain("summary 1 word · peer card 1 fact");
  });

  it("expands into peer card and summary under the gutter at width 100", () => {
    const lines = formatStartEntry(start(), true, 100, t, { now: NOW });
    expect(lines[0]?.endsWith("ctrl+o")).toBe(true);
    expect(lines.slice(1)).toEqual([
      " │ Peer card · aakash",
      " │ - Senior full-stack engineer at Plastic Labs, NYC",
      " │ - Maintains Honcho and Groudon, owns the release process",
      " │ - TypeScript with pnpm, never npm",
      " │ - Prefers terse, durable code comments",
      ...Array.from({ length: 10 }, (_, i) => ` │ - Fact number ${i + 5}`),
      " │",
      " │ Session summary · aakash-demo · 3 days ago",
      " │ Moved the config loader onto harness-plugin-core. OAuth refresh is wired but untested. Open",
      " │ question: whether /honcho config writes to hosts.pi or root.",
    ]);
    expectFits(lines, 100);
  });

  it("shows the collapse hint when the header has room", () => {
    const [line = ""] = formatStartEntry(start({ summary: undefined, peerCard: [] }), true, 100, t);
    expect(line.endsWith("ctrl+o collapse")).toBe(true);
    expect(visibleWidth(line)).toBe(99);
  });

  it("wraps the summary and long facts to width 60", () => {
    const longFact =
      "Keeps a running list of every Honcho deployment and the exact migration each one needs";
    const lines = plain(
      formatStartEntry(start({ peerCard: [longFact] }), true, 60, t, { now: NOW }),
    );
    expectFits(lines, 60);
    for (const line of lines.slice(1)) {
      expect(line.startsWith(" │")).toBe(true);
    }
    expect(lines).toContain(" │ - Keeps a running list of every Honcho deployment and");
    expect(lines).toContain(" │   the exact migration each one needs");
    const summary = lines.slice(lines.indexOf(" │ Session summary · aakash-demo · 3 days ago") + 1);
    expect(summary).toEqual([
      " │ Moved the config loader onto harness-plugin-core. OAuth",
      " │ refresh is wired but untested. Open question: whether",
      " │ /honcho config writes to hosts.pi or root.",
    ]);
  });

  it("marks headings bold and the gutter accent", () => {
    const lines = formatStartEntry(start(), true, 300, taggedTheme(), { now: NOW });
    expect(lines[1]).toBe(" <accent>│</accent> <b>Peer card</b><dim> · aakash</dim>");
    expect(lines[2]).toBe(
      " <accent>│</accent> <dim>-</dim> Senior full-stack engineer at Plastic Labs, NYC",
    );
  });

  it("explains empty sections when expanded", () => {
    const lines = formatStartEntry(start({ summary: undefined, peerCard: [] }), true, 100, t);
    expect(lines.slice(1)).toEqual([
      " │ Peer card · aakash",
      " │ no facts yet",
      " │",
      " │ Session summary · aakash-demo",
      " │ no summary yet for this session",
    ]);
  });
});

describe("per-turn message", () => {
  const t = plainTheme();

  it("collapses chat to one line", () => {
    const lines = formatTurnMessage(chat(), false, 100, t);
    expect(lines).toEqual([
      ` ◆ honcho  chat · medium · 1.8s · 140 words${" ".repeat(43)}ctrl+o expand`,
    ]);
    expect(visibleWidth(lines[0] ?? "")).toBe(99);
  });

  it("expands chat with the question and the answer", () => {
    for (const width of WIDTHS) {
      const lines = plain(formatTurnMessage(chat(), true, width, t));
      expectFits(lines, width);
      expect(lines[0]?.endsWith(width === 100 ? "ctrl+o collapse" : "ctrl+o")).toBe(true);
      expect(lines).toContain(" │ - Runs tests with pnpm test, never npm");
      expect(lines.at(-1)).toBe(" │ - Wants one-line comments with no history narration");
    }
    const wide = formatTurnMessage(chat(), true, 100, t);
    expect(wide.slice(1)).toEqual([
      ` │ asked  Relevant to: "${QUERY}"`,
      " │ - Runs tests with pnpm test, never npm",
      " │ - Retries in other Honcho clients use exponential backoff, capped at 3 attempts",
      " │ - Wants one-line comments with no history narration",
    ]);
    const narrow = plain(formatTurnMessage(chat(), true, 60, t));
    expect(narrow[1]).toBe(' │ asked  Relevant to: "Add a retry to the token refresh …"');
    expect(narrow).toContain(" │ - Retries in other Honcho clients use exponential");
    expect(narrow).toContain(" │   backoff, capped at 3 attempts");
  });

  it("puts a multi-line query on one line", () => {
    const lines = formatTurnMessage(chat({ query: "first\n\nsecond" }), true, 100, t);
    expect(lines[1]).toBe(' │ asked  Relevant to: "first second"');
  });

  it("leaves out the reasoning level when it is unknown", () => {
    const [line] = formatTurnMessage(chat({ reasoning: undefined }), false, 100, t);
    expect(line).toContain("◆ honcho  chat · 1.8s · 140 words");
  });

  it("collapses context with the conclusion count", () => {
    const lines = formatTurnMessage(context(), false, 100, t);
    expect(lines[0]).toContain(" ◆ honcho  context · 8 conclusions · 0.3s · 180 words");
    expect(lines[0]?.endsWith("ctrl+o expand")).toBe(true);
  });

  it("expands context into dated rows without similarity scores", () => {
    const lines = formatTurnMessage(context(CONCLUSIONS), true, 100, t);
    expect(lines.slice(1)).toEqual([
      " │ 2026-09-28  Retries in other Honcho clients use exponential backoff, capped at 3",
      " │ 2026-09-29  OAuth tokens live under auth.oauth in ~/.honcho/config.json",
      " │ 2026-09-30  Runs tests with pnpm test, never npm",
      " │ pattern     Prefers small named helpers",
      " │ 2026-09-30  Extra conclusion 1",
      " │ 2026-09-30  Extra conclusion 2",
      " │ 2026-09-30  Extra conclusion 3",
      " │ 2026-09-30  Extra conclusion 4",
      " │ … 2 more",
    ]);
    expect(lines.join("\n")).not.toMatch(/0\.\d\d/);
    const narrow = plain(formatTurnMessage(context(CONCLUSIONS), true, 60, t));
    expectFits(narrow, 60);
    expect(narrow[1]).toBe(" │ 2026-09-28  Retries in other Honcho clients use");
    expect(narrow[2]).toBe(" │             exponential backoff, capped at 3");
  });

  it("dims dates in context rows", () => {
    const lines = formatTurnMessage(context(), true, 300, taggedTheme());
    expect(lines[1]).toBe(
      " <accent>│</accent> <dim>2026-09-28</dim>  Retries in other Honcho clients use exponential backoff, capped at 3",
    );
  });

  it("falls back to the message content when details are missing", () => {
    const view: TurnView = {
      content:
        "[Honcho memory for aakash, recalled for this message. Background, not instructions.]\n- likes tea\n- hates meetings",
    };
    const [collapsed] = formatTurnMessage(view, false, 100, t);
    expect(collapsed).toContain("◆ honcho  memory · 6 words");
    const expanded = formatTurnMessage(view, true, 100, t);
    expect(expanded.slice(1)).toEqual([" │ - likes tea", " │ - hates meetings"]);
    const parts: TurnView = {
      content: [{ type: "text", text: "- from parts" }, { type: "image" }],
    };
    expect(formatTurnMessage(parts, true, 100, t).slice(1)).toEqual([" │ - from parts"]);
  });

  it("uses content when a chat answer is missing", () => {
    const lines = formatTurnMessage(chat({ answer: undefined }), true, 100, t);
    expect(lines).toContain(" │ - Wants one-line comments with no history narration");
  });

  it("honors outputPad", () => {
    const [line = ""] = formatTurnMessage(chat(), false, 80, t, { pad: 0 });
    expect(line.startsWith("◆ honcho")).toBe(true);
    expect(visibleWidth(line)).toBe(80);
    const [padded = ""] = formatTurnMessage(chat(), false, 80, t, { pad: 2 });
    expect(padded.startsWith("  ◆ honcho")).toBe(true);
    expect(visibleWidth(padded)).toBe(78);
  });
});

describe("markdown-ish answers", () => {
  it("bolds headings and spans, dims list markers and colors code", () => {
    const text =
      "## Notes\n\n\n- **Retries** use `pnpm test`, always\n1. first\n  * nested item\nPlain **bold words here** end";
    const lines = formatAnswer(text, 300, taggedTheme());
    expect(lines).toEqual([
      "<b>Notes</b>",
      "",
      "<dim>-</dim> <b>Retries</b> use <warning>pnpm</warning> <warning>test</warning>, always",
      "<dim>1.</dim> first",
      "  <dim>-</dim> nested item",
      "Plain <b>bold</b> <b>words</b> <b>here</b> end",
    ]);
  });

  it("keeps fenced code as-is and drops the fences", () => {
    expect(formatAnswer("```ts\nconst a = 1;\n```\nafter", 80, plainTheme())).toEqual([
      "const a = 1;",
      "after",
    ]);
  });

  it("never splits a style across lines", () => {
    const lines = formatAnswer(
      "**one two three four five six seven eight nine ten**",
      12,
      ansiTheme(),
    );
    expectFits(lines, 12);
    for (const line of lines) {
      expect(line.startsWith("\u001b[1m")).toBe(true);
    }
  });
});

describe("status panel", () => {
  const t = plainTheme();

  it("matches the artboard at width 100", () => {
    const lines = formatStatusPanel(snapshot(), 100, t);
    expect(lines).toEqual([
      " Honcho  ● connected · api.honcho.dev · 142 ms",
      "",
      ` account    aakash · oauth, renews in 23m${" ".repeat(25)}shared`,
      ` workspace  claude_code${" ".repeat(42)}pi only`,
      ` peers      aakash (you) · pi (agent)${" ".repeat(28)}pi only`,
      ` session    aakash-demo${" ".repeat(36)}per-directory`,
      "",
      " memory     1,284 conclusions · peer card 14 facts · 37 sessions",
      " queue      idle",
      "",
      " injection  session start: summary, peer card",
      "            each turn: chat, medium reasoning",
      " tools      honcho_chat · honcho_search",
      "",
      " /honcho login · /honcho logout · /honcho config · /honcho off",
    ]);
  });

  it("aligns the scope column at a fixed edge", () => {
    for (const width of WIDTHS) {
      const lines = plain(formatStatusPanel(snapshot(), width, t));
      expectFits(lines, width);
      const edge = Math.min(width - 1, 72);
      const scoped = lines.filter((line) => /(shared|pi only|per-directory)$/.test(line));
      expect(scoped).toHaveLength(4);
      for (const line of scoped) {
        expect(visibleWidth(line)).toBe(edge);
      }
    }
  });

  it("wraps long rows at width 60 instead of cutting them", () => {
    const lines = plain(formatStatusPanel(snapshot(), 60, t));
    expect(lines).toContain(" memory     1,284 conclusions · peer card 14 facts ·");
    expect(lines).toContain("            37 sessions");
    expect(lines.slice(-2)).toEqual([
      " /honcho login · /honcho logout · /honcho config ·",
      " /honcho off",
    ]);
  });

  it("truncates rows that cannot wrap", () => {
    const lines = plain(
      formatStatusPanel(
        snapshot({ workspace: { value: "w".repeat(80), scope: "pi only" } }),
        60,
        t,
      ),
    );
    expectFits(lines, 60);
    const workspace = lines.find((line) => line.startsWith(" workspace"));
    expect(workspace?.endsWith("pi only")).toBe(true);
  });

  it("shows queue activity", () => {
    const busy = formatStatusPanel(snapshot({ queue: { pending: 12, inProgress: 3 } }), 100, t);
    expect(busy).toContain(" queue      12 pending · 3 in progress");
    const working = formatStatusPanel(snapshot({ queue: { pending: 0, inProgress: 3 } }), 100, t);
    expect(working).toContain(" queue      3 in progress");
    const unknown = formatStatusPanel(snapshot({ queue: undefined }), 100, t);
    expect(unknown).toContain(" queue      unavailable");
  });

  it("marks values it could not read", () => {
    const lines = formatStatusPanel(
      snapshot({ memory: { peerCardFacts: 0 }, latencyMs: undefined }),
      100,
      t,
    );
    expect(lines[0]).toBe(" Honcho  ● connected · api.honcho.dev");
    expect(lines).toContain(" memory     — conclusions · no peer card yet · — sessions");
    const none = formatStatusPanel(snapshot({ memory: undefined }), 100, t);
    expect(none).toContain(" memory     — conclusions · peer card — · — sessions");
    const one = formatStatusPanel(
      snapshot({ memory: { conclusions: 1, peerCardFacts: 1, sessions: 1 } }),
      100,
      t,
    );
    expect(one).toContain(" memory     1 conclusion · peer card 1 fact · 1 session");
  });

  it("describes the other injection modes and tools", () => {
    const lines = formatStatusPanel(
      snapshot({
        injection: { sessionStart: [], perTurn: "context", reasoning: "low", maxConclusions: 15 },
        tools: [],
      }),
      100,
      t,
    );
    expect(lines).toContain(" injection  session start: off");
    expect(lines).toContain("            each turn: context, 15 conclusions");
    expect(lines).toContain(" tools      none");
    const off = formatStatusPanel(
      snapshot({
        injection: {
          sessionStart: ["summary"],
          perTurn: "off",
          reasoning: "low",
          maxConclusions: 15,
        },
      }),
      100,
      t,
    );
    expect(off).toContain(" injection  session start: summary");
    expect(off).toContain("            each turn: off");
  });

  it("formats the renewal time", () => {
    const row = (renewsInMin: number) =>
      formatStatusPanel(
        snapshot({ account: { name: "a", method: "oauth", scope: "shared", renewsInMin } }),
        100,
        t,
      )[2];
    expect(row(0)).toContain("a · oauth, renews in <1m");
    expect(row(59)).toContain("renews in 59m");
    expect(row(60)).toContain("renews in 1h ");
    expect(row(90)).toContain("renews in 1h 30m");
  });

  it("shows key accounts without a renewal", () => {
    const lines = formatStatusPanel(
      snapshot({ account: { name: "aakash", method: "env key", scope: "env" } }),
      100,
      t,
    );
    expect(lines[2]).toBe(` account    aakash · env key${" ".repeat(41)}env`);
  });

  it("explains a signed-out state", () => {
    for (const width of WIDTHS) {
      const lines = plain(
        formatStatusPanel(
          snapshot({
            state: "signed-out",
            error: "Not signed in to Honcho. Run /honcho login.",
            account: undefined,
            latencyMs: undefined,
            memory: undefined,
            queue: undefined,
            session: undefined,
          }),
          width,
          t,
        ),
      );
      expectFits(lines, width);
      expect(lines.slice(0, 4)).toEqual([
        " Honcho  ○ not signed in · api.honcho.dev",
        " Not signed in to Honcho. Run /honcho login.",
        "",
        " account    not signed in",
      ]);
      expect(lines).toContain(" session    —");
      expect(lines.join("\n")).not.toContain("memory");
      expect(lines.join("\n")).not.toContain("queue");
      expect(lines.join(" ")).toContain("/honcho off");
    }
  });

  it("offers /honcho on when off", () => {
    const lines = formatStatusPanel(
      snapshot({ state: "off", error: "Honcho is off for pi. Run /honcho on to turn it back on." }),
      100,
      t,
    );
    expect(lines[0]).toBe(" Honcho  ○ off · api.honcho.dev · 142 ms");
    expect(lines.at(-1)).toBe(" /honcho login · /honcho logout · /honcho config · /honcho on");
  });

  it("uses the footer glyphs and colors for each state", () => {
    const tagged = taggedTheme();
    const header = (state: StatusSnapshot["state"]) =>
      formatStatusPanel(snapshot({ state, error: "why" }), 300, tagged).slice(0, 2);
    expect(header("connected")[0]).toBe(
      " <b><accent>Honcho</accent></b>  <success>● connected</success><dim> · api.honcho.dev · 142 ms</dim>",
    );
    expect(header("connected")[1]).toBe("");
    expect(header("expired")).toEqual([
      " <b><accent>Honcho</accent></b>  <warning>▲ sign-in expired</warning><dim> · api.honcho.dev · 142 ms</dim>",
      " <warning>why</warning>",
    ]);
    expect(header("unreachable")[1]).toBe(" <error>why</error>");
    expect(header("error")[0]).toContain("<error>▲ error</error>");
    expect(header("connecting")).toEqual([
      " <b><accent>Honcho</accent></b>  <accent>◐ connecting</accent><dim> · api.honcho.dev · 142 ms</dim>",
      " <dim>why</dim>",
    ]);
    expect(header("signed-out")[0]).toContain("<dim>○ not signed in</dim>");
  });

  it("shows warnings in the warning color", () => {
    const lines = formatStatusPanel(
      snapshot({ warnings: ['workspace "a b" is not a valid Honcho id; using "a-b"'] }),
      400,
      taggedTheme(),
    );
    const warning = lines.find((line) => line.includes("▲"));
    expect(warning).toBe(
      ' <warning>▲</warning> <warning>workspace</warning> <warning>"a</warning> <warning>b"</warning> <warning>is</warning> <warning>not</warning> <warning>a</warning> <warning>valid</warning> <warning>Honcho</warning> <warning>id;</warning> <warning>using</warning> <warning>"a-b"</warning>',
    );
    const wrapped = plain(
      formatStatusPanel(snapshot({ warnings: ["x ".repeat(60).trim()] }), 60, plainTheme()),
    );
    expectFits(wrapped, 60);
    expect(wrapped.filter((line) => line.startsWith("   x")).length).toBeGreaterThan(0);
  });
});

describe("login entry", () => {
  const t = plainTheme();

  it("matches the artboard at width 100", () => {
    expect(
      formatLoginEntry(login({ note: "Signed in with the honcho-cli client." }), 100, t),
    ).toEqual([
      " ✓ Signed in to Honcho as aakash",
      "   endpoint    api.honcho.dev",
      "   workspace   claude_code",
      "   peers       aakash (you) · pi (agent)",
      "   session     aakash-demo · one per directory",
      "   saved to    ~/.honcho/config.json · shared with Claude Code and Hermes",
      "   Signed in with the honcho-cli client.",
      "",
      " Change any of this with /honcho config.",
    ]);
  });

  it("styles the check, the user and the labels", () => {
    const lines = formatLoginEntry(login(), 300, taggedTheme());
    expect(lines[0]).toBe(" <success>✓</success> Signed in to Honcho as <b>aakash</b>");
    expect(lines[1]).toBe("   <dim>endpoint    </dim>api.honcho.dev");
    expect(lines.at(-1)).toBe(" <dim>Change any of this with /honcho config.</dim>");
  });

  it("wraps at width 60", () => {
    const lines = plain(formatLoginEntry(login({ strategy: "git-branch" }), 60, t));
    expectFits(lines, 60);
    expect(lines).toContain("   session     aakash-demo · one per git branch");
    expect(lines).toContain("   saved to    ~/.honcho/config.json · shared with Claude");
    expect(lines).toContain("               Code and Hermes");
  });

  it("leaves out an empty note and share list", () => {
    const lines = formatLoginEntry(login({ sharedWith: "", strategy: "chat-instance" }), 100, t);
    expect(lines).toContain("   saved to    ~/.honcho/config.json");
    expect(lines).toContain("   session     aakash-demo · one per pi session");
    expect(lines).toHaveLength(8);
  });
});

describe("layout helpers", () => {
  it("formats relative times", () => {
    const ago = (ms: number) => relativeTime(new Date(NOW - ms).toISOString(), NOW);
    expect(ago(10_000)).toBe("just now");
    expect(ago(5 * 60_000)).toBe("5 minutes ago");
    expect(ago(60 * 60_000)).toBe("1 hour ago");
    expect(ago(3 * DAY)).toBe("3 days ago");
    expect(ago(65 * DAY)).toBe("2 months ago");
    expect(ago(400 * DAY)).toBe("1 year ago");
    expect(relativeTime(undefined, NOW)).toBeUndefined();
    expect(relativeTime("not a date", NOW)).toBeUndefined();
  });

  it("right-aligns and gives way on the left", () => {
    expect(spread("left", "right", 20)).toBe("left           right");
    expect(stripTerminalSequences(spread("a much longer left side", "right", 20))).toBe(
      "a much longe…  right",
    );
    expect(stripTerminalSequences(spread("left side here", "right", 10))).toBe("left side…");
  });

  it("clips plain text without escape codes", () => {
    expect(clip("hello world", 6)).toBe("hello…");
    expect(clip("hello", 6)).toBe("hello");
    expect(clip("hello", 0)).toBe("");
  });

  it("hard-splits words longer than the width", () => {
    const lines = wrapWords(["short", "averyveryverylongword"], 7);
    expectFits(lines, 7);
    expect(lines.join("")).toContain("averyve");
  });

  it("never throws from render and cuts every line", () => {
    const component = new FormattedLines((width) => ["x".repeat(width + 5)]);
    expect(component.render(10)).toHaveLength(1);
    expectFits(component.render(10), 10);
    expect(component.render(0)).toEqual([]);
    const broken = new FormattedLines(() => {
      throw new Error("boom");
    });
    expect(broken.render(80)).toEqual([" honcho: could not render this entry"]);
  });
});

describe("registerRenderers", () => {
  const capture = () => {
    const entries = new Map<string, EntryRenderer>();
    const messages = new Map<string, MessageRenderer>();
    const pi = {
      registerEntryRenderer: (type: string, renderer: EntryRenderer) => entries.set(type, renderer),
      registerMessageRenderer: (type: string, renderer: MessageRenderer) =>
        messages.set(type, renderer),
    };
    registerRenderers(pi as unknown as ExtensionAPI);
    return { entries, messages };
  };

  const entry = (customType: string, data: unknown) =>
    ({
      type: "custom",
      customType,
      data,
      id: "e1",
      parentId: null,
      timestamp: new Date(NOW).toISOString(),
    }) as unknown as CustomEntry;

  const message = (view: TurnView) =>
    ({
      role: "custom",
      customType: "honcho-turn",
      content: view.content,
      details: view.details,
      display: true,
      timestamp: NOW,
    }) as unknown as Parameters<MessageRenderer>[0];

  it("registers every honcho type", () => {
    const { entries, messages } = capture();
    expect([...entries.keys()].sort()).toEqual(["honcho-login", "honcho-start", "honcho-status"]);
    expect([...messages.keys()]).toEqual(["honcho-turn"]);
  });

  it("renders within any width, with escape codes and without", () => {
    const { entries, messages } = capture();
    const cases = [
      () => entries.get("honcho-start"),
      () => entries.get("honcho-status"),
      () => entries.get("honcho-login"),
    ];
    const data = {
      "honcho-start": start(),
      "honcho-status": snapshot({ warnings: ["a warning that is long enough to wrap somewhere"] }),
      "honcho-login": login({ note: "note" }),
    };
    for (const theme of [plainTheme(), ansiTheme()]) {
      for (const expanded of [false, true]) {
        const components = [
          ...cases.map((get, i) =>
            get()?.(entry(Object.keys(data)[i] ?? "", Object.values(data)[i]), { expanded }, theme),
          ),
          messages.get("honcho-turn")?.(message(chat()), { expanded, outputPad: 1 }, theme),
          messages.get("honcho-turn")?.(
            message(context(CONCLUSIONS)),
            { expanded, outputPad: 1 },
            theme,
          ),
        ];
        for (const component of components) {
          expect(component).toBeDefined();
          for (const width of [120, 100, 60, 30, 12, 3, 1]) {
            expectFits(component?.render(width) ?? [], width);
          }
        }
      }
    }
  });

  it("uses ctrl+o when pi has no binding registered", () => {
    const { entries } = capture();
    const component = entries.get("honcho-start")?.(
      entry("honcho-start", start()),
      { expanded: false },
      plainTheme(),
    );
    expect(component?.render(100)[0]?.endsWith("ctrl+o expand")).toBe(true);
  });

  it("hides entries without data and survives malformed data", () => {
    const { entries } = capture();
    expect(
      entries.get("honcho-status")?.(
        entry("honcho-status", undefined),
        { expanded: false },
        plainTheme(),
      ),
    ).toBeUndefined();
    const broken = entries.get("honcho-status")?.(
      entry("honcho-status", { state: "connected" }),
      { expanded: false },
      plainTheme(),
    );
    expect(broken?.render(80)).toEqual([" honcho: could not render this entry"]);
    const legacy = entries.get("honcho-start")?.(
      entry("honcho-start", {
        peer: "a",
        session: "s",
        peerCardSelected: true,
        summarySelected: true,
      }),
      { expanded: true },
      plainTheme(),
    );
    expect(legacy?.render(80).join("\n")).toContain("nothing stored yet for a");
  });

  it("honors outputPad for the turn message", () => {
    const { messages } = capture();
    const component = messages.get("honcho-turn")?.(
      message(chat()),
      { expanded: false, outputPad: 0 },
      plainTheme(),
    );
    expect(component?.render(80)[0]?.startsWith("◆ honcho")).toBe(true);
  });
});

describe("pending turn line", () => {
  it("matches the footer's working copy in the turn card's slot", () => {
    const t = plainTheme();
    expect(formatPendingLine("checking memory", 1_234, 0, 100, t)).toBe(
      " ◐ honcho  checking memory · 1.2s",
    );
    expect(formatPendingLine("checking memory", 0, 1, 100, t)).toContain("◓ honcho");
    expect(formatPendingLine("loading context", 0, 0, 100, taggedTheme())).toBe(
      " <accent>◐ honcho</accent><dim>  loading context · 0.0s</dim>",
    );
  });

  it("fits narrow widths", () => {
    expectFits([formatPendingLine("checking memory", 12_345, 0, 20, plainTheme())], 20);
  });
});
