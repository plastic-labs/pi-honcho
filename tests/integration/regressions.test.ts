import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomMessageEntry, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HonchoError, UnprocessableEntityError } from "@honcho-ai/sdk";
import type { Peer } from "@honcho-ai/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collapseSkillBlock, extractMessages } from "../../extensions/capture.js";
import { errorMessage } from "../../extensions/honcho.js";
import honcho from "../../extensions/index.js";
import {
  MAX_QUERY_CHARS,
  applyTemplate,
  buildQuery,
  clampText,
  recallForTurn,
} from "../../extensions/memory.js";
import type { TurnDetails } from "../../extensions/memory.js";
import { HonchoRuntime } from "../../extensions/runtime.js";
import { DEFAULT_DIALECTIC_TEMPLATE, resolveSettings } from "../../extensions/settings.js";
import { MockHoncho } from "./mock-honcho.js";
import { messageText, startPi, systemSections } from "./pi-harness.js";
import type { PiHarness, ProviderRequest } from "./pi-harness.js";

const TIMEOUT = 5_000;
const API_KEY = "hch-test-key";
const NOT_ASKED = "the dialectic should not be asked";
const RESOURCE = { source: "test", scope: "temporary", origin: "top-level" } as const;

const mock = new MockHoncho();
const savedEnv = { ...process.env };
// The runtime is private to the extension; its start() call hands over the instance
const runtimeStart = vi.spyOn(HonchoRuntime.prototype, "start");
let root = "";
let configPath = "";
let current: PiHarness | undefined;

beforeAll(async () => {
  await mock.start();
  root = mkdtempSync(join(tmpdir(), "pi-honcho-regress-"));
  configPath = join(root, ".honcho", "config.json");
  mkdirSync(join(root, ".honcho"), { recursive: true });
  // The extension reads process.env directly; nothing may reach the real ~/.honcho or ~/.pi
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("HONCHO_") || key.startsWith("PI_")) {
      delete process.env[key];
    }
  }
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.HONCHO_CONFIG_PATH = configPath;
  process.env.HONCHO_BASE_URL = mock.baseUrl;
});

afterAll(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  runtimeStart.mockRestore();
  await mock.stop();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  mock.reset();
  runtimeStart.mockClear();
});

