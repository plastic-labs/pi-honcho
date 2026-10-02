import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection, HonchoRuntime } from "../extensions/runtime.js";
import { resolveSettings } from "../extensions/settings.js";
import type { ReasoningLevel } from "../extensions/settings.js";
import { registerTools } from "../extensions/tools.js";
import {
  chatParameters,
  chatResultLines,
  createChatTool,
  renderChatCall,
  renderChatResult,
  runChat,
} from "../extensions/tools/chat.js";
import type { ChatDetails, ChatParams } from "../extensions/tools/chat.js";
import type { ToolRuntime } from "../extensions/tools/common.js";
import {
  clampLimit,
  createSearchTool,
  renderSearchCall,
  renderSearchResult,
  runSearch,
  searchParameters,
  searchResultLines,
} from "../extensions/tools/search.js";
import type { SearchDetails } from "../extensions/tools/search.js";
import { plainTheme, taggedTheme } from "./helpers/theme.js";

const plain = plainTheme();

/** Mirrors pi-ai's validateToolArguments: convert, then check. */
const accepts = (schema: TSchema, args: unknown): boolean => {
  const copy = structuredClone(args);
  Value.Convert(schema, copy);
  return Compile(schema).Check(copy);
};

// Keywords that make Anthropic fall back to a non-strict tool (pi-ai anthropic-messages.js)
const NON_STRICT = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
  "uniqueItems",
]);
const nonStrictKeys = (schema: unknown, path = "$"): string[] => {
  if (typeof schema !== "object" || schema === null) {
    return [];
  }
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (NON_STRICT.has(key) || (key === "minItems" && value !== 0 && value !== 1)) {
      found.push(`${path}.${key}`);
    }
    found.push(...nonStrictKeys(value, `${path}.${key}`));
  }
  return found;
};

const edge = (left: string, right: string, width: number): string =>
  left + " ".repeat(width - left.length - right.length) + right;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

interface FakeOptions {
  active?: boolean;
  reasoning?: ReasoningLevel;
  chat?: (question: string, opts: { reasoningLevel?: string }) => Promise<string | null>;
  sessionSearch?: (query: string, opts: { limit?: number }) => Promise<unknown[]>;
  workspaceSearch?: (query: string, opts: { limit?: number }) => Promise<unknown[]>;
  conclusions?: (query: string, topK?: number) => Promise<unknown[]>;
}

const fakeRuntime = (opts: FakeOptions = {}) => {
  const chat = vi.fn(opts.chat ?? (async () => "an answer"));
  const sessionSearch = vi.fn(opts.sessionSearch ?? (async () => []));
  const workspaceSearch = vi.fn(opts.workspaceSearch ?? (async () => []));
  const conclusionsQuery = vi.fn(opts.conclusions ?? (async () => []));
  const connection = {
    dialecticPeer: { chat },
    userPeer: { conclusions: { query: conclusionsQuery } },
    session: { search: sessionSearch },
    clients: { fast: { search: workspaceSearch } },
  } as unknown as Connection;
  const settings = resolveSettings({}, {});
  if (opts.reasoning) {
    settings.injection.reasoning = opts.reasoning;
  }
  const ready = vi.fn(async (_ms: number) => undefined);
  const runtime = {
    active: opts.active ?? true,
    ready,
    describeUnavailable: () => "Not signed in to Honcho. Run /honcho login.",
    call: <T>(fn: (c: Connection) => Promise<T>) => fn(connection),
    settings,
  };
  return {
    runtime: runtime as unknown as ToolRuntime,
    chat,
    sessionSearch,
    workspaceSearch,
    conclusionsQuery,
    ready,
  };
};

const textOf = (result: AgentToolResult<unknown>): string => {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
};

