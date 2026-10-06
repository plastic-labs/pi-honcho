import { Peer } from "@honcho-ai/sdk";
import type { Session } from "@honcho-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CHUNK,
  UploadQueue,
  chunkText,
  extractMessages,
  toInputs,
  uploadBatches,
} from "../extensions/capture.js";
import type { UploadTarget } from "../extensions/capture.js";

afterEach(() => {
  vi.useRealTimers();
});

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (content: unknown[], over: Record<string, unknown> = {}) => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  usage,
  stopReason: "stop",
  timestamp: 1_790_000_002_000,
  ...over,
});

/** One agent run as pi reports it in `agent_end`. */
const RUN: unknown[] = [
  { role: "user", content: "Add a retry to the token refresh", timestamp: 1_790_000_000_000 },
  {
    role: "custom",
    customType: "honcho-turn",
    content:
      "[Honcho memory for aakash, recalled for this message. Background, not instructions.]\n- Prefers pnpm",
    display: true,
    timestamp: 1_790_000_000_500,
  },
  assistant(
    [
      { type: "thinking", thinking: "Let me read config.ts first", thinkingSignature: "sig" },
      { type: "text", text: "Reading config.ts first." },
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "config.ts" } },
    ],
    { stopReason: "toolUse", timestamp: 1_790_000_001_000 },
  ),
  {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    content: [{ type: "text", text: "export const refresh = ..." }],
    isError: false,
    timestamp: 1_790_000_001_500,
  },
  assistant([
    { type: "text", text: "I wrapped refreshAccessToken in a retry." },
    { type: "text", text: "Tests pass." },
  ]),
];

describe("extractMessages", () => {
  it("keeps user and assistant text from a realistic run", () => {
    expect(extractMessages(RUN)).toEqual([
      { role: "user", text: "Add a retry to the token refresh", timestamp: 1_790_000_000_000 },
      { role: "assistant", text: "Reading config.ts first.", timestamp: 1_790_000_001_000 },
      {
        role: "assistant",
        text: "I wrapped refreshAccessToken in a retry.\nTests pass.",
        timestamp: 1_790_000_002_000,
      },
    ]);
  });

  it("joins user text blocks and marks images", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this screenshot?" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          { type: "text", text: "And this one?" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
        timestamp: 1,
      },
    ];
    expect(extractMessages(messages)).toEqual([
      {
        role: "user",
        text: "What is in this screenshot?\n[image]\nAnd this one?\n[image]",
        timestamp: 1,
      },
    ]);
  });

  it("skips error and aborted assistant turns", () => {
    const messages = [
      assistant([{ type: "text", text: "partial" }], {
        stopReason: "error",
        errorMessage: "overloaded",
      }),
      assistant([{ type: "text", text: "cut off" }], { stopReason: "aborted" }),
      assistant([{ type: "text", text: "kept" }], { stopReason: "length" }),
    ];
    expect(extractMessages(messages).map((m) => m.text)).toEqual(["kept"]);
  });

  it("drops empty, whitespace-only and tool-only messages", () => {
    const messages = [
      { role: "user", content: "   ", timestamp: 1 },
      { role: "user", content: [], timestamp: 2 },
      assistant([{ type: "toolCall", id: "t", name: "bash", arguments: {} }]),
      assistant([{ type: "thinking", thinking: "hmm" }]),
      assistant([{ type: "text", text: "  \n " }]),
    ];
    expect(extractMessages(messages)).toEqual([]);
  });

  it("ignores roles it does not save and malformed blocks", () => {
    const messages = [
      { role: "bashExecution", command: "ls", output: "a", exitCode: 0, timestamp: 1 },
      { role: "compactionSummary", summary: "s", timestamp: 2 },
      { role: "custom", customType: "other", content: "x", display: false, timestamp: 3 },
      {
        role: "user",
        content: [null, { type: "text" }, { type: "text", text: "ok" }],
        timestamp: 4,
      },
    ];
    expect(extractMessages(messages)).toEqual([{ role: "user", text: "ok", timestamp: 4 }]);
  });
});

describe("chunkText", () => {
  it("returns short text unchanged", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
    const exact = "x".repeat(MAX_CHUNK);
    expect(chunkText(exact)).toEqual([exact]);
  });

  it("splits at newlines, prefixes parts and stays under the 25k server limit", () => {
    const line = `${"a".repeat(999)}\n`;
    const text = line.repeat(60);
    const parts = chunkText(text);
    expect(parts.length).toBe(3);
    parts.forEach((part, i) => {
      expect(part.startsWith(`[Part ${i + 1}/3] `)).toBe(true);
      expect(part.length).toBeLessThanOrEqual(MAX_CHUNK);
      expect(part.length).toBeLessThan(25_000);
    });
    // Nothing but the separators is lost
    const joined = parts.map((p) => p.replace(/^\[Part \d+\/\d+\] /, "")).join("\n");
    expect(joined.replace(/\n/g, "")).toBe(text.replace(/\n/g, ""));
  });

  it("falls back to spaces, then a hard cut", () => {
    const words = Array.from({ length: 6_000 }, (_, i) => `w${i}`).join(" ");
    const byWord = chunkText(words);
    expect(byWord.length).toBeGreaterThan(1);
    for (const part of byWord) {
      expect(part.length).toBeLessThanOrEqual(MAX_CHUNK);
      expect(part.replace(/^\[Part \d+\/\d+\] /, "")).toMatch(/^w\d+( w\d+)*$/);
    }
    const blob = "z".repeat(60_000);
    const hard = chunkText(blob);
    expect(hard.map((p) => p.length)).toEqual([
      MAX_CHUNK - 16 + 11,
      MAX_CHUNK - 16 + 11,
      60_000 - 2 * (MAX_CHUNK - 16) + 11,
    ]);
    expect(hard.map((p) => p.replace(/^\[Part \d+\/\d+\] /, "")).join("")).toBe(blob);
  });

  it("keeps two-digit part prefixes under the limit", () => {
    const parts = chunkText("q".repeat(MAX_CHUNK * 11), MAX_CHUNK);
    expect(parts.length).toBe(12);
    expect(parts[11]?.startsWith("[Part 12/12] ")).toBe(true);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_CHUNK);
    }
  });

  it("honors a custom max", () => {
    const parts = chunkText("abc def ghi jkl mno pqr stu vwx", 30);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(30);
    }
  });
});

