import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../extensions/config-file.js";
import type { HonchoRuntime } from "../extensions/runtime.js";
import { DEFAULT_DIALECTIC_TEMPLATE } from "../extensions/settings.js";
import { openConfig } from "../extensions/ui/config.js";
import {
  ConfigModel,
  TEMPLATE_EDITOR_TITLE,
  buildRows,
  stepValue,
} from "../extensions/ui/config/model.js";
import { ConfigOverlay } from "../extensions/ui/config/overlay.js";
import type { OverlayResult, ViewState } from "../extensions/ui/config/overlay.js";
import { runLogin, runLogout } from "../extensions/ui/login.js";
import { plainTheme, taggedTheme } from "./helpers/theme.js";

vi.mock("../extensions/ui/login.js", () => ({
  runLogin: vi.fn(async () => {}),
  runLogout: vi.fn(async () => {}),
}));

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ENTER = "\r";
const ESC = "\x1b";
const CLEAR = "\x15";
const WIDTH = 100;
const INNER = WIDTH - 2;

const GRANT = {
  accessToken: "at-1",
  refreshToken: "rt-1",
  accessExpiresAt: 4_102_444_800,
  clientId: "honcho-cli",
  scope: "write",
  host: "https://api.honcho.dev",
};

/** A v0 file shared with the honcho CLI and Claude Code. */
const fixture = (): JsonObject => ({
  environmentUrl: "https://api.honcho.dev",
  peerName: "aakash",
  oauth: { ...GRANT },
  sessions: { "/somewhere/else": "other-session" },
  statusline: { enabled: true },
  hosts: {
    claude_code: { workspace: "claude_code", injection: { perTurn: ["dialectic"] } },
    pi: { workspace: "claude_code", oauthClientId: "honcho-pi", custom: { keep: true } },
  },
});

const ROW_IDS = buildRows(
  new ConfigModel({ path: "/nonexistent/config.json", cwd: "/", env: {} }),
).map((row) => row.id);

/** One overlay line at WIDTH: one column of padding, `left`, and the scope flush right. */
const line = (left: string, scope = "") =>
  ` ${scope ? `${left.padEnd(INNER - scope.length)}${scope}` : left.padEnd(INNER)} `;

