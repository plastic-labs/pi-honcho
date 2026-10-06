import { describe, expect, it } from "vitest";
import type { JsonObject } from "../extensions/config-file.js";
import {
  DEFAULT_DIALECTIC_TEMPLATE,
  endpointLabel,
  normalizeStrategy,
  parsePerTurn,
  perTurnToFile,
  readPiKey,
  resolveSettings,
  toHonchoId,
} from "../extensions/settings.js";

const ENV = { USER: "localuser" };

/** Structure of the user's real v0 file, values made up. */
const userV0File = (): JsonObject => ({
  apiKey: "hch-v3-root",
  environmentUrl: "https://api.honcho.dev",
  peerName: "aakash",
  statusline: "on",
  sessions: { "/Users/aakash/workspace/pi-honcho": "aakash-pi-honcho" },
  oauth: {
    accessToken: "hch-at-x",
    refreshToken: "hch-rt-x",
    accessExpiresAt: 1_900_000_000.5,
    clientId: "honcho-cli",
    scope: "write",
    host: "https://api.honcho.dev",
  },
  hosts: {
    claude_code: {
      enabled: true,
      logging: true,
      saveMessages: false,
      sessionStrategy: "git-branch",
      injection: {
        perTurn: ["dialectic"],
        maxConclusions: 40,
        dialecticReasoning: "high",
        showContents: ["dialectic"],
      },
      rememberTool: true,
    },
    hermes: { enabled: true, sessionStrategy: "global" },
    pi: { workspace: "claude_code", aiPeer: "pi" },
  },
});

describe("resolveSettings: v0 file", () => {
  it("resolves the user's shared file without leaking claude_code settings", () => {
    const s = resolveSettings(userV0File(), ENV);
    expect(s).toEqual({
      enabled: true,
      baseUrl: "https://api.honcho.dev",
      workspace: "claude_code",
      peerName: "aakash",
      aiPeer: "pi",
      timeoutMs: 30_000,
      sessionStrategy: "per-directory",
      saveMessages: true,
      injection: {
        sessionStart: { summary: true, peerCard: true },
        perTurn: "chat",
        reasoning: "medium",
        template: DEFAULT_DIALECTIC_TEMPLATE,
        maxConclusions: 15,
        searchTopK: 10,
        searchMaxDistance: 0.6,
        showSessionStart: true,
        showPerTurn: true,
      },
      tools: { chat: true, search: true },
      sources: {
        enabled: "default",
        baseUrl: "shared",
        workspace: "pi",
        peerName: "shared",
        aiPeer: "pi",
      },
      warnings: [],
    });
  });

  it("does not warn about HONCHO_API_KEY shadowing the file key", () => {
    const s = resolveSettings(userV0File(), { ...ENV, HONCHO_API_KEY: "env-key" });
    expect(s.warnings).toEqual([]);
  });

  it("defaults everything for an empty file", () => {
    const s = resolveSettings({}, ENV);
    expect(s.baseUrl).toBe("https://api.honcho.dev");
    expect(s.workspace).toBe("pi");
    expect(s.peerName).toBe("localuser");
    expect(s.aiPeer).toBe("pi");
    expect(s.enabled).toBe(true);
    expect(s.sources).toEqual({
      enabled: "default",
      baseUrl: "default",
      workspace: "default",
      peerName: "default",
      aiPeer: "default",
    });
  });

  it("falls back to USERNAME, then user, for the peer name", () => {
    expect(resolveSettings({}, { USERNAME: "winuser" }).peerName).toBe("winuser");
    expect(resolveSettings({}, {}).peerName).toBe("user");
  });

  it("maps root endpoint.environment local to localhost", () => {
    const s = resolveSettings({ endpoint: { environment: "local" } }, ENV);
    expect(s.baseUrl).toBe("http://localhost:8000");
    expect(s.sources.baseUrl).toBe("shared");
  });

  it("maps hosts.pi.endpoint.environment local to localhost over a root environmentUrl", () => {
    const s = resolveSettings(
      {
        environmentUrl: "https://api.honcho.dev",
        hosts: { pi: { endpoint: { environment: "local" } } },
      },
      ENV,
    );
    expect(s.baseUrl).toBe("http://localhost:8000");
    expect(s.sources.baseUrl).toBe("pi");
  });

  it("reads root endpoint.baseUrl and treats endpoint.environment production as the default", () => {
    expect(
      resolveSettings({ endpoint: { baseUrl: "https://honcho.example.com/" } }, ENV).baseUrl,
    ).toBe("https://honcho.example.com");
    const prod = resolveSettings({ endpoint: { environment: "production" } }, ENV);
    expect(prod.baseUrl).toBe("https://api.honcho.dev");
    expect(prod.sources.baseUrl).toBe("default");
  });

  it("does not let a root endpoint override hosts.pi.baseUrl", () => {
    const s = resolveSettings(
      { endpoint: { environment: "local" }, hosts: { pi: { baseUrl: "https://pi.example.com" } } },
      ENV,
    );
    expect(s.baseUrl).toBe("https://pi.example.com");
    expect(s.sources.baseUrl).toBe("pi");
  });
});

