import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { abortable } from "../honcho.js";
import { TOOL_NAMES } from "../runtime.js";
import { ensureActive } from "./common.js";
import type { ToolRuntime } from "./common.js";
import {
  GUTTER_WIDTH,
  Lines,
  capLines,
  clip,
  errorLines,
  hanging,
  isoDate,
  plural,
  rightAlign,
  toolTitle,
  withExpandHint,
  withGutter,
} from "./render.js";

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;
/** Characters kept per message or conclusion, in the model text and in details. */
export const MAX_CONTENT = 500;
const MAX_ROW_LINES = 3;

export type SearchScope = "session" | "workspace";

// No minimum/maximum keywords: they make Anthropic send the tool non-strict, so execute clamps
export const searchParameters = Type.Object({
  query: Type.String({ description: "What to look for, in plain words" }),
  limit: Type.Optional(
    Type.Integer({
      description: `Max results for messages and for conclusions, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT})`,
    }),
  ),
  scope: Type.Optional(
    Type.Unsafe<SearchScope>({
      type: "string",
      enum: ["session", "workspace"],
      description:
        "Where to search messages: 'session' (default) for this session, 'workspace' for every session",
    }),
  ),
});

export type SearchParams = Static<typeof searchParameters>;

export interface SearchMessage {
  peerId: string;
  createdAt: string;
  content: string;
}

export interface SearchConclusion {
  content: string;
  createdAt: string;
}

export interface SearchDetails {
  query: string;
  scope: SearchScope;
  messages: SearchMessage[];
  conclusions: SearchConclusion[];
}

export const SEARCH_DESCRIPTION = [
  "Search Honcho, the user's persistent memory, for past messages and saved conclusions about the user.",
  "Messages come from this session by default; set scope to 'workspace' to search every session.",
  "Conclusions are always searched across all sessions.",
  "Results come back most relevant first, without scores.",
].join(" ");

export const clampLimit = (limit: number | undefined): number => {
  const n = Math.trunc(limit ?? DEFAULT_LIMIT);
  return Number.isFinite(n) ? Math.min(MAX_LIMIT, Math.max(1, n)) : DEFAULT_LIMIT;
};

