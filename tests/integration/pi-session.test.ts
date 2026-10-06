import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomEntry, CustomMessageEntry } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { discover } from "../../extensions/auth/oauth.js";
import honcho from "../../extensions/index.js";
import type { StartEntryData, TurnDetails } from "../../extensions/memory.js";
import { PENDING_WIDGET_KEY } from "../../extensions/ui/pending.js";
import { MockHoncho } from "./mock-honcho.js";
import { declaredTools, messageText, startPi, systemSections } from "./pi-harness.js";
import type { PiHarness, ProviderRequest } from "./pi-harness.js";

const TIMEOUT = 5_000;
const API_KEY = "hch-test-key";
const SESSION = "user-proj";
const HONCHO_TOOLS = ["honcho_chat", "honcho_search"];

const mock = new MockHoncho();
const savedEnv = { ...process.env };
let root = "";
let configPath = "";
let current: PiHarness | undefined;

const restoreEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
};

beforeAll(async () => {
  await mock.start();
  root = mkdtempSync(join(tmpdir(), "pi-honcho-it-"));
  configPath = join(root, ".honcho", "config.json");
  mkdirSync(join(root, ".honcho"), { recursive: true });
  // The extension reads process.env directly; nothing may reach the real ~/.honcho or ~/.pi
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("HONCHO_") || key.startsWith("PI_")) delete process.env[key];
  }
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.HONCHO_CONFIG_PATH = configPath;
  process.env.HONCHO_BASE_URL = mock.baseUrl;
});

afterAll(async () => {
  restoreEnv();
  await mock.stop();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  mock.reset();
});

afterEach(async () => {
  await current?.shutdown();
  current = undefined;
});