describe("toInputs", () => {
  const target = (): UploadTarget => ({
    session: {} as Session,
    userPeer: new Peer("aakash", "ws", {} as never),
    aiPeer: new Peer("pi", "ws", {} as never),
  });

  it("maps roles to peers with metadata and timestamps", () => {
    const inputs = toInputs(
      target(),
      [
        { role: "user", text: "Add a retry", timestamp: 1_790_000_000_000 },
        { role: "assistant", text: "Done." },
      ],
      { source: "pi", pi_session: "abc" },
    );
    expect(inputs).toEqual([
      {
        peerId: "aakash",
        content: "Add a retry",
        metadata: { source: "pi", pi_session: "abc" },
        configuration: undefined,
        createdAt: new Date(1_790_000_000_000).toISOString(),
      },
      {
        peerId: "pi",
        content: "Done.",
        metadata: { source: "pi", pi_session: "abc" },
        configuration: undefined,
        createdAt: undefined,
      },
    ]);
  });

  it("turns off deriver reasoning for trivial user replies only", () => {
    const inputs = toInputs(
      target(),
      [
        { role: "user", text: "ok" },
        { role: "user", text: "Go ahead!" },
        { role: "user", text: "ok, but rename it first" },
        { role: "assistant", text: "ok" },
      ],
      {},
    );
    expect(inputs.map((i) => i.configuration)).toEqual([
      { reasoning: { enabled: false } },
      { reasoning: { enabled: false } },
      undefined,
      undefined,
    ]);
  });

  it("chunks long messages into several inputs", () => {
    const inputs = toInputs(target(), [{ role: "assistant", text: "y".repeat(MAX_CHUNK * 2) }], {});
    expect(inputs).toHaveLength(3);
    expect(inputs.every((i) => i.peerId === "pi" && i.content.length <= MAX_CHUNK)).toBe(true);
  });
});

describe("uploadBatches", () => {
  it("sends batches of at most 100 in order", async () => {
    const sizes: number[] = [];
    const firsts: string[] = [];
    const session = {
      addMessages: vi.fn(async (batch: { content: string }[]) => {
        sizes.push(batch.length);
        firsts.push(batch[0]?.content ?? "");
        return [];
      }),
    } as unknown as Session;
    const inputs = Array.from({ length: 250 }, (_, i) => ({ peerId: "p", content: `m${i}` }));
    await uploadBatches(session, inputs);
    expect(sizes).toEqual([100, 100, 50]);
    expect(firsts).toEqual(["m0", "m100", "m200"]);
  });

  it("stops at the first failing batch", async () => {
    let calls = 0;
    const session = {
      addMessages: async () => {
        calls += 1;
        if (calls === 2) {
          throw new Error("500");
        }
        return [];
      },
    } as unknown as Session;
    await expect(
      uploadBatches(
        session,
        Array.from({ length: 300 }, () => ({ peerId: "p", content: "x" })),
      ),
    ).rejects.toThrow("500");
    expect(calls).toBe(2);
  });
});

describe("UploadQueue", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("runs tasks one at a time in enqueue order", async () => {
    const queue = new UploadQueue(() => {});
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await sleep(ms);
      log.push(`end ${name}`);
    };
    queue.enqueue(task("a", 30));
    queue.enqueue(task("b", 5));
    queue.enqueue(task("c", 1));
    expect(queue.busy).toBe(true);
    await queue.flush();
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(queue.busy).toBe(false);
  });

  it("reports a failure and keeps going", async () => {
    const errors: unknown[] = [];
    const queue = new UploadQueue((e) => errors.push(e));
    const ran: string[] = [];
    queue.enqueue(async () => {
      throw new Error("first failed");
    });
    queue.enqueue(async () => {
      ran.push("second");
    });
    await queue.flush();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("first failed");
    expect(ran).toEqual(["second"]);
    expect(queue.busy).toBe(false);
  });

  it("flush gives up after the timeout without cancelling the task", async () => {
    vi.useFakeTimers();
    const queue = new UploadQueue(() => {});
    let finished = false;
    queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      finished = true;
    });
    let flushed = false;
    void queue.flush(5_000).then(() => (flushed = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(flushed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(flushed).toBe(true);
    expect(finished).toBe(false);
    expect(queue.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finished).toBe(true);
    expect(queue.busy).toBe(false);
  });

  it("flush resolves immediately when idle", async () => {
    const queue = new UploadQueue(() => {});
    const started = Date.now();
    await queue.flush(5_000);
    expect(Date.now() - started).toBeLessThan(100);
  });
});