describe("resolveSettings: v1 pi-honcho legacy", () => {
  it("accepts a string hosts.pi.endpoint and maps sessionStrategy repo to per-directory", () => {
    const file: JsonObject = {
      apiKey: "hch-v3-root",
      peerName: "aakash",
      hosts: {
        pi: {
          workspace: "pi-e2e-1001",
          sessionStrategy: "repo",
          endpoint: "https://api.staging.honcho.run",
        },
      },
    };
    const s = resolveSettings(file, ENV);
    expect(s.baseUrl).toBe("https://api.staging.honcho.run");
    expect(s.sources.baseUrl).toBe("pi");
    expect(s.workspace).toBe("pi-e2e-1001");
    expect(s.sessionStrategy).toBe("per-directory");
    expect(s.warnings).toEqual([]);
  });

  it("maps the v1 directory strategy too", () => {
    expect(
      resolveSettings({ hosts: { pi: { sessionStrategy: "directory" } } }, ENV).sessionStrategy,
    ).toBe("per-directory");
  });

  it("lets a string hosts.pi.endpoint beat a root environmentUrl", () => {
    const s = resolveSettings(
      {
        environmentUrl: "https://api.honcho.dev",
        hosts: { pi: { endpoint: "https://api.staging.honcho.run/" } },
      },
      ENV,
    );
    expect(s.baseUrl).toBe("https://api.staging.honcho.run");
  });
});

describe("resolveSettings: schemaVersion 1", () => {
  it("reads baseUrl and auth from a v1 file", () => {
    const file: JsonObject = {
      schemaVersion: 1,
      baseUrl: "https://honcho.internal:8443/",
      peerName: "Pat",
      workspace: "team",
      auth: { apiKey: "root-v1" },
      hosts: { pi: { aiPeer: "pi-agent", timeoutMs: 5_000 } },
    };
    const s = resolveSettings(file, ENV);
    expect(s.baseUrl).toBe("https://honcho.internal:8443");
    expect(s.peerName).toBe("Pat");
    expect(s.workspace).toBe("team");
    expect(s.aiPeer).toBe("pi-agent");
    expect(s.timeoutMs).toBe(5_000);
    expect(s.sources).toEqual({
      enabled: "default",
      baseUrl: "shared",
      workspace: "shared",
      peerName: "shared",
      aiPeer: "pi",
    });
  });

  it("prefers hosts.pi.baseUrl over root baseUrl", () => {
    const s = resolveSettings(
      {
        schemaVersion: 1,
        baseUrl: "https://root.example",
        hosts: { pi: { baseUrl: "https://pi.example" } },
      },
      ENV,
    );
    expect(s.baseUrl).toBe("https://pi.example");
    expect(s.sources.baseUrl).toBe("pi");
  });
});