/** Writes `~/.honcho/config.json` with a pi-scoped key; `pi` merges into `hosts.pi`. */
const writeConfig = (pi: Record<string, unknown> = {}) => {
  const config = {
    peerName: "user",
    hosts: { pi: { apiKey: API_KEY, workspace: "testws", aiPeer: "ai", ...pi } },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
};

const boot = async (pi: Record<string, unknown> = {}): Promise<PiHarness> => {
  writeConfig(pi);
  current = await startPi({
    cwd: join(root, "proj"),
    agentDir: join(root, "agent"),
    extension: honcho,
  });
  return current;
};

const startEntries = (pi: PiHarness) =>
  pi
    .entries()
    .filter(
      (e): e is CustomEntry<StartEntryData> =>
        e.type === "custom" && e.customType === "honcho-start",
    );

const turnMessages = (pi: PiHarness) =>
  pi
    .entries()
    .filter(
      (e): e is CustomMessageEntry<TurnDetails> =>
        e.type === "custom_message" && e.customType === "honcho-turn",
    );

/** The `n`th request the model received. */
const request = (pi: PiHarness, n = 0): ProviderRequest => {
  const found = pi.requests[n];
  if (!found) {
    throw new Error(`the model received ${pi.requests.length} requests, not ${n + 1}`);
  }
  return found;
};

const userTexts = (req: ProviderRequest) =>
  req.messages.filter((m) => m.role === "user").map(messageText);

const lastAssistantText = (pi: PiHarness) => pi.session.getLastAssistantText();

const savedMessages = () =>
  mock
    .calls("messages")
    .flatMap((r) => (r.body as { messages: Record<string, unknown>[] }).messages);

const honchoToolsActive = (pi: PiHarness) =>
  pi.session.getActiveToolNames().filter((name) => HONCHO_TOOLS.includes(name));

describe("pi-honcho inside a real pi 1.0 session", () => {
  it(
    "injects startup memory and per-turn dialectic recall, then saves the exchange",
    { timeout: TIMEOUT },
    async () => {
      const prompt = "How should I structure the retry queue?";
      const answer = "Ada prefers small, reviewable diffs and bounded queues.";
      mock.data.peerCard = ["Name: Ada", "Prefers pnpm over npm"];
      mock.data.longSummary = { content: "Refactored the retry queue to use exponential backoff." };
      mock.data.shortSummary = { content: "Short version." };
      mock.data.chatAnswer = answer;
      mock.data.conclusionTotal = 1284;

      const pi = await boot();
      pi.script("Use a bounded queue with jittered backoff.");
      await pi.session.prompt(prompt);

      // Connection: get-or-create peers, then the session with the ai peer unobserved
      const peerBodies = mock.calls("peer").map((r) => r.body);
      expect(peerBodies).toEqual(expect.arrayContaining([{ id: "user" }, { id: "ai" }]));
      for (const body of peerBodies) {
        expect([{ id: "user" }, { id: "ai" }]).toContainEqual(body);
      }
      const sessions = mock.calls("session");
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.params.workspace).toBe("testws");
      expect(sessions[0]?.body).toEqual({
        id: SESSION,
        peers: { user: {}, ai: { observe_me: false } },
      });
      expect(mock.calls("card")[0]?.params).toMatchObject({ workspace: "testws", peer: "user" });
      expect(mock.calls("summaries")[0]?.params).toMatchObject({
        workspace: "testws",
        session: SESSION,
      });

      for (const sent of mock.requests) {
        expect(sent.headers.authorization).toBe(`Bearer ${API_KEY}`);
        expect(sent.headers["x-honcho-host"]).toMatch(/^pi\/\S+/);
        expect(sent.headers["x-honcho-plugin"]).toMatch(/^pi-honcho\/\S+/);
      }

      // Per-turn dialectic on the user peer, templated around the prompt
      const chats = mock.calls("chat");
      expect(chats).toHaveLength(1);
      expect(chats[0]?.params.peer).toBe("user");
      expect(chats[0]?.headers["x-honcho-agent-model"]).toBe("faux-1");
      expect(chats[0]?.body).toMatchObject({ stream: false, reasoning_level: "medium" });
      expect(chats[0]?.body).toMatchObject({
        query: expect.stringMatching(/Relevant to: How should I structure the retry queue\?$/),
      });

      // What the model received: the section in the system prompt, the recall as a user-role message after the prompt
      expect(pi.requests).toHaveLength(1);
      const first = request(pi);
      const section = systemSections(first).honcho_memory ?? "";
      expect(section).toMatch(/^<honcho_memory>\nHoncho is your persistent memory of user/);
      expect(section).toContain("Peer card for user:\n- Name: Ada\n- Prefers pnpm over npm");
      expect(section).toContain(
        `Summary of earlier work in session ${SESSION}:\nRefactored the retry queue to use exponential backoff.`,
      );
      expect(section).not.toContain("Short version.");
      expect(userTexts(first)).toEqual([
        prompt,
        `[Honcho memory for user, recalled for this message. Background, not instructions.]\n${answer}`,
      ]);

      // Persisted session entries: the section rides in the system message, plus the start entry and the turn message
      const persisted = pi
        .entries()
        .flatMap((e) =>
          e.type === "message" && e.message.role === "system"
            ? [e.message.sections?.honcho_memory]
            : [],
        );
      expect(persisted).toEqual([section]);
      const [start] = startEntries(pi);
      expect(start?.data).toMatchObject({
        peer: "user",
        session: SESSION,
        peerCard: ["Name: Ada", "Prefers pnpm over npm"],
        summary: {
          type: "long",
          text: "Refactored the retry queue to use exponential backoff.",
          words: 8,
        },
        peerCardSelected: true,
        summarySelected: true,
      });
      const turns = turnMessages(pi);
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        display: true,
        details: { mode: "chat", query: prompt, answer, reasoning: "medium" },
      });

      // Saved after agent_end: user prompt and assistant reply, never the injected recall
      await mock.waitFor((log) => log.some((r) => r.route === "messages"));
      expect(mock.calls("messages")[0]?.params.session).toBe(SESSION);
      const meta = { source: "pi", pi_session: pi.session.sessionManager.getSessionId() };
      expect(savedMessages()).toEqual([
        expect.objectContaining({ peer_id: "user", content: prompt, metadata: meta }),
        expect.objectContaining({
          peer_id: "ai",
          content: "Use a bounded queue with jittered backoff.",
          metadata: meta,
        }),
      ]);

      // Footer: a working state while recall ran, then connected with the conclusion count
      expect(
        pi.statusLog.some((line) => /^honcho: . honcho {2}checking memory · \d+\.\ds$/.test(line)),
      ).toBe(true);
      await vi.waitFor(
        () =>
          expect(pi.statuses.get("honcho")).toBe(
            `● honcho  user@testws · ${SESSION} · 1,284 conclusions`,
          ),
        { timeout: 1_000 },
      );
    },
  );

  it(
    "shows the prompt above the editor while per-turn recall blocks it",
    { timeout: TIMEOUT },
    async () => {
      mock.data.chatAnswer = "Keeps retry settings in config.ts.";
      mock.fail("chat", { delayMs: 300, times: 1 });
      const pi = await boot();
      pi.script("ok");
      const shownAtRender: boolean[] = [];
      pi.session.subscribe((event) => {
        if (event.type === "message_start" && event.message.role === "user") {
          shownAtRender.push(pi.widgets.has(PENDING_WIDGET_KEY));
        }
      });

      const run = pi.session.prompt("Where do the retry settings live?");
      await mock.waitFor((log) => log.some((r) => r.route === "chat"));
      expect(pi.widgets.has(PENDING_WIDGET_KEY)).toBe(true);
      expect(pi.entries().some((e) => e.type === "message")).toBe(false);
      await run;

      // Gone before pi renders the real message, so the two never show at once
      expect(shownAtRender).toEqual([false]);
      expect(pi.widgets.has(PENDING_WIDGET_KEY)).toBe(false);
      expect(turnMessages(pi)).toHaveLength(1);
    },
  );

  it(
    "keeps the startup section stable across turns without refetching it",
    { timeout: TIMEOUT },
    async () => {
      mock.data.peerCard = ["Name: Ada"];
      mock.data.chatAnswer = (body) =>
        `recall for: ${String(body.query).split("Relevant to: ")[1]}`;

      const pi = await boot();
      pi.script("first reply", "second reply");
      await pi.session.prompt("Where do the retry settings live?");
      await pi.session.prompt("And how are retries logged?");

      expect(mock.calls("card")).toHaveLength(1);
      expect(mock.calls("summaries")).toHaveLength(1);
      expect(mock.calls("session")).toHaveLength(1);
      expect(mock.calls("chat")).toHaveLength(2);
      expect(pi.requests).toHaveLength(2);
      const [first, second] = [request(pi, 0), request(pi, 1)];
      expect(systemSections(second).honcho_memory).toBe(systemSections(first).honcho_memory);
      // An unchanged section is not re-sent as a new system message
      expect(second.messages.filter((m) => m.role === "system")).toHaveLength(1);
      expect(userTexts(second).at(-1)).toContain("recall for: And how are retries logged?");
      expect(turnMessages(pi)).toHaveLength(2);

      await mock.waitFor((log) => log.filter((r) => r.route === "messages").length === 2);
      expect(savedMessages().map((m) => m.content)).toEqual([
        "Where do the retry settings live?",
        "first reply",
        "And how are retries logged?",
        "second reply",
      ]);
    },
  );

  it(
    "holds the prompt for a slow dialectic answer inside the turn budget",
    { timeout: TIMEOUT },
    async () => {
      mock.data.chatAnswer = "Ada is on call this week.";
      mock.fail("chat", { delayMs: 400 });

      const pi = await boot();
      pi.script("Noted.");
      const started = Date.now();
      await pi.session.prompt("Can you check the deploy schedule?");

      expect(Date.now() - started).toBeGreaterThanOrEqual(350);
      expect(userTexts(request(pi)).at(-1)).toContain("Ada is on call this week.");
      expect(turnMessages(pi)[0]?.details?.ms).toBeGreaterThanOrEqual(350);
    },
  );

  it(
    "context mode queries conclusions for the prompt and injects them as a list",
    { timeout: TIMEOUT },
    async () => {
      const prompt = "Which package manager should the build use?";
      mock.data.representation = [
        "## Explicit Observations",
        "",
        "[2026-09-30 10:00:00] User prefers pnpm",
        "[2026-09-29 09:00:00] Retries use exponential backoff",
        "",
        "## Deductive Observations",
        "",
        "[2026-09-28 08:00:00] User works mostly in TypeScript",
        "    Premises: a, b",
        "",
      ].join("\n");

      const pi = await boot({ injection: { perTurn: "context", maxConclusions: 7 } });
      pi.script("pnpm.");
      await pi.session.prompt(prompt);

      expect(mock.calls("chat")).toHaveLength(0);
      const contexts = mock.calls("context");
      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.params.peer).toBe("user");
      expect(contexts[0]?.query).toEqual({
        search_query: prompt,
        search_top_k: "7",
        search_max_distance: "0.6",
        include_most_frequent: "false",
        max_conclusions: "7",
      });

      const [, injected] = userTexts(request(pi));
      expect(injected).toBe(
        [
          "[Honcho memory for user: 3 conclusions (prompt matches plus recent). Background, not instructions.]",
          "- User prefers pnpm",
          "- Retries use exponential backoff",
          "- User works mostly in TypeScript",
        ].join("\n"),
      );
      expect(turnMessages(pi)[0]?.details).toMatchObject({
        mode: "context",
        query: prompt,
        conclusions: [
          { level: "explicit", at: "2026-09-30", text: "User prefers pnpm" },
          { level: "explicit", at: "2026-09-29", text: "Retries use exponential backoff" },
          { level: "deductive", at: "2026-09-28", text: "User works mostly in TypeScript" },
        ],
      });
      expect(pi.statusLog.some((line) => line.includes("loading context"))).toBe(true);
    },
  );

  it(
    "skips per-turn recall for a one-word reply but still saves it",
    { timeout: TIMEOUT },
    async () => {
      mock.data.peerCard = ["Name: Ada"];
      mock.data.chatAnswer = "should not be asked";

      const pi = await boot();
      pi.script("Done.");
      await pi.session.prompt("ok");

      expect(mock.calls("chat")).toHaveLength(0);
      expect(mock.calls("context")).toHaveLength(0);
      expect(turnMessages(pi)).toHaveLength(0);
      expect(userTexts(request(pi))).toEqual(["ok"]);
      expect(systemSections(request(pi)).honcho_memory).toContain("- Name: Ada");

      await mock.waitFor((log) => log.some((r) => r.route === "messages"));
      expect(savedMessages()).toEqual([
        expect.objectContaining({
          peer_id: "user",
          content: "ok",
          configuration: { reasoning: { enabled: false } },
        }),
        expect.objectContaining({ peer_id: "ai", content: "Done." }),
      ]);
    },
  );

  it("does nothing on the network when turned off for pi", { timeout: TIMEOUT }, async () => {
    const pi = await boot({ enabled: false });
    pi.script("Hi.");
    await pi.session.prompt("Tell me about this repository");
    await pi.shutdown();

    expect(mock.requests).toEqual([]);
    expect(systemSections(request(pi))).not.toHaveProperty("honcho_memory");
    expect(userTexts(request(pi))).toEqual(["Tell me about this repository"]);
    expect(startEntries(pi)).toHaveLength(0);
    expect(turnMessages(pi)).toHaveLength(0);
    expect(honchoToolsActive(pi)).toEqual([]);
    expect(pi.statuses.get("honcho")).toBe("○ honcho  off · /honcho on");
  });

  it(
    "continues the turn without recall when the dialectic call fails",
    { timeout: TIMEOUT },
    async () => {
      mock.data.peerCard = ["Name: Ada"];
      mock.fail("chat", { status: 500, detail: "dialectic exploded" });

      const pi = await boot();
      pi.script("Answer without memory.");
      await pi.session.prompt("Summarize the open retry issues");

      expect(mock.calls("chat")).toHaveLength(1);
      expect(lastAssistantText(pi)).toBe("Answer without memory.");
      expect(userTexts(request(pi))).toEqual(["Summarize the open retry issues"]);
      expect(systemSections(request(pi)).honcho_memory).toContain("- Name: Ada");
      expect(turnMessages(pi)).toHaveLength(0);
      expect(pi.notifications).toContainEqual({
        message: "honcho: memory check failed (dialectic exploded); continuing without it",
        type: "warning",
      });
    },
  );

  // A dialectic 5xx marks the runtime unreachable, so agent_end skips the upload; drop .fails once the turn is saved.
  it("still saves the exchange when per-turn recall fails", { timeout: TIMEOUT }, async () => {
    mock.fail("chat", { status: 500, detail: "dialectic exploded" });

    const pi = await boot();
    pi.script("Answer without memory.");
    await pi.session.prompt("Summarize the open retry issues");
    await pi.shutdown();

    expect(savedMessages().map((m) => m.content)).toEqual([
      "Summarize the open retry issues",
      "Answer without memory.",
    ]);
  });

  it(
    "injects nothing and shows the error when the API key is rejected at startup",
    { timeout: TIMEOUT },
    async () => {
      mock.fail("workspace", { status: 401, detail: "Invalid JWT" });

      const pi = await boot();
      pi.script("Hi.");
      await pi.session.prompt("What did we decide about retries?");
      await pi.shutdown();

      const { host } = new URL(mock.baseUrl);
      expect(mock.calls("workspace").length).toBeGreaterThan(0);
      expect(mock.routes().every((route) => route === "workspace")).toBe(true);
      expect(systemSections(request(pi))).not.toHaveProperty("honcho_memory");
      expect(userTexts(request(pi))).toEqual(["What did we decide about retries?"]);
      expect(startEntries(pi)).toHaveLength(0);
      expect(turnMessages(pi)).toHaveLength(0);
      // The footer mirrors runtime.phase === "error"
      expect(pi.statuses.get("honcho")).toBe(`▲ honcho  ${host} rejected the key: Invalid JWT`);
    },
  );

  // Runtime.syncTools only hides the tools when off or signed out; drop .fails once the error phase hides them too.
  it("hides the tools when the API key is rejected", { timeout: TIMEOUT }, async () => {
    mock.fail("workspace", { status: 401, detail: "Invalid JWT" });

    const pi = await boot();
    pi.script("Hi.");
    await pi.session.prompt("What did we decide about retries?");

    expect(honchoToolsActive(pi)).toEqual([]);
    expect(declaredTools(request(pi)).filter((name) => HONCHO_TOOLS.includes(name))).toEqual([]);
  });

  it(
    "lets the model ask honcho_chat several questions and search with honcho_search",
    { timeout: TIMEOUT },
    async () => {
      const answers: Record<string, string> = {
        "What editor does the user use?": "Neovim, with a minimal config.",
        "How does the user like commits?": "Small conventional commits, one concern each.",
      };
      mock.data.chatAnswer = (body) => answers[String(body.query)] ?? null;
      mock.data.searchMessages = [
        {
          id: "m1",
          content: "We agreed retries cap at 5 attempts.",
          peerId: "user",
          sessionId: SESSION,
          createdAt: "2026-09-20T10:00:00Z",
        },
      ];
      mock.data.conclusions = [{ id: "c1", content: "User caps retries at 5 attempts" }];

      const pi = await boot({ injection: { perTurn: "off" } });
      const { fauxToolCall } = pi.faux;
      pi.script(
        [
          fauxToolCall(
            "honcho_chat",
            {
              questions: [
                { question: "What editor does the user use?", reasoning_level: "low" },
                { question: "How does the user like commits?", reasoning_level: "high" },
              ],
            },
            { id: "call-chat" },
          ),
          fauxToolCall("honcho_search", { query: "retry cap" }, { id: "call-search" }),
        ],
        "Neovim, small commits, and retries cap at 5.",
      );
      await pi.session.prompt("Remind me of my setup before we start");

      expect(honchoToolsActive(pi).sort()).toEqual(HONCHO_TOOLS);
      expect(pi.requests).toHaveLength(2);
      const [first, second] = [request(pi, 0), request(pi, 1)];
      expect(declaredTools(first)).toEqual(expect.arrayContaining(HONCHO_TOOLS));

      // One dialectic call per question, each at its own reasoning level; no per-turn recall
      const chats = mock.calls("chat").map((r) => ({ peer: r.params.peer, body: r.body }));
      expect(chats).toHaveLength(2);
      expect(chats).toEqual(
        expect.arrayContaining([
          {
            peer: "user",
            body: {
              query: "What editor does the user use?",
              stream: false,
              reasoning_level: "low",
            },
          },
          {
            peer: "user",
            body: {
              query: "How does the user like commits?",
              stream: false,
              reasoning_level: "high",
            },
          },
        ]),
      );
      expect(mock.calls("session.search")[0]).toMatchObject({
        params: { session: SESSION },
        body: { query: "retry cap", limit: 10 },
      });
      expect(mock.calls("conclusions.query")[0]?.body).toMatchObject({
        query: "retry cap",
        top_k: 10,
        filters: { observer_id: "user", observed_id: "user" },
      });

      // The follow-up request carries both tool results
      const results = second.messages.filter((m) => m.role === "toolResult");
      const chatResult = results.find((m) => m.toolName === "honcho_chat");
      const searchResult = results.find((m) => m.toolName === "honcho_search");
      expect(chatResult?.isError).toBe(false);
      expect(searchResult?.isError).toBe(false);
      const chatText = messageText(chatResult ?? { role: "toolResult", content: "" });
      expect(chatText).toMatch(/^recalled 2 answers · 2 questions\n/);
      expect(chatText).toMatch(
        /q1 \[low\] "What editor does the user use\?" \(\d+\.\ds\)\nNeovim, with a minimal config\./,
      );
      expect(chatText).toMatch(
        /q2 \[high\] "How does the user like commits\?" \(\d+\.\ds\)\nSmall conventional commits, one concern each\./,
      );
      const searchText = messageText(searchResult ?? { role: "toolResult", content: "" });
      expect(searchText).toContain(
        "Messages (1):\n[2026-09-20 user] We agreed retries cap at 5 attempts.",
      );
      expect(searchText).toContain("Conclusions (1):\n- User caps retries at 5 attempts");
      expect(lastAssistantText(pi)).toBe("Neovim, small commits, and retries cap at 5.");
    },
  );

  it(
    "finds no OAuth server on the mock, so sign-in is API key only",
    { timeout: TIMEOUT },
    async () => {
      expect(await discover(mock.baseUrl)).toBeNull();
      expect(mock.routes()).toEqual(["oauth.discovery"]);
    },
  );
});