const ctx = {} as ExtensionToolContext;

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("registerTools", () => {
  it("registers both tools, read-only, left to syncTools for activation", () => {
    const registerTool = vi.fn();
    registerTools(
      { registerTool } as unknown as ExtensionAPI,
      fakeRuntime().runtime as unknown as HonchoRuntime,
    );
    const [chat, search] = registerTool.mock.calls.map(
      (call) => call[0] as Record<string, unknown>,
    );
    expect(chat?.name).toBe("honcho_chat");
    expect(search?.name).toBe("honcho_search");
    for (const tool of [chat, search]) {
      expect(tool?.label).toBe("Honcho");
      expect(tool?.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
      expect(tool?.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
      expect(tool).not.toHaveProperty("defaultActive");
      expect(tool?.promptSnippet).toBeTruthy();
    }
    expect(chat?.promptGuidelines).toContain(
      "Don't ask Honcho about things the conversation already shows; use it for what happened outside this session.",
    );
  });
});

describe("honcho_chat schema", () => {
  it("accepts 1+ questions with optional per-question levels", () => {
    expect(
      accepts(chatParameters, { questions: [{ question: "What does the user prefer?" }] }),
    ).toBe(true);
    expect(
      accepts(chatParameters, {
        questions: [
          { question: "a", reasoning_level: "high" },
          { question: "b", reasoning_level: "minimal" },
        ],
      }),
    ).toBe(true);
    // More than 5 is accepted by the schema and clamped in execute
    expect(
      accepts(chatParameters, {
        questions: Array.from({ length: 7 }, (_, i) => ({ question: `q${i}` })),
      }),
    ).toBe(true);
  });

  it("rejects empty lists, unknown levels and malformed questions", () => {
    expect(accepts(chatParameters, { questions: [] })).toBe(false);
    expect(
      accepts(chatParameters, { questions: [{ question: "a", reasoning_level: "extreme" }] }),
    ).toBe(false);
    expect(accepts(chatParameters, { questions: [{ reasoning_level: "low" }] })).toBe(false);
    expect(accepts(chatParameters, { questions: "what?" })).toBe(false);
    expect(accepts(chatParameters, {})).toBe(false);
  });

  it("stays strict-compatible: a bare string enum and no maxItems", () => {
    expect(nonStrictKeys(chatParameters)).toEqual([]);
    const json = JSON.parse(JSON.stringify(chatParameters)) as {
      properties: {
        questions: {
          minItems: number;
          items: { properties: { reasoning_level: { type: string; enum: string[] } } };
        };
      };
    };
    const { questions } = json.properties;
    expect(questions.items.properties.reasoning_level.type).toBe("string");
    expect(questions.items.properties.reasoning_level.enum).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(questions.minItems).toBe(1);
  });
});

describe("honcho_search schema", () => {
  it("accepts a query with optional limit and scope", () => {
    expect(accepts(searchParameters, { query: "retry" })).toBe(true);
    expect(accepts(searchParameters, { query: "retry", limit: 100, scope: "workspace" })).toBe(
      true,
    );
    expect(accepts(searchParameters, { query: "retry", limit: "5" })).toBe(true);
  });

  it("rejects unknown scopes, non-numeric limits and a missing query", () => {
    expect(accepts(searchParameters, { query: "retry", scope: "global" })).toBe(false);
    expect(accepts(searchParameters, { query: "retry", limit: "lots" })).toBe(false);
    expect(accepts(searchParameters, { limit: 5 })).toBe(false);
  });

  it("has no min/max keywords", () => {
    expect(nonStrictKeys(searchParameters)).toEqual([]);
  });
});

describe("honcho_chat execute", () => {
  const QUESTIONS: ChatParams = {
    questions: [
      { question: "What did aakash decide about session naming?", reasoning_level: "medium" },
      { question: "  Which harnesses share the config file?  " },
      { question: "How should config precedence read?", reasoning_level: "high" },
    ],
  };

  it("asks every question in parallel against the whole peer and streams each answer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    const pending = new Map<string, ReturnType<typeof deferred<string | null>>>();
    const { runtime, chat, ready } = fakeRuntime({
      reasoning: "low",
      chat: (question) => {
        const d = deferred<string | null>();
        pending.set(question, d);
        return d.promise;
      },
    });
    const onUpdate = vi.fn();
    const run = createChatTool(runtime).execute("call-1", QUESTIONS, undefined, onUpdate, ctx);
    await flush();

    expect(ready).toHaveBeenCalledWith(5_000);
    expect(chat).toHaveBeenCalledTimes(3);
    expect(chat.mock.calls).toEqual([
      ["What did aakash decide about session naming?", { reasoningLevel: "medium" }],
      ["Which harnesses share the config file?", { reasoningLevel: "low" }],
      ["How should config precedence read?", { reasoningLevel: "high" }],
    ]);

    vi.setSystemTime(t0 + 900);
    pending.get("Which harnesses share the config file?")?.resolve(null);
    await flush();
    vi.setSystemTime(t0 + 3_100);
    pending
      .get("What did aakash decide about session naming?")
      ?.resolve("  Per-directory by default, same as Claude Code.  ");
    await flush();
    vi.setSystemTime(t0 + 5_600);
    pending.get("How should config precedence read?")?.reject(new Error("boom"));
    const result = await run;

    expect(textOf(result)).toBe(
      [
        "recalled 1 answer · 3 questions",
        "",
        'q1 [medium] "What did aakash decide about session naming?" (3.1s)',
        "Per-directory by default, same as Claude Code.",
        "",
        'q2 [low] "Which harnesses share the config file?" (0.9s)',
        "(Honcho has nothing on this)",
        "",
        'q3 [high] "How should config precedence read?" (5.6s)',
        "(failed: boom)",
      ].join("\n"),
    );
    expect(result.isError).toBeUndefined();
    expect(result.details).toEqual({
      ms: 5_600,
      words: 7,
      questions: [
        {
          question: "What did aakash decide about session naming?",
          level: "medium",
          ms: 3_100,
          words: 7,
          answer: "Per-directory by default, same as Claude Code.",
        },
        { question: "Which harnesses share the config file?", level: "low", ms: 900, words: 0 },
        { question: "How should config precedence read?", level: "high", ms: 5_600, error: "boom" },
      ],
    });

    // One update up front, then one per settled question
    expect(onUpdate).toHaveBeenCalledTimes(4);
    const settledCounts = onUpdate.mock.calls.map(
      (call) =>
        (call[0] as AgentToolResult<ChatDetails>).details.questions.filter(
          (q) => q.ms !== undefined,
        ).length,
    );
    expect(settledCounts).toEqual([0, 1, 2, 3]);
    expect(textOf(onUpdate.mock.calls[1]?.[0] as AgentToolResult<ChatDetails>)).toBe(
      "1/3 answered",
    );
  });

  it("asks only the first 5 questions and says so", async () => {
    const { runtime, chat } = fakeRuntime();
    const questions = Array.from({ length: 7 }, (_, i) => ({ question: `question ${i + 1}` }));
    const result = await runChat(runtime, { questions }, undefined, undefined);
    expect(chat).toHaveBeenCalledTimes(5);
    expect(chat.mock.calls.map((call) => call[0])).toEqual([
      "question 1",
      "question 2",
      "question 3",
      "question 4",
      "question 5",
    ]);
    expect(result.details.questions).toHaveLength(5);
    expect(result.details.skipped).toBe(2);
    const lines = textOf(result).split("\n");
    expect(lines[0]).toBe("recalled 5 answers · 5 questions");
    expect(lines[1]).toBe(
      "Only the first 5 questions were asked; 2 more questions were skipped. Ask them in another call if you still need them.",
    );
  });

  it("marks the result as an error only when every question failed", async () => {
    const { runtime } = fakeRuntime({ chat: async () => Promise.reject(new Error("Invalid JWT")) });
    const result = await runChat(
      runtime,
      { questions: [{ question: "a" }, { question: "b" }] },
      undefined,
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("(failed: Invalid JWT)");
    expect(textOf(result).split("\n")[0]).toBe("recalled 0 answers · 2 questions");
  });

  it("fails an empty question without asking Honcho", async () => {
    const { runtime, chat } = fakeRuntime();
    const result = await runChat(
      runtime,
      { questions: [{ question: "   " }, { question: "real" }] },
      undefined,
      undefined,
    );
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.details.questions[0]?.error).toBe("empty question");
    expect(result.isError).toBeUndefined();
  });

  it("gives up on a question after 120s and keeps the others", async () => {
    vi.useFakeTimers();
    const { runtime } = fakeRuntime({
      chat: (question) =>
        question === "slow" ? new Promise(() => {}) : Promise.resolve("fast answer"),
    });
    const run = runChat(
      runtime,
      { questions: [{ question: "slow" }, { question: "fast" }] },
      undefined,
      undefined,
    );
    await vi.advanceTimersByTimeAsync(120_000);
    const result = await run;
    expect(result.details.questions[0]).toMatchObject({
      question: "slow",
      error: "timed out after 120s",
      ms: 120_000,
    });
    expect(result.details.questions[1]).toMatchObject({ question: "fast", answer: "fast answer" });
    expect(result.isError).toBeUndefined();
  });

  it("stops waiting when the call is aborted", async () => {
    vi.useFakeTimers();
    const { runtime } = fakeRuntime({ chat: () => new Promise(() => {}) });
    const controller = new AbortController();
    const onUpdate = vi.fn();
    const run = runChat(
      runtime,
      { questions: [{ question: "hangs" }] },
      controller.signal,
      onUpdate,
    );
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expect(run).rejects.toThrow("Aborted");
    // Only the initial progress update; nothing after the abort
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("throws the runtime's reason when Honcho is unavailable", async () => {
    const { runtime, chat, ready } = fakeRuntime({ active: false });
    await expect(
      runChat(runtime, { questions: [{ question: "a" }] }, undefined, undefined),
    ).rejects.toThrow("Not signed in to Honcho. Run /honcho login.");
    expect(ready).toHaveBeenCalledWith(5_000);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("honcho_search execute", () => {
  const message = (peerId: string, createdAt: string, content: string) => ({
    peerId,
    createdAt,
    content,
    id: "m",
    sessionId: "s",
  });
  const conclusion = (content: string, createdAt: string) => ({
    content,
    createdAt,
    id: "c",
    level: "explicit",
  });

  it("searches this session's messages and conclusions in parallel", async () => {
    const { runtime, sessionSearch, workspaceSearch, conclusionsQuery } = fakeRuntime({
      sessionSearch: async () => [
        message("aakash", "2026-09-28T10:00:00Z", "Add a retry\nto the token refresh"),
        message("pi", "2026-09-27T09:00:00Z", "Wrapping refreshAccessToken in a retry."),
      ],
      conclusions: async () => [
        conclusion("Retries use exponential backoff, capped at 3", "2026-09-20T00:00:00Z"),
      ],
    });
    const result = await createSearchTool(runtime).execute(
      "call-2",
      { query: " retry " },
      undefined,
      undefined,
      ctx,
    );
    expect(sessionSearch).toHaveBeenCalledWith("retry", { limit: 10 });
    expect(workspaceSearch).not.toHaveBeenCalled();
    expect(conclusionsQuery).toHaveBeenCalledWith("retry", 10);
    expect(textOf(result)).toBe(
      [
        "Messages (2):",
        "[2026-09-28 aakash] Add a retry to the token refresh",
        "[2026-09-27 pi] Wrapping refreshAccessToken in a retry.",
        "",
        "Conclusions (1):",
        "- Retries use exponential backoff, capped at 3",
      ].join("\n"),
    );
    expect(result.details).toEqual({
      query: "retry",
      scope: "session",
      messages: [
        {
          peerId: "aakash",
          createdAt: "2026-09-28T10:00:00Z",
          content: "Add a retry\nto the token refresh",
        },
        {
          peerId: "pi",
          createdAt: "2026-09-27T09:00:00Z",
          content: "Wrapping refreshAccessToken in a retry.",
        },
      ],
      conclusions: [
        {
          content: "Retries use exponential backoff, capped at 3",
          createdAt: "2026-09-20T00:00:00Z",
        },
      ],
    });
  });

  it("searches every session with scope workspace and clamps the limit", async () => {
    const { runtime, sessionSearch, workspaceSearch, conclusionsQuery } = fakeRuntime();
    await runSearch(runtime, { query: "retry", scope: "workspace", limit: 100 }, undefined);
    expect(workspaceSearch).toHaveBeenCalledWith("retry", { limit: 50 });
    expect(conclusionsQuery).toHaveBeenCalledWith("retry", 50);
    expect(sessionSearch).not.toHaveBeenCalled();
    expect([
      clampLimit(undefined),
      clampLimit(0),
      clampLimit(-3),
      clampLimit(7),
      clampLimit(51),
    ]).toEqual([10, 1, 1, 7, 50]);
  });

  it("says when nothing matched, and survives a conclusions failure", async () => {
    const { runtime } = fakeRuntime({ conclusions: async () => Promise.reject(new Error("401")) });
    const result = await runSearch(runtime, { query: "nothing here" }, undefined);
    expect(textOf(result)).toBe("No matching messages or conclusions.");
    expect(result.details.conclusions).toEqual([]);
  });

  it("points at workspace scope when the session has no messages", async () => {
    const { runtime } = fakeRuntime({
      conclusions: async () => [conclusion("Uses pnpm", "2026-09-20T00:00:00Z")],
    });
    const result = await runSearch(runtime, { query: "pnpm" }, undefined);
    expect(textOf(result)).toBe(
      [
        "Messages (0): none in this session. Use scope 'workspace' to search every session.",
        "",
        "Conclusions (1):",
        "- Uses pnpm",
      ].join("\n"),
    );
  });

  it("truncates long content in the text and the details", async () => {
    const long = "x".repeat(800);
    const { runtime } = fakeRuntime({
      sessionSearch: async () => [message("aakash", "2026-09-28T10:00:00Z", long)],
    });
    const result = await runSearch(runtime, { query: "x" }, undefined);
    expect(result.details.messages[0]?.content).toHaveLength(500);
    expect(result.details.messages[0]?.content.endsWith("…")).toBe(true);
    expect(textOf(result).split("\n")[1]).toBe(`[2026-09-28 aakash] ${"x".repeat(499)}…`);
  });

  it("rejects an empty query and an unavailable runtime", async () => {
    await expect(runSearch(fakeRuntime().runtime, { query: "  " }, undefined)).rejects.toThrow(
      "query is empty",
    );
    await expect(
      runSearch(fakeRuntime({ active: false }).runtime, { query: "a" }, undefined),
    ).rejects.toThrow("Not signed in to Honcho");
  });
});

const CHAT_DETAILS: ChatDetails = {
  ms: 5_600,
  words: 735,
  questions: [
    {
      question: "What did aakash decide about session naming for the pi integration?",
      level: "medium",
      ms: 3_100,
      words: 310,
      answer: [
        "## Session naming for pi",
        "",
        "aakash chose **per-directory** as the default, matching Claude Code.",
        "- **git-branch**: opt-in, one session per branch.",
        "- **chat-instance**: one session per pi run.",
        "",
        "Based on 2 sessions, most recent `2026-09-28`.",
      ].join("\n"),
    },
    {
      question: "Which harnesses share aakash's Honcho config file?",
      level: "low",
      ms: 900,
      words: 70,
      answer: "Claude Code, Hermes and pi all read ~/.honcho/config.json.",
    },
    {
      question: "How does aakash want config precedence explained to users?",
      level: "high",
      ms: 5_600,
      error: "timed out after 120s",
    },
  ],
};

const Q1 = '"What did aakash decide about session naming for the pi integration?"';
const Q2 = `"Which harnesses share aakash's Honcho config file?"`;
const Q3 = '"How does aakash want config precedence explained to users?"';
const HEADER = "honcho_chat  3 questions in parallel · 5.6s · 735 words";

describe("honcho_chat renderers", () => {
  it("collapsed at 100: header with ctrl+o hint, one row per question", () => {
    expect(
      chatResultLines(CHAT_DETAILS, { expanded: false, isPartial: false }, 100, plain),
    ).toEqual([
      edge(HEADER, "ctrl+o expand", 100),
      "",
      edge(` ▸ medium  ${Q1}`, "3.1s · 310 words", 100),
      edge(` ▸ low     ${Q2}`, "0.9s · 70 words", 100),
      edge(` ▸ high    ${Q3}`, "failed", 100),
    ]);
  });

  it("expanded at 100: answers under a gutter, markdown flattened", () => {
    expect(chatResultLines(CHAT_DETAILS, { expanded: true, isPartial: false }, 100, plain)).toEqual(
      [
        edge(HEADER, "ctrl+o collapse", 100),
        "",
        edge(` ▾ medium  ${Q1}`, "3.1s · 310 words", 100),
        "   │ Session naming for pi",
        "   │",
        "   │ aakash chose per-directory as the default, matching Claude Code.",
        "   │ - git-branch: opt-in, one session per branch.",
        "   │ - chat-instance: one session per pi run.",
        "   │",
        "   │ Based on 2 sessions, most recent 2026-09-28.",
        "",
        edge(` ▾ low     ${Q2}`, "0.9s · 70 words", 100),
        "   │ Claude Code, Hermes and pi all read ~/.honcho/config.json.",
        "",
        edge(` ▾ high    ${Q3}`, "failed", 100),
        "   │ failed: timed out after 120s",
      ],
    );
  });

  it("collapsed at 60: drops the hint, cuts questions to keep the timing", () => {
    const lines = chatResultLines(CHAT_DETAILS, { expanded: false, isPartial: false }, 60, plain);
    expect(lines).toEqual([
      HEADER,
      "",
      edge(' ▸ medium  "What did aakash decide about…"', "3.1s · 310 words", 60),
      edge(` ▸ low     "Which harnesses share aakash'…"`, "0.9s · 70 words", 60),
      edge(' ▸ high    "How does aakash want config precedence…"', "failed", 60),
    ]);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
    // Between the two, only the key fits
    expect(chatResultLines(CHAT_DETAILS, { expanded: false, isPartial: false }, 64, plain)[0]).toBe(
      edge(HEADER, "ctrl+o", 64),
    );
  });

  it("expanded at 60: wraps answers and repeats cut questions in full", () => {
    const lines = chatResultLines(CHAT_DETAILS, { expanded: true, isPartial: false }, 60, plain);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
    expect(lines.slice(2, 13)).toEqual([
      edge(' ▾ medium  "What did aakash decide about…"', "3.1s · 310 words", 60),
      "   │ asked  What did aakash decide about session naming for",
      "   │        the pi integration?",
      "   │",
      "   │ Session naming for pi",
      "   │",
      "   │ aakash chose per-directory as the default, matching",
      "   │ Claude Code.",
      "   │ - git-branch: opt-in, one session per branch.",
      "   │ - chat-instance: one session per pi run.",
      "   │",
    ]);
    expect(lines.at(-1)).toBe("   │ failed: timed out after 120s");
  });

  it("partial: the call line counts progress, rows show what's still asking", () => {
    const state: { progress?: { done: number; total: number } } = {};
    const args = { questions: [{ question: "a" }, { question: "b" }, { question: "c" }] };
    const call = renderChatCall(args, plain, { isPartial: true, state });
    expect(call.render(100)).toEqual(["honcho_chat  3 questions in parallel"]);

    const partial: ChatDetails = {
      ms: 1_000,
      words: 70,
      questions: [
        { question: "a", level: "medium" },
        { question: "b", level: "low", ms: 900, words: 70, answer: "b answer" },
        { question: "c", level: "high" },
      ],
    };
    const result = renderChatResult(
      { content: [], details: partial },
      { expanded: false, isPartial: true },
      plain,
      { state },
    );
    // The call component reads progress when it renders, after renderResult ran
    expect(call.render(100)).toEqual(["honcho_chat  3 questions in parallel · 1/3 done"]);
    expect(result.render(60)).toEqual([
      edge(' ▸ medium  "a"', "asking…", 60),
      edge(' ▸ low     "b"', "0.9s · 70 words", 60),
      edge(' ▸ high    "c"', "asking…", 60),
    ]);
    expect(renderChatCall(args, plain, { isPartial: false, state }).render(100)).toEqual([]);
  });

  it("one question reads as singular, with no progress count", () => {
    const state = { progress: { done: 0, total: 1 } };
    expect(
      renderChatCall({ questions: [{ question: "a" }] }, plain, { isPartial: true, state }).render(
        100,
      ),
    ).toEqual(["honcho_chat  1 question"]);
  });

  it("shows a thrown error in place of the header", () => {
    const failed = {
      content: [{ type: "text" as const, text: "Not signed in to Honcho. Run /honcho login." }],
      details: {},
    };
    expect(
      renderChatResult(failed, { expanded: false, isPartial: false }, plain, { state: {} }).render(
        100,
      ),
    ).toEqual(["honcho_chat  Not signed in to Honcho. Run /honcho login."]);
  });

  it("survives malformed details from an older session", () => {
    const odd = { content: [], details: { questions: [{ level: "low" }], ms: 1, words: 0 } };
    expect(
      renderChatResult(odd, { expanded: true, isPartial: false }, plain, { state: {} }).render(60),
    ).toEqual([" honcho: could not render this result"]);
  });

  it("caps a long error at 3 lines until expanded", () => {
    const text =
      'Validation failed for tool "honcho_chat":\n  - questions: must not be empty\n\nReceived arguments:\n{\n  "questions": []\n}';
    const failed = { content: [{ type: "text" as const, text }], details: {} };
    const collapsed = renderChatResult(failed, { expanded: false, isPartial: false }, plain, {
      state: {},
    }).render(60);
    expect(collapsed).toHaveLength(3);
    expect(collapsed[0]).toBe('honcho_chat  Validation failed for tool "honcho_chat":');
    expect(collapsed[2]?.endsWith("…")).toBe(true);
    const expanded = renderChatResult(failed, { expanded: true, isPartial: false }, plain, {
      state: {},
    }).render(60);
    expect(expanded.length).toBeGreaterThan(3);
  });

  it("renders numbered items, nested bullets and italics; drops rules", () => {
    const answer = "1. **First** thing\n2. Second *thing*\n---\n- outer\n  - inner";
    const details: ChatDetails = {
      ms: 10,
      words: 9,
      questions: [{ question: "q", level: "low", ms: 10, words: 9, answer }],
    };
    expect(chatResultLines(details, { expanded: true, isPartial: true }, 60, plain)).toEqual([
      edge(' ▾ low     "q"', "0.0s · 9 words", 60),
      "   │ 1. First thing",
      "   │ 2. Second thing",
      "   │",
      "   │ - outer",
      "   │   - inner",
    ]);
  });

  it("uses theme tokens for title, carets, levels, gutter and markdown", () => {
    const tagged = chatResultLines(
      CHAT_DETAILS,
      { expanded: true, isPartial: false },
      400,
      taggedTheme(),
    ).join("\n");
    expect(tagged).toContain("<toolTitle><b>honcho_chat</b></toolTitle>");
    expect(tagged).toContain("<accent>▾</accent> <accent>medium  </accent>");
    expect(tagged).toContain("<error>failed</error>");
    expect(tagged).toContain("<accent>│</accent> <accent><b>Session naming for pi</b></accent>");
    expect(tagged).toContain("<dim>-</dim> <b>git-branch</b>: opt-in");
    expect(tagged).toContain("<warning>2026-09-28</warning>");
    expect(tagged).toContain("<dim>ctrl+o </dim>collapse");
  });
});

const SEARCH_DETAILS: SearchDetails = {
  query: "retry",
  scope: "session",
  messages: [
    {
      peerId: "aakash",
      createdAt: "2026-09-28T10:00:00Z",
      content: "Add a retry to the token refresh in config.ts",
    },
    {
      peerId: "pi",
      createdAt: "2026-09-27T09:00:00Z",
      content: "I'll wrap refreshAccessToken in a retry with backoff. ".repeat(6),
    },
  ],
  conclusions: [
    { content: "Runs tests with pnpm test, never npm", createdAt: "2026-09-20T00:00:00Z" },
  ],
};

describe("honcho_search renderers", () => {
  it("call line shows the query and a non-default scope", () => {
    expect(renderSearchCall({ query: "retry  backoff" }, plain).render(100)).toEqual([
      'honcho_search "retry backoff"',
    ]);
    expect(renderSearchCall({ query: "retry", scope: "workspace" }, plain).render(100)).toEqual([
      'honcho_search "retry" · workspace',
    ]);
    const long = renderSearchCall({ query: "x".repeat(200) }, plain).render(60);
    expect(visibleWidth(long[0] ?? "")).toBeLessThanOrEqual(60);
  });

  it("collapsed: counts with the ctrl+o hint", () => {
    expect(searchResultLines(SEARCH_DETAILS, false, 100, plain)).toEqual([
      edge(" 2 messages · 1 conclusion", "ctrl+o expand", 100),
    ]);
    expect(searchResultLines(SEARCH_DETAILS, false, 60, plain)).toEqual([
      edge(" 2 messages · 1 conclusion", "ctrl+o expand", 60),
    ]);
  });

  it("expanded at 100: both groups under a gutter, long messages capped at 3 lines", () => {
    expect(searchResultLines(SEARCH_DETAILS, true, 100, plain)).toEqual([
      edge(" 2 messages · 1 conclusion", "ctrl+o collapse", 100),
      "   │ Messages",
      "   │ 2026-09-28  aakash  Add a retry to the token refresh in config.ts",
      "   │ 2026-09-27  pi  I'll wrap refreshAccessToken in a retry with backoff. I'll wrap",
      "   │   refreshAccessToken in a retry with backoff. I'll wrap refreshAccessToken in a",
      "   │   retry with backoff. I'll wrap refreshAccessToken in a retry with backoff. I'll …",
      "   │",
      "   │ Conclusions",
      "   │ 2026-09-20  Runs tests with pnpm test, never npm",
    ]);
  });

  it("expanded at 60 stays within width", () => {
    const lines = searchResultLines(SEARCH_DETAILS, true, 60, plain);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
    expect(lines).toContain("   │ Conclusions");
  });

  it("empty results and errors", () => {
    const empty = { ...SEARCH_DETAILS, messages: [], conclusions: [] };
    expect(searchResultLines(empty, true, 100, plain)).toEqual([
      " no matching messages or conclusions",
    ]);
    const failed = { content: [{ type: "text" as const, text: "query is empty" }], details: {} };
    expect(
      renderSearchResult(failed, { expanded: false, isPartial: false }, plain).render(60),
    ).toEqual([" query is empty"]);
    expect(
      renderSearchResult(
        { content: [], details: {} },
        { expanded: false, isPartial: true },
        plain,
      ).render(60),
    ).toEqual([]);
  });
});