describe("resolveSettings: environment", () => {
  it("HONCHO_BASE_URL, then HONCHO_URL, then HONCHO_ENDPOINT override the file", () => {
    const file = userV0File();
    expect(
      resolveSettings(file, {
        ...ENV,
        HONCHO_BASE_URL: "https://a.example",
        HONCHO_URL: "https://b.example",
      }).baseUrl,
    ).toBe("https://a.example");
    expect(
      resolveSettings(file, { ...ENV, HONCHO_URL: "https://b.example", HONCHO_ENDPOINT: "local" })
        .baseUrl,
    ).toBe("https://b.example");
    const local = resolveSettings(file, { ...ENV, HONCHO_ENDPOINT: "local" });
    expect(local.baseUrl).toBe("http://localhost:8000");
    expect(local.sources.baseUrl).toBe("env");
  });

  it("HONCHO_WORKSPACE wins over HONCHO_WORKSPACE_ID and the host block", () => {
    const file = userV0File();
    const both = resolveSettings(file, { ...ENV, HONCHO_WORKSPACE: "a", HONCHO_WORKSPACE_ID: "b" });
    expect(both.workspace).toBe("a");
    expect(both.sources.workspace).toBe("env");
    expect(resolveSettings(file, { ...ENV, HONCHO_WORKSPACE_ID: "b" }).workspace).toBe("b");
  });

  it("HONCHO_PEER_NAME and HONCHO_AI_PEER override and are attributed to env", () => {
    const s = resolveSettings(userV0File(), {
      ...ENV,
      HONCHO_PEER_NAME: "envpeer",
      HONCHO_AI_PEER: "envai",
    });
    expect(s.peerName).toBe("envpeer");
    expect(s.aiPeer).toBe("envai");
    expect(s.sources.peerName).toBe("env");
    expect(s.sources.aiPeer).toBe("env");
  });

  it("HONCHO_ENABLED=false turns pi off even when hosts.pi.enabled is true", () => {
    const file: JsonObject = { hosts: { pi: { enabled: true } } };
    const s = resolveSettings(file, { ...ENV, HONCHO_ENABLED: "false" });
    expect(s.enabled).toBe(false);
    expect(s.sources.enabled).toBe("env");
    const fromFile = resolveSettings({ enabled: true, hosts: { pi: { enabled: false } } }, ENV);
    expect(fromFile.enabled).toBe(false);
    expect(fromFile.sources.enabled).toBe("pi");
    const shared = resolveSettings({ enabled: false }, ENV);
    expect(shared.enabled).toBe(false);
    expect(shared.sources.enabled).toBe("shared");
  });

  it("HONCHO_ENABLED=true does not override an explicit hosts.pi.enabled false", () => {
    const s = resolveSettings(
      { hosts: { pi: { enabled: false } } },
      { ...ENV, HONCHO_ENABLED: "true" },
    );
    expect(s.enabled).toBe(false);
    expect(s.sources.enabled).toBe("pi");
  });

  it("HONCHO_SESSION_STRATEGY overrides the file and warns on unknown values", () => {
    const file: JsonObject = { hosts: { pi: { sessionStrategy: "per-directory" } } };
    expect(
      resolveSettings(file, { ...ENV, HONCHO_SESSION_STRATEGY: "git-branch" }).sessionStrategy,
    ).toBe("git-branch");
    const bad = resolveSettings(file, { ...ENV, HONCHO_SESSION_STRATEGY: "global" });
    expect(bad.sessionStrategy).toBe("per-directory");
    expect(bad.warnings).toContain('unknown sessionStrategy "global"; using per-directory');
  });

  it("interpolates ${VAR} references in shared fields", () => {
    const s = resolveSettings(
      { peerName: "${HONCHO_TEST_PEER}", hosts: { pi: { workspace: "ws-${HONCHO_TEST_WS}" } } },
      { ...ENV, HONCHO_TEST_PEER: "alice", HONCHO_TEST_WS: "x" },
    );
    expect(s.peerName).toBe("alice");
    expect(s.workspace).toBe("ws-x");
  });
});

describe("resolveSettings: id sanitization", () => {
  it("coerces invalid ids and explains each with a warning", () => {
    const s = resolveSettings(
      { peerName: "Aakash K.", hosts: { pi: { workspace: "my workspace", aiPeer: "pi.agent" } } },
      ENV,
    );
    expect(s.peerName).toBe("Aakash-K");
    expect(s.workspace).toBe("my-workspace");
    expect(s.aiPeer).toBe("pi-agent");
    expect(s.warnings).toEqual([
      'workspace "my workspace" is not a valid Honcho id; using "my-workspace"',
      'peerName "Aakash K." is not a valid Honcho id; using "Aakash-K"',
      'aiPeer "pi.agent" is not a valid Honcho id; using "pi-agent"',
    ]);
  });

  it("toHonchoId trims separators, caps length and never returns empty", () => {
    expect(toHonchoId("  --a b--  ")).toBe("a-b");
    expect(toHonchoId("ü@ñ")).toBe("user");
    expect(toHonchoId("x".repeat(600))).toHaveLength(512);
    expect(toHonchoId("ok_id-1")).toBe("ok_id-1");
  });
});