const truncate = (text: string): string =>
  text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT - 1)}…` : text;

/** Model-facing text: both groups, or one line when nothing matched. */
export const formatSearchResult = (details: SearchDetails): string => {
  const { messages, conclusions } = details;
  if (!messages.length && !conclusions.length) {
    return "No matching messages or conclusions.";
  }
  const lines: string[] = [];
  if (messages.length) {
    lines.push(`Messages (${messages.length}):`);
    for (const m of messages) {
      const stamp = [isoDate(m.createdAt), m.peerId].filter(Boolean).join(" ");
      lines.push(`[${stamp}] ${clip(m.content, MAX_CONTENT)}`);
    }
  } else {
    lines.push(
      details.scope === "session"
        ? "Messages (0): none in this session. Use scope 'workspace' to search every session."
        : "Messages (0): none.",
    );
  }
  lines.push("");
  if (conclusions.length) {
    lines.push(
      `Conclusions (${conclusions.length}):`,
      ...conclusions.map((c) => `- ${clip(c.content, MAX_CONTENT)}`),
    );
  } else {
    lines.push("Conclusions (0): none.");
  }
  return lines.join("\n");
};

export const runSearch = async (
  runtime: ToolRuntime,
  params: SearchParams,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<SearchDetails>> => {
  await ensureActive(runtime);
  const query = params.query.trim();
  if (!query) {
    throw new Error("query is empty");
  }
  const limit = clampLimit(params.limit);
  const scope: SearchScope = params.scope === "workspace" ? "workspace" : "session";
  const [messages, conclusions] = await abortable(
    runtime.call((c) =>
      Promise.all([
        scope === "workspace"
          ? c.clients.fast.search(query, { limit })
          : c.session.search(query, { limit }),
        // Peer- and session-scoped keys can't query conclusions
        c.userPeer.conclusions.query(query, limit).catch(() => []),
      ]),
    ),
    signal,
  );
  const details: SearchDetails = {
    query,
    scope,
    messages: messages.map((m) => ({
      peerId: m.peerId,
      createdAt: m.createdAt,
      content: truncate(m.content),
    })),
    conclusions: conclusions.map((c) => ({ content: truncate(c.content), createdAt: c.createdAt })),
  };
  return { content: [{ type: "text", text: formatSearchResult(details) }], details };
};

export const renderSearchCall = (
  args: Partial<SearchParams> | undefined,
  theme: Theme,
): Component =>
  new Lines((width) => {
    let line = toolTitle(TOOL_NAMES.search, theme);
    if (args?.query) {
      line += theme.fg("dim", ` "${args.query.replace(/\s+/g, " ").trim()}"`);
    }
    if (args?.scope === "workspace") {
      line += theme.fg("dim", " · workspace");
    }
    return [rightAlign(line, "", width)];
  });

const summary = (details: SearchDetails): string =>
  `${plural(details.messages.length, "message")} · ${plural(details.conclusions.length, "conclusion")}`;

const groupLines = (details: SearchDetails, inner: number, theme: Theme): string[] => {
  const lines: string[] = [];
  if (details.messages.length) {
    lines.push(theme.fg("accent", theme.bold("Messages")));
    for (const m of details.messages) {
      const date = isoDate(m.createdAt);
      const stamp = `${date ? `${theme.fg("dim", date)}  ` : ""}${theme.fg("accent", m.peerId)}  `;
      lines.push(
        ...capLines(
          hanging(stamp, "  ", clip(m.content, MAX_CONTENT), inner),
          MAX_ROW_LINES,
          inner,
        ),
      );
    }
  }
  if (details.conclusions.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push(theme.fg("accent", theme.bold("Conclusions")));
    for (const c of details.conclusions) {
      const date = isoDate(c.createdAt);
      const first = date ? `${theme.fg("dim", date)}  ` : `${theme.fg("dim", "-")} `;
      lines.push(
        ...capLines(
          hanging(first, "  ", clip(c.content, MAX_CONTENT), inner),
          MAX_ROW_LINES,
          inner,
        ),
      );
    }
  }
  return lines;
};

/** Pure layout of the result block, shared by the renderer and tests. */
export const searchResultLines = (
  details: SearchDetails,
  expanded: boolean,
  width: number,
  theme: Theme,
): string[] => {
  if (!details.messages.length && !details.conclusions.length) {
    return [` ${theme.fg("dim", "no matching messages or conclusions")}`];
  }
  const lines = [withExpandHint(` ${theme.fg("dim", summary(details))}`, expanded, width, theme)];
  if (expanded) {
    lines.push(...withGutter(groupLines(details, Math.max(1, width - GUTTER_WIDTH), theme), theme));
  }
  return lines;
};

const isSearchDetails = (details: unknown): details is SearchDetails =>
  typeof details === "object" &&
  details !== null &&
  "messages" in details &&
  "conclusions" in details &&
  Array.isArray(details.messages) &&
  Array.isArray(details.conclusions);

export const renderSearchResult = (
  result: AgentToolResult<unknown>,
  opts: { expanded: boolean; isPartial: boolean },
  theme: Theme,
): Component => {
  const { details } = result;
  if (!isSearchDetails(details)) {
    if (opts.isPartial) {
      return new Lines(() => []);
    }
    return new Lines((width) =>
      errorLines(
        result,
        { expanded: opts.expanded, prefix: " ", fallback: "honcho_search failed" },
        width,
        theme,
      ),
    );
  }
  return new Lines((width) => searchResultLines(details, opts.expanded, width, theme));
};

export const createSearchTool = (runtime: ToolRuntime) =>
  defineTool<typeof searchParameters, SearchDetails>({
    name: TOOL_NAMES.search,
    label: "Honcho",
    description: SEARCH_DESCRIPTION,
    promptSnippet: "Search Honcho memory for past messages and saved conclusions about the user",
    promptGuidelines: [
      "Use honcho_search to find specific past messages or facts by keyword; use honcho_chat when you need Honcho to reason over the user's history.",
    ],
    parameters: searchParameters,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    annotations: { readOnlyHint: true, openWorldHint: true },
    execute: (_id, params, signal) => runSearch(runtime, params, signal),
    renderCall: (args, theme) => renderSearchCall(args, theme),
    renderResult: (result, opts, theme) => renderSearchResult(result, opts, theme),
  });