let dir: string;
let path: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-honcho-config-"));
  path = join(dir, ".honcho", "config.json");
  cwd = join(dir, "demo");
  mkdirSync(join(dir, ".honcho"));
  mkdirSync(cwd);
  vi.stubEnv("HOME", dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

interface SetupOptions {
  file?: JsonObject;
  env?: Record<string, string>;
  rows?: number;
  theme?: Theme;
  branch?: string;
}

const setup = (opts: SetupOptions = {}) => {
  writeFileSync(path, JSON.stringify(opts.file ?? fixture(), null, 2));
  const model = new ConfigModel({
    path,
    cwd,
    env: opts.env ?? {},
    branch: "branch" in opts ? opts.branch : "feature/x",
    instanceId: "abc123",
  });
  const view: ViewState = { selected: 0, scroll: 0, box: 0 };
  const done = vi.fn<(result: OverlayResult) => void>();
  const overlay = new ConfigOverlay(model, buildRows(model), opts.theme ?? plainTheme(), view, {
    maxLines: () => Math.floor((opts.rows ?? 60) * 0.9),
    requestRender: () => {},
    done,
  });
  const press = (...keys: string[]) => {
    for (const key of keys) {
      overlay.handleInput(key);
    }
  };
  const type = (text: string) => press(...text.split(""));
  const goto = (id: string) => {
    press(...Array.from({ length: ROW_IDS.length }, () => UP));
    press(...Array.from({ length: ROW_IDS.indexOf(id) }, () => DOWN));
  };
  const render = (width = WIDTH) => overlay.render(width);
  const find = (label: string) =>
    render().find((l) => l.startsWith(` >  ${label} `) || l.startsWith(`    ${label} `)) ?? "";
  // The inline editor draws its cursor with raw inverse-video codes
  const plain = (label: string) => stripTerminalSequences(find(label));
  const saved = () => JSON.parse(readFileSync(path, "utf8")) as JsonObject;
  return { model, overlay, view, done, press, type, goto, render, find, plain, saved };
};

const withPi = (file: JsonObject, pi: JsonObject): JsonObject => {
  const hosts = file.hosts as JsonObject;
  hosts.pi = { ...(hosts.pi as JsonObject), ...pi };
  return file;
};

describe("config overlay render", () => {
  it("matches the artboard copy at width 100", () => {
    const { render } = setup();
    const lines = render();
    expect(lines).toEqual([
      "─".repeat(WIDTH),
      line(`${"Honcho settings".padEnd(INNER - 44)}↑↓ move · ←→ change · enter edit · esc close`),
      line(`Saved to ~/.honcho/config.json. "shared" applies to every harness, "pi only" to pi.`),
      line(""),
      line(" Connection"),
      line(">  honcho           ‹ on ›", "pi only"),
      line("   account          aakash · oauth  enter to sign out", "shared"),
      line("   endpoint         api.honcho.dev", "shared"),
      line("   workspace        claude_code", "pi only"),
      line("   your peer        aakash", "shared"),
      line("   agent peer       pi", "pi only"),
      line(""),
      line(" Sessions"),
      line("   mapping          ‹ per-directory ›", "pi only"),
      line("                    per-directory · git-branch · chat-instance"),
      line("                    this folder uses session aakash-demo"),
      line(""),
      line(" Injection"),
      line("   session start    [x] summary  [x] peer card", "pi only"),
      line("   each turn        ‹ chat ›  chat · context · off", "pi only"),
      line("   reasoning        ‹ medium ›  for chat", "pi only"),
      line("   chat prompt      default template  enter to edit", "pi only"),
      line("   max conclusions  15  for context", "pi only"),
      line("   show in chat     [x] session start  [x] each turn", "pi only"),
      line(""),
      line(" Tools"),
      line("   honcho_chat      [x]", "pi only"),
      line("   honcho_search    [x]", "pi only"),
      "─".repeat(WIDTH),
    ]);
  });

  it("uses theme tokens for headers, selection, values and scope", () => {
    const { render, goto } = setup({ theme: taggedTheme() });
    goto("sessionStrategy");
    // Tags count as visible text, so render wide enough that nothing is cut
    const lines = render(400);
    expect(lines[0]).toBe(`<borderAccent>${"─".repeat(400)}</borderAccent>`);
    expect(lines[1]).toContain("<b>Honcho settings</b>");
    expect(lines[1]).toContain("<dim>↑↓ </dim>move<dim> · </dim><dim>←→ </dim>change");
    expect(lines.some((l) => l.startsWith("  <accent><b>Connection</b></accent>"))).toBe(true);
    const selected = lines.find((l) => l.includes(">  mapping")) ?? "";
    expect(selected.startsWith("<bg:selectedBg>")).toBe(true);
    expect(selected).toContain(">  mapping          <accent>‹ per-directory ›</accent>");
    expect(selected).toContain("<dim>pi only</dim>");
    const unselected = lines.find((l) => l.includes("workspace")) ?? "";
    expect(unselected).toContain(`<dim>${"workspace".padEnd(17)}</dim>claude_code`);
    expect(unselected.startsWith("<bg:")).toBe(false);
    expect(lines.find((l) => l.includes("session start"))).toContain(
      "<success>[x]</success> summary",
    );
    expect(lines.find((l) => l.includes("uses session"))).toContain(
      "<dim>this folder uses session </dim>aakash-demo",
    );
  });

  it("keeps every line at the overlay width, including the 60-column minimum", () => {
    const { render, goto, press } = setup();
    for (const width of [WIDTH, 60]) {
      for (const l of render(width)) {
        expect(visibleWidth(l)).toBe(width);
      }
    }
    goto("workspace");
    press(ENTER);
    for (const l of render(60)) {
      expect(visibleWidth(l)).toBe(60);
    }
  });

  it("shows unchecked boxes and the off state", () => {
    const file = withPi(fixture(), {
      enabled: false,
      injection: {
        sessionStart: ["peerCard"],
        showInChat: [],
        dialecticTemplate: "Mine: %{user_query}",
      },
      tools: { honcho_search: false },
    });
    const { find } = setup({ file });
    expect(find("honcho")).toBe(
      line(">  honcho           ‹ off ›  nothing is injected or saved", "pi only"),
    );
    expect(find("session start")).toBe(
      line("   session start    [ ] summary  [x] peer card", "pi only"),
    );
    expect(find("show in chat")).toBe(
      line("   show in chat     [ ] session start  [ ] each turn", "pi only"),
    );
    expect(find("chat prompt")).toBe(
      line("   chat prompt      custom template  enter to edit", "pi only"),
    );
    expect(find("honcho_search")).toBe(line("   honcho_search    [ ]", "pi only"));
  });

  it("describes each kind of account", () => {
    const signedOut = fixture();
    delete signedOut.oauth;
    expect(setup({ file: signedOut }).find("account")).toBe(
      line("   account          not signed in  enter to sign in"),
    );

    const piKey = withPi(fixture(), { apiKey: "hch-pi" });
    expect(setup({ file: piKey }).find("account")).toBe(
      line("   account          aakash · api key  enter to sign out", "pi only"),
    );

    const sharedKey = { ...signedOut, apiKey: "hch-shared" };
    expect(setup({ file: sharedKey }).find("account")).toBe(
      line(
        "   account          aakash · api key  shared key · enter to add a pi-only key",
        "shared",
      ),
    );
  });
});

describe("config overlay navigation", () => {
  it("moves the marker with the arrows and stops at both ends", () => {
    const { press, render, view } = setup();
    press(UP);
    expect(view.selected).toBe(0);
    press(DOWN, DOWN);
    expect(render()).toContain(line(">  endpoint         api.honcho.dev", "shared"));
    expect(render()).toContain(line("   honcho           ‹ on ›", "pi only"));
    press(...Array.from({ length: 30 }, () => DOWN));
    expect(view.selected).toBe(ROW_IDS.length - 1);
    expect(render()).toContain(line(">  honcho_search    [x]", "pi only"));
  });

  it("closes on escape", () => {
    const { press, done } = setup();
    press(ESC);
    expect(done).toHaveBeenCalledWith({ action: "close" });
  });

  it("scrolls to keep the selected row inside a short terminal", () => {
    const { press, render, goto } = setup({ rows: 20 });
    let lines = render();
    expect(lines).toHaveLength(18);
    expect(lines.at(-2)).toBe(line("  ↓ 8 more"));
    goto("honcho_search");
    lines = render();
    expect(lines).toHaveLength(18);
    expect(lines).toContain(line(">  honcho_search    [x]", "pi only"));
    expect(lines).toContain(line(" Injection"));
    expect(lines.at(-2)).toBe(line("  ↑ 7 more"));
    press(...Array.from({ length: 6 }, () => UP));
    lines = render();
    expect(lines).toContain(line(">  each turn        ‹ chat ›  chat · context · off", "pi only"));
    expect(lines).toContain(line(" Injection"));
    press(...Array.from({ length: 2 }, () => UP));
    lines = render();
    expect(lines).toContain(line(" Sessions"));
    expect(lines).toContain(line(">  mapping          ‹ per-directory ›", "pi only"));
    expect(lines).toContain(line("                    this folder uses session aakash-demo"));
    expect(lines.at(-2)).toBe(line("  ↑ 6 more · ↓ 2 more"));
  });
});

describe("config overlay writes", () => {
  it("turns honcho off for pi only", () => {
    const { press, saved, find } = setup();
    press(RIGHT);
    expect(saved()).toEqual(withPi(fixture(), { enabled: false }));
    expect(find("honcho")).toContain("‹ off ›  nothing is injected or saved");
    press(ENTER);
    expect(saved()).toEqual(withPi(fixture(), { enabled: true }));
  });

  it("asks the caller to sign out, or in", () => {
    const signedIn = setup();
    signedIn.goto("account");
    signedIn.press(ENTER);
    expect(signedIn.done).toHaveBeenCalledWith({ action: "logout" });

    const file = fixture();
    delete file.oauth;
    const signedOut = setup({ file });
    signedOut.goto("account");
    signedOut.press(ENTER);
    expect(signedOut.done).toHaveBeenCalledWith({ action: "login" });
  });

  it("signs in over a shared key, since logout won't remove it", () => {
    const file = fixture();
    delete file.oauth;
    const shared = setup({ file: { ...file, apiKey: "hch-shared" } });
    shared.goto("account");
    shared.press(ENTER);
    expect(shared.done).toHaveBeenCalledWith({ action: "login" });
  });

  it("writes the endpoint where every harness reads it and drops pi's override", () => {
    const { press, type, goto, saved, find, overlay } = setup({
      file: withPi(fixture(), {
        baseUrl: "https://pi.example",
        endpoint: { environment: "local" },
      }),
    });
    expect(find("endpoint")).toBe(line("   endpoint         pi.example", "pi only"));
    goto("endpoint");
    press(ENTER);
    expect(overlay.isEditing).toBe(true);
    press(CLEAR);
    type("localhost:8000");
    press(ENTER);
    expect(overlay.isEditing).toBe(false);
    const expected = fixture();
    expected.environmentUrl = "http://localhost:8000";
    expected.endpoint = { baseUrl: "http://localhost:8000" };
    expect(saved()).toEqual(expected);
    expect(find("endpoint")).toBe(line(">  endpoint         localhost:8000", "shared"));
    // The OAuth grant belongs to api.honcho.dev
    expect(find("account")).toBe(line("   account          not signed in  enter to sign in"));
  });

  it("writes root baseUrl once the file is v1", () => {
    const file: JsonObject = {
      schemaVersion: 1,
      baseUrl: "https://api.honcho.dev",
      peerName: "aakash",
      hosts: { pi: { aiPeer: "pi" } },
    };
    const { press, type, goto, saved } = setup({ file });
    goto("endpoint");
    press(ENTER, CLEAR);
    type("https://honcho.example.com/");
    press(ENTER);
    expect(saved()).toEqual({
      ...file,
      baseUrl: "https://honcho.example.com",
      environmentUrl: "https://honcho.example.com",
    });
  });

  it("rejects an endpoint that is not an http(s) URL", () => {
    const { press, type, goto, saved, find, plain, overlay, render } = setup();
    goto("endpoint");
    press(ENTER, CLEAR);
    type("ftp://files.example");
    press(ENTER);
    expect(overlay.isEditing).toBe(true);
    expect(plain("endpoint")).toBe(
      line(">  endpoint         ftp://files.example   enter an http(s) URL", "shared"),
    );
    expect(render()[1]).toContain("enter save · esc cancel");
    expect(saved()).toEqual(fixture());
    press(ESC);
    expect(overlay.isEditing).toBe(false);
    expect(find("endpoint")).toBe(line(">  endpoint         api.honcho.dev", "shared"));
  });

  it("edits the workspace inline and validates Honcho ids", () => {
    const { press, type, goto, saved, find, plain, overlay } = setup();
    goto("workspace");
    press(ENTER);
    expect(plain("workspace")).toBe(line(">  workspace        claude_code", "pi only"));
    type(" x");
    press(ENTER);
    expect(plain("workspace")).toBe(
      line(">  workspace        claude_code x   use letters, numbers, _ or -", "pi only"),
    );
    expect(saved()).toEqual(fixture());
    press(CLEAR);
    type("new_ws");
    press(ENTER);
    expect(overlay.isEditing).toBe(false);
    expect(saved()).toEqual(withPi(fixture(), { workspace: "new_ws" }));
    expect(find("workspace")).toBe(line(">  workspace        new_ws", "pi only"));
  });

  it("writes your peer to the shared root and removes pi's own", () => {
    const { press, type, goto, saved, find, plain } = setup({
      file: withPi(fixture(), { peerName: "pi-peer" }),
    });
    expect(find("your peer")).toBe(line("   your peer        pi-peer", "pi only"));
    goto("peerName");
    press(ENTER, CLEAR, ENTER);
    expect(plain("your peer")).toContain("can't be empty");
    type("alice");
    press(ENTER);
    expect(saved()).toEqual({ ...fixture(), peerName: "alice" });
    expect(find("your peer")).toBe(line(">  your peer        alice", "shared"));
  });

  it("sets the agent peer and resets it when cleared", () => {
    const { press, type, goto, saved, find } = setup();
    goto("aiPeer");
    press(ENTER, CLEAR);
    type("claude");
    press(ENTER);
    expect(saved()).toEqual(withPi(fixture(), { aiPeer: "claude" }));
    press(ENTER, CLEAR, ENTER);
    expect(saved()).toEqual(fixture());
    expect(find("agent peer")).toBe(line(">  agent peer       pi", "pi only"));
  });

  it("cycles the session mapping and previews the session name", () => {
    const { press, goto, saved, render } = setup();
    goto("sessionStrategy");
    press(RIGHT);
    expect(saved()).toEqual(withPi(fixture(), { sessionStrategy: "git-branch" }));
    expect(render()).toContain(
      line("                    this folder uses session aakash-demo-feature-x"),
    );
    press(RIGHT);
    expect(saved()).toEqual(withPi(fixture(), { sessionStrategy: "chat-instance" }));
    expect(render()).toContain(
      line("                    this folder uses session aakash-chat-abc123"),
    );
    press(RIGHT);
    expect(render()).toContain(line("                    this folder uses session aakash-demo"));
    press(LEFT);
    expect(saved()).toEqual(withPi(fixture(), { sessionStrategy: "chat-instance" }));
  });

  it("previews mapped sessions and folders without a branch", () => {
    const file = fixture();
    file.sessions = { [cwd]: "pinned-session" };
    const mapped = setup({ file });
    expect(mapped.render()).toContain(
      line("                    this folder uses session pinned-session"),
    );

    const noBranch = setup({
      file: withPi(fixture(), { sessionStrategy: "git-branch" }),
      branch: undefined,
    });
    expect(noBranch.render()).toContain(
      line("                    this folder uses session aakash-demo  (no git branch here)"),
    );
  });

  it("toggles session start parts with enter, arrows and space", () => {
    const { press, goto, saved, find } = setup();
    goto("sessionStart");
    press(ENTER);
    expect(saved()).toEqual(withPi(fixture(), { injection: { sessionStart: ["peerCard"] } }));
    press(RIGHT, " ");
    expect(saved()).toEqual(withPi(fixture(), { injection: { sessionStart: [] } }));
    press(LEFT, " ");
    expect(saved()).toEqual(withPi(fixture(), { injection: { sessionStart: ["summary"] } }));
    expect(find("session start")).toBe(
      line(">  session start    [x] summary  [ ] peer card", "pi only"),
    );
  });

  it("cycles each-turn mode in the file's component-list shape", () => {
    const { press, goto, saved } = setup();
    goto("perTurn");
    press(RIGHT);
    expect(saved()).toEqual(withPi(fixture(), { injection: { perTurn: ["userContext"] } }));
    press(RIGHT);
    expect(saved()).toEqual(withPi(fixture(), { injection: { perTurn: [] } }));
    press(RIGHT);
    expect(saved()).toEqual(withPi(fixture(), { injection: { perTurn: ["dialectic"] } }));
  });

  it("steps the reasoning level", () => {
    const { press, goto, saved, find } = setup();
    goto("reasoning");
    press(LEFT);
    expect(saved()).toEqual(withPi(fixture(), { injection: { dialecticReasoning: "low" } }));
    press(RIGHT, RIGHT);
    expect(saved()).toEqual(withPi(fixture(), { injection: { dialecticReasoning: "high" } }));
    expect(find("reasoning")).toBe(line(">  reasoning        ‹ high ›  for chat", "pi only"));
  });

  it("hands the chat prompt to the editor", () => {
    const { press, goto, done } = setup();
    goto("template");
    press(ENTER);
    expect(done).toHaveBeenCalledWith({ action: "template" });
    press(DOWN, ENTER);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("steps max conclusions by 5 within 1..100 and accepts a typed number", () => {
    const { press, type, goto, saved, find, plain } = setup();
    goto("maxConclusions");
    press(RIGHT);
    expect(saved()).toEqual(withPi(fixture(), { injection: { maxConclusions: 20 } }));
    press(LEFT, LEFT, LEFT, LEFT);
    expect(saved()).toEqual(withPi(fixture(), { injection: { maxConclusions: 1 } }));
    press(LEFT, RIGHT);
    expect(saved()).toEqual(withPi(fixture(), { injection: { maxConclusions: 5 } }));
    press(ENTER, CLEAR);
    type("500");
    press(ENTER);
    expect(plain("max conclusions")).toContain("500   enter a whole number from 1 to 100");
    press(CLEAR);
    type("42");
    press(ENTER);
    expect(saved()).toEqual(withPi(fixture(), { injection: { maxConclusions: 42 } }));
    expect(find("max conclusions")).toBe(line(">  max conclusions  42  for context", "pi only"));
  });

  it("toggles what shows in chat", () => {
    const { press, goto, saved } = setup();
    goto("showInChat");
    press(" ");
    expect(saved()).toEqual(withPi(fixture(), { injection: { showInChat: ["perTurn"] } }));
    press(RIGHT, ENTER);
    expect(saved()).toEqual(withPi(fixture(), { injection: { showInChat: [] } }));
  });

  it("turns tools off", () => {
    const { press, goto, saved, find } = setup();
    goto("honcho_chat");
    press(ENTER);
    expect(saved()).toEqual(withPi(fixture(), { tools: { honcho_chat: false } }));
    press(DOWN, " ");
    expect(saved()).toEqual(
      withPi(fixture(), { tools: { honcho_chat: false, honcho_search: false } }),
    );
    expect(find("honcho_chat")).toBe(line("   honcho_chat      [ ]", "pi only"));
  });

  it("merges several changes into one file without touching other hosts or the grant", () => {
    const { press, goto, saved } = setup();
    goto("reasoning");
    press(RIGHT);
    goto("perTurn");
    press(RIGHT);
    goto("honcho_search");
    press(ENTER);
    const after = saved();
    expect(after.oauth).toEqual(GRANT);
    expect((after.hosts as JsonObject).claude_code).toEqual(
      (fixture().hosts as JsonObject).claude_code,
    );
    expect((after.hosts as JsonObject).pi).toEqual({
      workspace: "claude_code",
      oauthClientId: "honcho-pi",
      custom: { keep: true },
      injection: { dialecticReasoning: "high", perTurn: ["userContext"] },
      tools: { honcho_search: false },
    });
  });
});

describe("environment-pinned rows", () => {
  const env = {
    HONCHO_ENABLED: "false",
    HONCHO_API_KEY: "hch-env",
    HONCHO_BASE_URL: "http://env.example:9000",
    HONCHO_WORKSPACE: "envws",
    HONCHO_PEER_NAME: "envpeer",
    HONCHO_AI_PEER: "envai",
    HONCHO_SESSION_STRATEGY: "git-branch",
  };

  it("shows env values with the env scope", () => {
    const { render } = setup({ env });
    const lines = render();
    expect(lines).toContain(
      line(">  honcho           ‹ off ›  nothing is injected or saved", "env"),
    );
    expect(lines).toContain(
      line("   account          envpeer · env key  from HONCHO_API_KEY", "env"),
    );
    expect(lines).toContain(line("   endpoint         env.example:9000", "env"));
    expect(lines).toContain(line("   workspace        envws", "env"));
    expect(lines).toContain(line("   your peer        envpeer", "env"));
    expect(lines).toContain(line("   agent peer       envai", "env"));
    expect(lines).toContain(line("   mapping          ‹ git-branch ›", "env"));
  });

  it("refuses edits and names the variable", () => {
    const { press, goto, saved, find, overlay, done } = setup({ env });
    press(RIGHT);
    expect(find("honcho")).toBe(
      line(
        ">  honcho           ‹ off ›  set by HONCHO_ENABLED=false; unset it to edit here",
        "env",
      ),
    );
    goto("account");
    press(ENTER);
    expect(find("account")).toBe(
      line(
        ">  account          envpeer · env key  set by HONCHO_API_KEY; unset it to sign out",
        "env",
      ),
    );
    expect(done).not.toHaveBeenCalled();
    for (const [id, label, variable] of [
      ["endpoint", "endpoint", "HONCHO_BASE_URL"],
      ["workspace", "workspace", "HONCHO_WORKSPACE"],
      ["peerName", "your peer", "HONCHO_PEER_NAME"],
      ["aiPeer", "agent peer", "HONCHO_AI_PEER"],
    ] as const) {
      goto(id);
      press(ENTER);
      expect(overlay.isEditing).toBe(false);
      expect(find(label)).toContain(`set by ${variable}; unset it to edit here`);
    }
    goto("sessionStrategy");
    press(RIGHT);
    expect(find("mapping")).toContain("set by HONCHO_SESSION_STRATEGY; unset it to edit here");
    press(DOWN);
    expect(find("mapping")).not.toContain("set by");
    expect(saved()).toEqual(fixture());
  });
});

describe("stepValue", () => {
  it("snaps to multiples of the step and clamps", () => {
    expect(stepValue(15, 1, 5, 1, 100)).toBe(20);
    expect(stepValue(12, 1, 5, 1, 100)).toBe(15);
    expect(stepValue(12, -1, 5, 1, 100)).toBe(10);
    expect(stepValue(5, -1, 5, 1, 100)).toBe(1);
    expect(stepValue(1, 1, 5, 1, 100)).toBe(5);
    expect(stepValue(100, 1, 5, 1, 100)).toBe(100);
  });
});

describe("openConfig", () => {
  type Script = (overlay: ConfigOverlay) => void;

  const harness = (
    scripts: Script[],
    opts: { editor?: string | undefined; mode?: string; phase?: string } = {},
  ) => {
    for (const name of [
      "HONCHO_API_KEY",
      "HONCHO_BASE_URL",
      "HONCHO_URL",
      "HONCHO_ENDPOINT",
      "HONCHO_WORKSPACE",
      "HONCHO_WORKSPACE_ID",
      "HONCHO_PEER_NAME",
      "HONCHO_AI_PEER",
      "HONCHO_ENABLED",
      "HONCHO_SESSION_STRATEGY",
    ]) {
      vi.stubEnv(name, "");
    }
    const tui = { terminal: { rows: 50, columns: 120 }, requestRender: vi.fn() };
    const overlays: ConfigOverlay[] = [];
    const custom = vi.fn(
      (
        factory: (
          tui: unknown,
          theme: Theme,
          kb: unknown,
          done: (r: OverlayResult) => void,
        ) => ConfigOverlay,
        _options: unknown,
      ) =>
        new Promise<OverlayResult>((resolve) => {
          const overlay = factory(tui, plainTheme(), {}, resolve);
          overlays.push(overlay);
          scripts.shift()?.(overlay);
        }),
    );
    const ctx = {
      mode: opts.mode ?? "tui",
      cwd,
      sessionManager: { getSessionId: () => "sess-1" },
      ui: { custom, notify: vi.fn(), editor: vi.fn(async () => opts.editor) },
    };
    const exec = vi.fn(async () => ({ code: 0, stdout: "main\n", stderr: "", killed: false }));
    const runtime = {
      store: { path },
      pi: { exec },
      phase: opts.phase ?? "connected",
      refreshSettings: vi.fn(async () => {}),
    };
    const run = () =>
      openConfig(ctx as unknown as ExtensionCommandContext, runtime as unknown as HonchoRuntime);
    return { ctx, runtime, exec, custom, overlays, run };
  };

  const keys =
    (...data: string[]): Script =>
    (overlay) => {
      for (const d of data) {
        overlay.handleInput(d);
      }
    };

  it("refuses to open over a config file that does not parse", async () => {
    writeFileSync(path, "{ not json");
    const h = harness([]);
    await h.run();
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(
      "honcho: ~/.honcho/config.json is not valid JSON. Fix it, then run /honcho config again.",
      "error",
    );
    expect(h.custom).not.toHaveBeenCalled();
    expect(h.runtime.refreshSettings).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  it("opens the overlay, reads the branch once and refreshes settings on close", async () => {
    writeFileSync(path, JSON.stringify(withPi(fixture(), { sessionStrategy: "git-branch" })));
    let preview: string[] = [];
    const h = harness([
      (overlay) => {
        preview = overlay.render(WIDTH);
        overlay.handleInput(ESC);
      },
    ]);
    await h.run();
    expect(h.custom).toHaveBeenCalledTimes(1);
    expect(h.custom.mock.calls[0]?.[1]).toBeUndefined();
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(h.exec).toHaveBeenCalledWith("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      timeout: 3_000,
    });
    expect(preview).toContain(
      line("                    this folder uses session aakash-demo-main"),
    );
    expect(h.runtime.refreshSettings).toHaveBeenCalledTimes(1);
    expect(runLogin).not.toHaveBeenCalled();
    expect(runLogout).not.toHaveBeenCalled();
  });

  it("edits the chat prompt in the editor and reopens on the same row", async () => {
    writeFileSync(path, JSON.stringify(fixture()));
    let reopened: string[] = [];
    const h = harness(
      [
        keys(...Array.from({ length: ROW_IDS.indexOf("template") }, () => DOWN), ENTER),
        (overlay) => {
          reopened = overlay.render(WIDTH);
          overlay.handleInput(ESC);
        },
      ],
      { editor: "  Custom: %{user_query}\n" },
    );
    await h.run();
    expect(h.ctx.ui.editor).toHaveBeenCalledWith(TEMPLATE_EDITOR_TITLE, DEFAULT_DIALECTIC_TEMPLATE);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(
      withPi(fixture(), { injection: { dialecticTemplate: "Custom: %{user_query}" } }),
    );
    expect(reopened).toContain(
      line(">  chat prompt      custom template  enter to edit", "pi only"),
    );
    expect(h.custom).toHaveBeenCalledTimes(2);
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(h.runtime.refreshSettings).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the default text", DEFAULT_DIALECTIC_TEMPLATE],
    ["an empty prompt", "   "],
  ])("removes a custom chat prompt when saving %s", async (_name, text) => {
    writeFileSync(
      path,
      JSON.stringify(withPi(fixture(), { injection: { dialecticTemplate: "Old: %{user_query}" } })),
    );
    const h = harness(
      [keys(...Array.from({ length: ROW_IDS.indexOf("template") }, () => DOWN), ENTER), keys(ESC)],
      { editor: text },
    );
    await h.run();
    expect(h.ctx.ui.editor).toHaveBeenCalledWith(TEMPLATE_EDITOR_TITLE, "Old: %{user_query}");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(withPi(fixture(), { injection: {} }));
  });

  it("leaves the prompt alone when the editor is cancelled", async () => {
    writeFileSync(path, JSON.stringify(fixture()));
    const h = harness(
      [keys(...Array.from({ length: ROW_IDS.indexOf("template") }, () => DOWN), ENTER), keys(ESC)],
      { editor: undefined },
    );
    await h.run();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(fixture());
  });

  it("closes, refreshes, then signs out from the account row", async () => {
    writeFileSync(path, JSON.stringify(fixture()));
    const h = harness([keys(DOWN, ENTER)]);
    await h.run();
    expect(runLogout).toHaveBeenCalledWith(h.ctx, h.runtime);
    expect(h.runtime.refreshSettings.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runLogout).mock.invocationCallOrder[0] ?? 0,
    );
    expect(runLogin).not.toHaveBeenCalled();
  });

  it("offers sign-in when the OAuth sign-in expired", async () => {
    writeFileSync(path, JSON.stringify(fixture()));
    let account = "";
    const h = harness(
      [
        (overlay) => {
          account = overlay.render(WIDTH).find((l) => l.includes("account")) ?? "";
          keys(DOWN, ENTER)(overlay);
        },
      ],
      { phase: "expired" },
    );
    await h.run();
    expect(account).toBe(
      line("   account          aakash · oauth  expired, enter to sign in", "shared"),
    );
    expect(runLogin).toHaveBeenCalledWith(h.ctx, h.runtime);
  });

  it("explains itself outside the interactive terminal", async () => {
    writeFileSync(path, JSON.stringify(fixture()));
    const h = harness([], { mode: "rpc" });
    await h.run();
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(
      "honcho: /honcho config needs the interactive terminal. Settings live in ~/.honcho/config.json.",
      "warning",
    );
    expect(h.custom).not.toHaveBeenCalled();
  });
});