describe("resolveSettings: injection", () => {
  const inj = (injection: JsonObject) =>
    resolveSettings({ hosts: { pi: { injection } } }, ENV).injection;

  it("parses claude-style perTurn component lists", () => {
    expect(inj({ perTurn: ["userContext"] }).perTurn).toBe("context");
    expect(inj({ perTurn: ["dialectic"] }).perTurn).toBe("chat");
    expect(inj({ perTurn: ["userContext", "dialectic"] }).perTurn).toBe("chat");
    expect(inj({ perTurn: ["context"] }).perTurn).toBe("context");
    expect(inj({ perTurn: [] }).perTurn).toBe("off");
    expect(inj({ perTurn: ["sessionContext"] }).perTurn).toBe("off");
  });

  it("parses bare mode strings and falls back to chat for junk", () => {
    expect(inj({ perTurn: "off" }).perTurn).toBe("off");
    expect(inj({ perTurn: "context" }).perTurn).toBe("context");
    expect(inj({ perTurn: "dialectic" }).perTurn).toBe("chat");
    expect(inj({ perTurn: "userContext" }).perTurn).toBe("context");
    expect(inj({ perTurn: "bogus" }).perTurn).toBe("chat");
    expect(inj({ perTurn: 3 }).perTurn).toBe("chat");
    expect(inj({}).perTurn).toBe("chat");
  });

  it("round-trips perTurn through the file shape", () => {
    for (const mode of ["chat", "context", "off"] as const) {
      expect(parsePerTurn(perTurnToFile(mode))).toBe(mode);
    }
  });

  it("reads sessionStart and showInChat lists", () => {
    expect(inj({ sessionStart: ["directives", "summary"] }).sessionStart).toEqual({
      summary: true,
      peerCard: false,
    });
    expect(inj({ sessionStart: [] }).sessionStart).toEqual({ summary: false, peerCard: false });
    expect(inj({ sessionStart: "summary" }).sessionStart).toEqual({
      summary: true,
      peerCard: true,
    });
    const shown = inj({ showInChat: ["perTurn"] });
    expect([shown.showSessionStart, shown.showPerTurn]).toEqual([false, true]);
    const none = inj({ showInChat: [] });
    expect([none.showSessionStart, none.showPerTurn]).toEqual([false, false]);
  });

  it("bounds numeric knobs and accepts numeric strings", () => {
    expect(inj({ maxConclusions: 40 }).maxConclusions).toBe(40);
    expect(inj({ maxConclusions: "20" }).maxConclusions).toBe(20);
    for (const bad of [0, 101, 2.5, -1, "x", true, null]) {
      expect(inj({ maxConclusions: bad }).maxConclusions).toBe(15);
    }
    expect(inj({ searchTopK: 100 }).searchTopK).toBe(100);
    expect(inj({ searchTopK: 0 }).searchTopK).toBe(10);
    expect(inj({ searchMaxDistance: 0 }).searchMaxDistance).toBe(0);
    expect(inj({ searchMaxDistance: "0.3" }).searchMaxDistance).toBe(0.3);
    expect(inj({ searchMaxDistance: 1.5 }).searchMaxDistance).toBe(0.6);
    expect(inj({ searchMaxDistance: -0.1 }).searchMaxDistance).toBe(0.6);
  });

  it("reads reasoning and template, ignoring unknown levels and blank templates", () => {
    expect(inj({ dialecticReasoning: "high" }).reasoning).toBe("high");
    expect(inj({ dialecticReasoning: "extreme" }).reasoning).toBe("medium");
    expect(inj({ dialecticTemplate: "Q: %{user_query}" }).template).toBe("Q: %{user_query}");
    expect(inj({ dialecticTemplate: "   " }).template).toBe(DEFAULT_DIALECTIC_TEMPLATE);
  });

  it("ignores a non-object injection block", () => {
    expect(
      resolveSettings({ hosts: { pi: { injection: ["dialectic"] } } }, ENV).injection.perTurn,
    ).toBe("chat");
  });
});

describe("resolveSettings: tools and saving", () => {
  it("reads tool flags", () => {
    const s = resolveSettings({ hosts: { pi: { tools: { honcho_chat: false } } } }, ENV);
    expect(s.tools).toEqual({ chat: false, search: true });
    expect(
      resolveSettings(
        { hosts: { pi: { tools: { honcho_search: false, honcho_chat: "no" } } } },
        ENV,
      ).tools,
    ).toEqual({ chat: true, search: false });
  });

  it("saveMessages prefers hosts.pi, then root", () => {
    expect(resolveSettings({ saveMessages: false }, ENV).saveMessages).toBe(false);
    expect(
      resolveSettings({ saveMessages: false, hosts: { pi: { saveMessages: true } } }, ENV)
        .saveMessages,
    ).toBe(true);
  });
});

describe("helpers", () => {
  it("normalizeStrategy", () => {
    expect(normalizeStrategy("chat-instance")).toBe("chat-instance");
    expect(normalizeStrategy("repo")).toBe("per-directory");
    expect(normalizeStrategy("per-session")).toBeUndefined();
    expect(normalizeStrategy(undefined)).toBeUndefined();
  });

  it("endpointLabel", () => {
    expect(endpointLabel("https://api.honcho.dev")).toBe("api.honcho.dev");
    expect(endpointLabel("http://localhost:8000")).toBe("localhost:8000");
    expect(endpointLabel("not a url")).toBe("not a url");
  });

  it("readPiKey prefers hosts.pi.apiKey, then hosts.pi.auth.apiKey, never root", () => {
    expect(
      readPiKey({ apiKey: "root", hosts: { pi: { apiKey: " pi ", auth: { apiKey: "nested" } } } }),
    ).toBe("pi");
    expect(readPiKey({ hosts: { pi: { auth: { apiKey: "nested" } } } })).toBe("nested");
    expect(readPiKey({ apiKey: "root" })).toBeUndefined();
    expect(readPiKey({ hosts: { pi: { apiKey: "   " } } })).toBeUndefined();
  });
});