/** Waits until the mock has answered everything and no new requests arrive. */
const quiesce = async (): Promise<void> => {
  let seen = -1;
  for (let i = 0; i < 80; i += 1) {
    const count = mock.requests.length;
    if (count === seen && mock.requests.every((r) => r.status !== 0)) {
      return;
    }
    seen = count;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
};

afterEach(async () => {
  await current?.shutdown();
  current = undefined;
  // Startup memory and counts load in the background; keep them out of the next test's log
  await quiesce();
});

/** Writes `~/.honcho/config.json` with a pi-scoped key; `pi` merges into `hosts.pi`. */
const writeConfig = (pi: Record<string, unknown> = {}) => {
  const config = {
    peerName: "user",
    hosts: { pi: { apiKey: API_KEY, workspace: "testws", aiPeer: "ai", ...pi } },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
};

/** Boots pi with the extension; `also` runs against the same ExtensionAPI, like a second extension. */
const boot = async (
  pi: Record<string, unknown> = {},
  also?: (api: ExtensionAPI) => void,
): Promise<PiHarness> => {
  writeConfig(pi);
  current = await startPi({
    cwd: join(root, "proj"),
    agentDir: join(root, "agent"),
    extension: (api) => {
      honcho(api);
      also?.(api);
    },
  });
  return current;
};

const runtimeOf = (): HonchoRuntime => {
  const runtime = runtimeStart.mock.contexts.at(-1);
  if (!(runtime instanceof HonchoRuntime)) {
    throw new Error("the extension has not started a runtime");
  }
  return runtime;
};

const request = (pi: PiHarness, n = 0): ProviderRequest => {
  const found = pi.requests[n];
  if (!found) {
    throw new Error(`the model received ${pi.requests.length} requests, not ${n + 1}`);
  }
  return found;
};

const userTexts = (req: ProviderRequest) =>
  req.messages.filter((m) => m.role === "user").map(messageText);

const turnMessages = (pi: PiHarness) =>
  pi
    .entries()
    .filter(
      (e): e is CustomMessageEntry<TurnDetails> =>
        e.type === "custom_message" && e.customType === "honcho-turn",
    );

const savedMessages = () =>
  mock
    .calls("messages")
    .flatMap((r) => (r.body as { messages: Record<string, unknown>[] }).messages);

const waitForSaved = (count: number) => mock.waitFor(() => savedMessages().length >= count, 3_000);

const chatQueries = () =>
  mock.calls("chat").map((r) => String((r.body as { query?: unknown }).query));

const writeResource = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
};

describe("long prompts", () => {
  it("clamps the per-turn dialectic query to Honcho's limit", { timeout: TIMEOUT }, async () => {
    mock.data.chatAnswer = "Ada wrote the parser.";
    const pi = await boot();
    pi.script("Looking at it.");
    const prompt = `Why does this parse fail?\n${"x".repeat(12_000)}\nEND-OF-LOG`;
    await pi.session.prompt(prompt);

    const [query = ""] = chatQueries();
    expect(query.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(query).toContain("Relevant to: Why does this parse fail?");
    expect(query).toContain("\n[…]\n");
    expect(query.endsWith("END-OF-LOG")).toBe(true);
    expect(userTexts(request(pi)).at(-1)).toContain("Ada wrote the parser.");
    expect(pi.notifications).toEqual([]);
  });

  it("clamps the context-mode search query to 2,000 characters", { timeout: TIMEOUT }, async () => {
    const pi = await boot({ injection: { perTurn: "context" } });
    pi.script("Looking at it.");
    await pi.session.prompt(`Why does this parse fail?\n${"y".repeat(5_000)}\nEND-OF-LOG`);

    const searchQuery = mock.calls("context")[0]?.query.search_query ?? "";
    expect(searchQuery.length).toBeLessThanOrEqual(2_000);
    expect(searchQuery.startsWith("Why does this parse fail?")).toBe(true);
    expect(searchQuery.endsWith("END-OF-LOG")).toBe(true);
  });

  it("buildQuery fits a huge prompt into the default template", () => {
    const query = buildQuery(DEFAULT_DIALECTIC_TEMPLATE, `HEAD ${"a".repeat(30_000)} TAIL`);
    expect(query.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(query.startsWith(DEFAULT_DIALECTIC_TEMPLATE.replace("%{user_query}", "HEAD "))).toBe(
      true,
    );
    expect(query.endsWith(" TAIL")).toBe(true);
  });

  it("buildQuery fits a template without the placeholder and leaves short prompts alone", () => {
    const template = "Background notes about the user for:";
    const query = buildQuery(template, "b".repeat(20_000));
    expect(query.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(query.startsWith(`${template}\n\nbbb`)).toBe(true);
    expect(buildQuery(template, "short $& prompt")).toBe(
      applyTemplate(template, "short $& prompt"),
    );
    expect(buildQuery(DEFAULT_DIALECTIC_TEMPLATE, "short")).toBe(
      applyTemplate(DEFAULT_DIALECTIC_TEMPLATE, "short"),
    );
  });

  // Bug: buildQuery budgets for one copy of the prompt, so a template that uses %{user_query} twice still overflows
  it("buildQuery fits a template that repeats the placeholder", () => {
    const query = buildQuery("First %{user_query}, then again: %{user_query}", "c".repeat(20_000));
    expect(query.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
  });

  it("clampText keeps the head and tail within the budget", () => {
    const text = `${"h".repeat(3_000)}${"t".repeat(3_000)}`;
    const clamped = clampText(text, 2_000);
    expect(clamped.length).toBe(2_000);
    expect(clamped.startsWith("hhh")).toBe(true);
    expect(clamped.endsWith("ttt")).toBe(true);
    expect(clampText("short", 2_000)).toBe("short");
  });

  it("recallForTurn clamps the context search query", async () => {
    const context = vi.fn(async (_opts: { searchQuery: string }) => ({ representation: "" }));
    const peers = { userPeer: { context }, dialecticPeer: {} } as unknown as {
      userPeer: Peer;
      dialecticPeer: Peer;
    };
    const settings = resolveSettings({ hosts: { pi: { injection: { perTurn: "context" } } } }, {});
    await recallForTurn(peers, settings, "z".repeat(9_000));
    expect(context.mock.calls[0]?.[0].searchQuery.length).toBeLessThanOrEqual(2_000);
  });

  it("errorMessage reads FastAPI's array detail on a 422", () => {
    const detail = [
      {
        type: "string_too_long",
        loc: ["body", "query"],
        msg: "String should have at most 10000 characters",
      },
    ];
    expect(errorMessage(new UnprocessableEntityError("[object Object]", { detail }))).toBe(
      "query: String should have at most 10000 characters",
    );
    expect(
      errorMessage(new HonchoError("[object Object]", 422, { body: { detail: [{ msg: "bad" }] } })),
    ).toBe("bad");
    expect(errorMessage(new HonchoError("plain message", 400, { body: { detail: "x" } }))).toBe(
      "plain message",
    );
  });
});

describe("per-turn system section", () => {
  it(
    "drops the honcho_chat hint on the next turn after honcho_chat is turned off",
    { timeout: TIMEOUT },
    async () => {
      mock.data.peerCard = ["Name: Ada"];
      const pi = await boot({ injection: { perTurn: "off" } });
      pi.script("first reply", "second reply");
      await pi.session.prompt("Where do the retry settings live?");
      const before = systemSections(request(pi, 0)).honcho_memory ?? "";
      expect(before).toContain("Use honcho_chat");
      expect(before).toContain("Use honcho_search");

      writeConfig({ injection: { perTurn: "off" }, tools: { honcho_chat: false } });
      await runtimeOf().refreshSettings();
      await pi.session.prompt("And how are retries logged?");

      const after = systemSections(request(pi, 1)).honcho_memory ?? "";
      expect(after).not.toContain("honcho_chat");
      expect(after).toContain("Use honcho_search");
      expect(after).toContain("- Name: Ada");
      expect(pi.session.getActiveToolNames()).not.toContain("honcho_chat");
      // Settled without a reconnect or a refetch
      expect(mock.calls("session")).toHaveLength(1);
      expect(mock.calls("card")).toHaveLength(1);
    },
  );
});

describe("saving messages", () => {
  it(
    "saves the exchange when agent_end lands while a reconnect is in flight",
    { timeout: TIMEOUT },
    async () => {
      let atEnd: { phase: string; connected: boolean } | undefined;
      const pi = await boot({}, (api) => {
        api.on("agent_end", () => {
          const runtime = runtimeOf();
          atEnd = { phase: runtime.phase, connected: runtime.connection !== undefined };
        });
      });
      pi.script(() => {
        // A reconnect starts mid-run, as after a settings change; its first request is slow
        mock.fail("workspace", { delayMs: 300, times: 1 });
        void runtimeOf().restart();
        return "Noted, freeze starts Friday.";
      });
      await pi.session.prompt("Remember that the deploy freeze starts Friday");

      expect(atEnd).toEqual({ phase: "connecting", connected: false });
      await waitForSaved(2);
      expect(savedMessages().map((m) => m.content)).toEqual([
        "Remember that the deploy freeze starts Friday",
        "Noted, freeze starts Friday.",
      ]);
      // Uploaded through the new connection, after it came up
      const routes = mock.routes();
      expect(routes.filter((r) => r === "workspace")).toHaveLength(2);
      expect(routes.lastIndexOf("session")).toBeLessThan(routes.indexOf("messages"));
    },
  );
});

describe("skills, prompt templates and extension prompts", () => {
  it(
    "saves a prompt template as typed and never sends its body as a recall query",
    { timeout: TIMEOUT },
    async () => {
      mock.data.chatAnswer = NOT_ASKED;
      const pi = await boot();
      const template = writeResource(
        join(root, "prompts", "review.md"),
        "---\ndescription: Strict review\n---\nYou are a strict reviewer. Demand full test coverage. Focus: $ARGUMENTS\n",
      );
      pi.session.resourceLoader.extendResources({
        promptPaths: [{ path: template, metadata: RESOURCE }],
      });
      pi.script("Reviewed.");
      await pi.session.prompt("/review auth module");

      // The model gets the expanded template
      expect(userTexts(request(pi))[0]).toContain(
        "You are a strict reviewer. Demand full test coverage. Focus: auth module",
      );
      // Recall keys off the typed text, which reads as a slash command
      expect(chatQueries()).toEqual([]);
      expect(turnMessages(pi)).toHaveLength(0);
      await waitForSaved(2);
      expect(savedMessages().map((m) => [m.peer_id, m.content])).toEqual([
        ["user", "/review auth module"],
        ["ai", "Reviewed."],
      ]);
    },
  );

  it(
    "saves a skill invocation as typed instead of the skill body",
    { timeout: TIMEOUT },
    async () => {
      mock.data.chatAnswer = NOT_ASKED;
      const pi = await boot();
      const skill = writeResource(
        join(root, "skills", "deploy", "SKILL.md"),
        "---\nname: deploy\ndescription: Ship a build to an environment\n---\nRun the deploy script, then watch the dashboards.\n",
      );
      pi.session.resourceLoader.extendResources({
        skillPaths: [{ path: skill, metadata: RESOURCE }],
      });
      pi.script("Deployed.");
      await pi.session.prompt("/skill:deploy staging tonight");

      const [sent = ""] = userTexts(request(pi));
      expect(sent).toMatch(/^<skill name="deploy" location="[^"]+SKILL\.md">\n/);
      expect(sent).toContain("Run the deploy script, then watch the dashboards.");
      expect(chatQueries()).toEqual([]);
      await waitForSaved(2);
      expect(savedMessages().map((m) => [m.peer_id, m.content])).toEqual([
        ["user", "/skill:deploy staging tonight"],
        ["ai", "Deployed."],
      ]);
    },
  );

  it(
    "recalls and saves the typed text when another extension rewrites the input",
    { timeout: TIMEOUT },
    async () => {
      mock.data.chatAnswer = "Retries cap at 5.";
      const pi = await boot({}, (api) => {
        // Registered after honcho, so honcho captures the text before this rewrite
        api.on("input", (event) => ({
          action: "transform" as const,
          text: `${event.text}\n\n[open files: retry.ts, queue.ts]`,
        }));
      });
      pi.script("Five attempts.");
      await pi.session.prompt("What did we decide about retries?");

      expect(userTexts(request(pi))[0]).toBe(
        "What did we decide about retries?\n\n[open files: retry.ts, queue.ts]",
      );
      expect(chatQueries()).toEqual([
        expect.stringMatching(/Relevant to: What did we decide about retries\?$/),
      ]);
      expect(turnMessages(pi)[0]?.details?.query).toBe("What did we decide about retries?");
      await waitForSaved(2);
      expect(savedMessages().map((m) => m.content)).toEqual([
        "What did we decide about retries?",
        "Five attempts.",
      ]);
    },
  );

  it(
    "gives an extension's prompt no recall and doesn't save it as the user's words",
    { timeout: TIMEOUT },
    async () => {
      mock.data.peerCard = ["Name: Ada"];
      mock.data.chatAnswer = NOT_ASKED;
      let other: ExtensionAPI | undefined;
      const pi = await boot({}, (api) => {
        other = api;
      });
      pi.script("Here is the release summary.");
      other?.sendUserMessage("Summarize the release notes for v2");
      await vi.waitFor(() => expect(pi.requests).toHaveLength(1));
      await pi.session.waitForIdle();

      expect(userTexts(request(pi))).toEqual(["Summarize the release notes for v2"]);
      expect(chatQueries()).toEqual([]);
      expect(turnMessages(pi)).toHaveLength(0);
      await waitForSaved(1);
      expect(savedMessages().map((m) => [m.peer_id, m.content])).toEqual([
        ["ai", "Here is the release summary."],
      ]);
    },
  );

  it(
    "pairs the next typed prompt correctly after an extension's prompt",
    { timeout: TIMEOUT },
    async () => {
      mock.data.chatAnswer = "Ada owns the release.";
      let other: ExtensionAPI | undefined;
      const pi = await boot({}, (api) => {
        other = api;
      });
      pi.script("Summary.", "Ada does.");
      other?.sendUserMessage("Summarize the release notes for v2");
      await vi.waitFor(() => expect(pi.requests).toHaveLength(1));
      await pi.session.waitForIdle();
      await pi.session.prompt("Who owns the release?");

      expect(chatQueries()).toEqual([
        expect.stringMatching(/Relevant to: Who owns the release\?$/),
      ]);
      await waitForSaved(3);
      expect(savedMessages().map((m) => [m.peer_id, m.content])).toEqual([
        ["ai", "Summary."],
        ["user", "Who owns the release?"],
        ["ai", "Ada does."],
      ]);
    },
  );

  // Gap: an extension's follow-up queued mid-run arrives with streamingBehavior set, so the input handler ignores it and it is saved as the user's words
  it(
    "doesn't save an extension's mid-run follow-up as the user's words",
    { timeout: TIMEOUT },
    async () => {
      let other: ExtensionAPI | undefined;
      const pi = await boot({ injection: { perTurn: "off" } }, (api) => {
        other = api;
      });
      pi.script(() => {
        other?.sendUserMessage("Automated: CI failed on main", { deliverAs: "followUp" });
        return "Starting the checklist.";
      }, "Looking at CI.");
      await pi.session.prompt("Kick off the release checklist");
      await pi.session.waitForIdle();

      await waitForSaved(3);
      expect(
        savedMessages()
          .filter((m) => m.peer_id === "user")
          .map((m) => m.content),
      ).toEqual(["Kick off the release checklist"]);
    },
  );
});

describe("capture of typed prompts", () => {
  const skillBlock = (args?: string) =>
    `<skill name="deploy" location="/skills/deploy/SKILL.md">\nReferences are relative to /skills/deploy.\n\nRun the deploy script.\n</skill>${args ? `\n\n${args}` : ""}`;

  it("collapseSkillBlock turns an expanded skill back into its command", () => {
    expect(collapseSkillBlock(skillBlock("staging tonight"))).toBe("/skill:deploy staging tonight");
    expect(collapseSkillBlock(skillBlock())).toBe("/skill:deploy");
    expect(collapseSkillBlock("just a message")).toBe("just a message");
  });

  it("extractMessages saves the run's prompt as typed and collapses later skill blocks", () => {
    const expanded = "You are a strict reviewer. Focus: auth";
    const messages = [
      { role: "user", content: [{ type: "text", text: expanded }] },
      { role: "assistant", content: [{ type: "text", text: "Reviewed." }], stopReason: "stop" },
      { role: "user", content: skillBlock("now") },
    ];
    expect(
      extractMessages(messages, { expanded, typed: "/review auth", fromExtension: false }).map(
        (m) => m.text,
      ),
    ).toEqual(["/review auth", "Reviewed.", "/skill:deploy now"]);
    expect(
      extractMessages(messages, { expanded, typed: expanded, fromExtension: true }).map(
        (m) => m.text,
      ),
    ).toEqual(["Reviewed.", "/skill:deploy now"]);
  });

  // Bug: extractMessages passes the typed text to String.replace as a replacement pattern, so `$&` and `$$` are expanded
  it("extractMessages keeps `$` sequences in the typed prompt literal", () => {
    const expanded = "Template body. Focus: price $& tax";
    const typed = "/review price $& tax";
    const [saved] = extractMessages([{ role: "user", content: expanded }], {
      expanded,
      typed,
      fromExtension: false,
    });
    expect(saved?.text).toBe(typed);
  });
});
