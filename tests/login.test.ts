import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { AuthenticationError } from "@honcho-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeKeyError, methodOptions } from "../extensions/ui/login/flow.js";
import { MaskedInput } from "../extensions/ui/login/masked-input.js";
import {
  METHOD_OPTIONS,
  formatClock,
  maskKey,
  renderBusy,
} from "../extensions/ui/login/screens.js";
import {
  ApiKeyScreen,
  BrowserScreen,
  DeviceScreen,
  LoginView,
  PickerScreen,
  checkRedirectUrl,
} from "../extensions/ui/login/view.js";
import { plainTheme, taggedTheme } from "./helpers/theme.js";

const strip = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));
const NOW = 1_000_000;
const KEY = `hch-v3-${"x".repeat(28)}4f2a`;
const AUTHORIZE_URL =
  "https://app.honcho.dev/authorize?client_id=honcho-pi&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback&scope=write&response_type=code&code_challenge=abcdefghijklmnopqrstuvwxyz0123456789&code_challenge_method=S256&state=xyz";

const views: LoginView[] = [];
const view = () => {
  const v = new LoginView({ requestRender() {} }, plainTheme(), () => NOW);
  views.push(v);
  return v;
};

afterEach(() => {
  for (const v of views.splice(0)) {
    v.dispose();
  }
});

describe("picker", () => {
  const picker = (oauth: boolean, envKey = false) => {
    const screen = new PickerScreen("api.honcho.dev", envKey);
    screen.setOptions(
      oauth ? METHOD_OPTIONS : methodOptions(null),
      oauth,
      oauth ? "browser" : "key",
    );
    return screen;
  };

  it("renders the three methods with right-aligned hints", () => {
    const lines = picker(true).render(100, plainTheme(), NOW);
    expect(lines[0]).toMatch(/^ Sign in to Honcho +↑↓ select · enter confirm · esc cancel$/);
    expect(visibleWidth(lines[0] ?? "")).toBe(100);
    expect(lines).toEqual([
      lines[0],
      " api.honcho.dev · change the endpoint in /honcho config",
      "",
      "→ Browser              Approve in your browser, then come back here",
      "  Device code          For SSH and headless machines: enter a code on any device",
      "  API key              Paste a key from your Honcho dashboard",
      "",
    ]);
  });

  it("colors the selected row and dims the other descriptions", () => {
    const lines = picker(true).render(100, taggedTheme(), NOW);
    expect(lines).toContain(
      "<accent>→ Browser              Approve in your browser, then come back here</accent>",
    );
    expect(lines).toContain(
      "  API key              <dim>Paste a key from your Honcho dashboard</dim>",
    );
  });

  it("offers only the API key when the endpoint has no OAuth", () => {
    const lines = new PickerScreen("localhost:8000", false);
    lines.setOptions(methodOptions(null), false, "key");
    const out = lines.render(100, plainTheme(), NOW);
    expect(out.filter((l) => l.includes("Browser") || l.includes("Device code"))).toEqual([
      " Browser and device sign-in aren't available on localhost:8000.",
    ]);
    expect(out).toContain("→ API key              Paste a key from your Honcho dashboard");
  });

  it("hides device code when the server has no device endpoint", () => {
    const as = { issuer: "x", authorizationEndpoint: "a", tokenEndpoint: "t", grantTypes: [] };
    expect(methodOptions(as).map((o) => o.method)).toEqual(["browser", "key"]);
    expect(methodOptions({ ...as, deviceAuthorizationEndpoint: "d" }).map((o) => o.method)).toEqual(
      ["browser", "device", "key"],
    );
  });

  it("warns that HONCHO_API_KEY keeps precedence", () => {
    const lines = picker(true, true).render(120, taggedTheme(), NOW);
    expect(lines).toContain(
      "<warning> HONCHO_API_KEY is set in your environment and keeps taking precedence over any saved login.</warning>",
    );
  });

  it("wraps the warning and the unavailable note instead of cutting them off", () => {
    const screen = new PickerScreen("honcho.internal.example.com:8000", true);
    screen.setOptions(methodOptions(null), false, "key");
    const v = view();
    v.show(screen);
    const lines = strip(v.render(60));
    expect(lines).toContain(" Browser and device sign-in aren't available on");
    expect(lines).toContain(" honcho.internal.example.com:8000.");
    expect(lines).toContain(" HONCHO_API_KEY is set in your environment and keeps taking");
    expect(lines).toContain(" precedence over any saved login.");
  });

  it("shows a checking state before discovery finishes", () => {
    const lines = new PickerScreen("api.honcho.dev", false).render(80, plainTheme(), 0);
    expect(lines[0]).toMatch(/^ Sign in to Honcho +esc cancel$/);
    expect(lines).toContain(" ⠋ Checking api.honcho.dev…");
  });

  it("moves the selection and confirms with enter", () => {
    const screen = picker(true);
    const onSelect = vi.fn();
    screen.onSelect = onSelect;
    expect(screen.handleInput("\x1b[A")).toBe(true);
    expect(screen.state.selected).toBe(0);
    screen.handleInput("\x1b[B");
    screen.handleInput("\x1b[B");
    screen.handleInput("\x1b[B");
    expect(screen.state.selected).toBe(2);
    screen.handleInput("\x1b[A");
    screen.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith("device");
  });

  it("preselects device code over SSH-like preferences", () => {
    const screen = new PickerScreen("api.honcho.dev", false);
    screen.setOptions(METHOD_OPTIONS, true, "device");
    expect(screen.render(100, plainTheme(), NOW)).toContain(
      "→ Device code          For SSH and headless machines: enter a code on any device",
    );
  });

  it("esc is left to the view, which cancels", () => {
    const v = view();
    const screen = picker(true);
    v.show(screen);
    expect(screen.handleInput("\x1b")).toBe(false);
    v.handleInput("\x1b");
    expect(v.signal.aborted).toBe(true);
  });
});

describe("view frame", () => {
  it("draws accent rules around the screen and fits every line to the width", () => {
    const v = view();
    v.show(
      new BrowserScreen(
        { url: AUTHORIZE_URL, port: 53682, deadline: NOW + 60_000 },
        { copy: vi.fn(), submitRedirectUrl: vi.fn() },
      ),
    );
    const lines = v.render(60);
    expect(lines[0]).toBe("─".repeat(60));
    expect(lines.at(-1)).toBe("─".repeat(60));
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
    const tagged = new LoginView({ requestRender() {} }, taggedTheme(), () => NOW);
    views.push(tagged);
    expect(tagged.render(10)[0]).toBe(`<borderAccent>${"─".repeat(10)}</borderAccent>`);
  });

  it("drops the hints when the title row is too narrow", () => {
    const lines = renderBusy(
      "Sign in to Honcho · device code",
      "Requesting a code…",
      30,
      plainTheme(),
      0,
    );
    expect(lines[0]).toBe(" Sign in to Honcho · device code");
  });
});

describe("browser screen", () => {
  const browser = (
    copy = vi.fn(async () => {}),
    submitRedirectUrl = vi.fn(),
    env: Record<string, string> = {},
  ) => {
    const screen = new BrowserScreen(
      { url: AUTHORIZE_URL, port: 53682, deadline: NOW + 290_500 },
      { copy, submitRedirectUrl },
      () => NOW,
      env,
    );
    return { screen, copy, submitRedirectUrl };
  };

  it("renders the waiting state with the full link and a countdown", () => {
    const { screen } = browser();
    const raw = screen.render(80, plainTheme(), NOW);
    const lines = strip(raw);
    expect(lines[0]).toMatch(
      /^ Sign in to Honcho · browser +c copy link · p paste URL · esc cancel$/,
    );
    expect(lines).toContain(" ⠋ Waiting for you to approve in the browser…");
    const start = lines.indexOf(" Browser didn't open? Go to:");
    const end = lines.indexOf("", start);
    const rows = lines.slice(start + 1, end);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map((row) => row.slice(1)).join("")).toBe(AUTHORIZE_URL);
    for (const row of rows) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(80);
    }
    for (const row of raw.slice(start + 1, end)) {
      expect(row).toContain(`\x1b]8;;${AUTHORIZE_URL}\x1b\\`);
    }
    expect(lines).toContain(" Callback on 127.0.0.1:53682 · times out in 4:51");
  });

  it("counts down as time passes", () => {
    const { screen } = browser();
    expect(strip(screen.render(80, plainTheme(), NOW + 290_500))).toContain(
      " Callback on 127.0.0.1:53682 · times out in 0:00",
    );
  });

  it("c copies the authorize URL and flashes the hint", async () => {
    const { screen, copy } = browser();
    expect(screen.handleInput("c")).toBe(true);
    await screen.copying;
    expect(copy).toHaveBeenCalledWith(AUTHORIZE_URL);
    expect(screen.render(100, plainTheme(), NOW)[0]).toMatch(
      /c copied · p paste URL · esc cancel$/,
    );
    expect(screen.render(100, plainTheme(), NOW + 5_000)[0]).toMatch(/c copy link · p paste URL/);
  });

  it.each(["SSH_CONNECTION", "SSH_CLIENT", "MOSH_CONNECTION"])(
    "says the link went to the terminal when %s is set, since the copy can't be confirmed",
    async (key) => {
      const { screen } = browser(undefined, undefined, { [key]: "1" });
      screen.handleInput("c");
      await screen.copying;
      expect(screen.render(100, plainTheme(), NOW)[0]).toMatch(
        /c sent to terminal · p paste URL · esc cancel$/,
      );
    },
  );

  it("says when the copy failed", async () => {
    const { screen } = browser(vi.fn(async () => Promise.reject(new Error("no clipboard"))));
    screen.handleInput("c");
    await screen.copying;
    expect(screen.render(200, taggedTheme(), NOW)[0]).toContain("<warning>copy failed</warning>");
  });

  it("p accepts the redirected URL and hands it to the login", () => {
    const { screen, submitRedirectUrl } = browser();
    const v = view();
    v.show(screen);
    v.handleInput("p");
    let lines = strip(screen.render(100, plainTheme(), NOW));
    expect(lines[0]).toMatch(/enter submit · esc back$/);
    expect(lines).toContain(" Paste the URL the browser was redirected to:");

    v.handleInput("\x1b[200~not a url\x1b[201~");
    v.handleInput("\r");
    expect(submitRedirectUrl).not.toHaveBeenCalled();
    lines = strip(screen.render(100, plainTheme(), NOW));
    expect(lines).toContain(" ✗ Paste the full URL from the browser's address bar.");

    v.handleInput("\x15");
    v.handleInput("\x1b[200~http://127.0.0.1:53682/callback?state=xyz\x1b[201~");
    v.handleInput("\r");
    expect(strip(screen.render(100, plainTheme(), NOW))).toContain(
      " ✗ That URL has no sign-in code. Paste the address the browser landed on after you approved.",
    );

    v.handleInput("\x15");
    v.handleInput("\x1b[200~http://127.0.0.1:53682/callback?code=abc&state=xyz\x1b[201~");
    v.handleInput("\r");
    expect(submitRedirectUrl).toHaveBeenCalledWith(
      "http://127.0.0.1:53682/callback?code=abc&state=xyz",
    );
    lines = strip(screen.render(100, plainTheme(), NOW));
    expect(lines).toContain(" ⠋ Finishing sign-in…");
    expect(lines).not.toContain(" Paste the URL the browser was redirected to:");
    expect(v.signal.aborted).toBe(false);
  });

  it("a paste on the waiting screen opens the field with the URL in it", () => {
    const { screen, submitRedirectUrl } = browser();
    const v = view();
    v.show(screen);
    v.handleInput("\x1b[200~http://127.0.0.1:53682/callback?code=abc&state=xyz\x1b[201~");
    expect(screen.state.paste).toBeDefined();
    expect(strip(screen.render(100, plainTheme(), NOW)).map((l) => l.trimEnd())).toContain(
      " > http://127.0.0.1:53682/callback?code=abc&state=xyz",
    );
    expect(submitRedirectUrl).not.toHaveBeenCalled();
    v.handleInput("\r");
    expect(submitRedirectUrl).toHaveBeenCalledWith(
      "http://127.0.0.1:53682/callback?code=abc&state=xyz",
    );
  });

  it("wraps a long paste error", () => {
    const { screen } = browser();
    const v = view();
    v.show(screen);
    v.handleInput("p");
    v.handleInput("\x1b[200~http://127.0.0.1:53682/callback?state=xyz\x1b[201~");
    v.handleInput("\r");
    const lines = strip(v.render(60));
    expect(lines).toContain(" ✗ That URL has no sign-in code. Paste the address the");
    expect(lines).toContain("   browser landed on after you approved.");
  });

  it("esc in the paste field goes back instead of cancelling", () => {
    const { screen } = browser();
    const v = view();
    v.show(screen);
    v.handleInput("p");
    v.handleInput("\x1b");
    expect(v.signal.aborted).toBe(false);
    expect(screen.state.paste).toBeUndefined();
    v.handleInput("\x1b");
    expect(v.signal.aborted).toBe(true);
  });

  it("checks pasted URLs", () => {
    expect(checkRedirectUrl("http://127.0.0.1:1/callback?code=a&state=b")).toBeUndefined();
    expect(checkRedirectUrl(" http://127.0.0.1:1/callback?error=access_denied ")).toBeUndefined();
    expect(checkRedirectUrl("code=abc")).toMatch(/full URL/);
  });
});

describe("device screen", () => {
  const device = () => {
    const copy = vi.fn(async () => {});
    const open = vi.fn();
    const screen = new DeviceScreen(
      {
        verificationUri: "https://app.honcho.dev/device",
        verificationUriComplete: "https://app.honcho.dev/device?user_code=WDJB-MJHT",
        userCode: "WDJB-MJHT",
        expiresAt: NOW + 572_000,
        note: 'The approval page will say "Honcho CLI".',
      },
      { copy, open },
      () => NOW,
    );
    return { screen, copy, open };
  };

  it("renders the steps, the code and the expiry countdown", () => {
    const { screen } = device();
    const raw = screen.render(100, plainTheme(), NOW);
    const lines = strip(raw);
    expect(lines[0]).toMatch(
      /^ Sign in to Honcho · device code +c copy code · o open link · esc cancel$/,
    );
    expect(lines.slice(1)).toEqual([
      "",
      " 1. On any device, open  https://app.honcho.dev/device",
      " 2. Enter this code:",
      "",
      "        WDJB-MJHT",
      "",
      " ⠋ Waiting for approval · code expires in 9:32",
      ' The approval page will say "Honcho CLI".',
      "",
    ]);
    expect(raw.join("\n")).toContain("\x1b]8;;https://app.honcho.dev/device?user_code=WDJB-MJHT");
  });

  it("shows the code bold in the warning color", () => {
    const { screen } = device();
    expect(screen.render(100, taggedTheme(), NOW)).toContain(
      "        <warning><b>WDJB-MJHT</b></warning>",
    );
  });

  it("c copies the code and o opens the prefilled link", async () => {
    const { screen, copy, open } = device();
    screen.handleInput("c");
    await screen.copying;
    expect(copy).toHaveBeenCalledWith("WDJB-MJHT");
    expect(screen.render(100, plainTheme(), NOW)[0]).toMatch(
      /c copied · o open link · esc cancel$/,
    );
    screen.handleInput("o");
    expect(open).toHaveBeenCalledWith("https://app.honcho.dev/device?user_code=WDJB-MJHT");
    expect(screen.render(100, plainTheme(), NOW)[0]).toMatch(
      /c copy code · o opened · esc cancel$/,
    );
    expect(screen.handleInput("x")).toBe(false);
  });
});

describe("api key screen", () => {
  it("masks the key and shows a rejection inline", () => {
    const screen = new ApiKeyScreen("api.honcho.dev", false);
    screen.handleInput(KEY);
    screen.setError(
      describeKeyError(new AuthenticationError("Invalid API key"), "api.honcho.dev", "claude_code"),
    );
    const lines = screen.render(100, plainTheme(), NOW);
    expect(lines[0]).toMatch(/^ Sign in to Honcho · API key +enter save · esc cancel$/);
    expect(lines.slice(1)).toEqual([
      "",
      `> hch-v3-${"•".repeat(28)}4f2a `,
      "",
      " ✗ api.honcho.dev rejected this key (401). Check it was copied in full.",
      " HONCHO_API_KEY in your environment takes precedence over a saved key.",
      "",
    ]);
    expect(lines.join("\n")).not.toContain("x".repeat(8));
    const tagged = screen.render(100, taggedTheme(), NOW);
    expect(tagged).toContain(
      "<error> ✗ api.honcho.dev rejected this key (401). Check it was copied in full.</error>",
    );
    expect(tagged).toContain(
      "<dim> HONCHO_API_KEY in your environment takes precedence over a saved key.</dim>",
    );
  });

  it("explains a key that is valid for another workspace", () => {
    const error = new AuthenticationError("JWT not permissioned for this resource");
    expect(describeKeyError(error, "api.honcho.dev", "claude_code")).toBe(
      "This key is valid but not for workspace claude_code. Change the workspace in /honcho config.",
    );
  });

  it("wraps the status and the env note under their markers at 80 columns", () => {
    const screen = new ApiKeyScreen("api.honcho.dev", true);
    screen.handleInput(KEY);
    screen.setError(
      describeKeyError(
        new AuthenticationError("JWT not permissioned for this resource"),
        "api.honcho.dev",
        "claude_code",
      ),
    );
    const v = view();
    v.show(screen);
    const lines = strip(v.render(80));
    expect(lines).toContain(
      " ✗ This key is valid but not for workspace claude_code. Change the workspace in",
    );
    expect(lines).toContain("   /honcho config.");
    expect(strip(v.render(50))).toEqual(
      expect.arrayContaining([
        " HONCHO_API_KEY in your environment takes",
        " precedence over a saved key.",
      ]),
    );
    expect(lines.some((l) => l.includes("…"))).toBe(false);
  });

  it("highlights the env note when HONCHO_API_KEY is set", () => {
    const lines = new ApiKeyScreen("api.honcho.dev", true).render(100, taggedTheme(), NOW);
    expect(lines).toContain(
      "<warning> HONCHO_API_KEY in your environment takes precedence over a saved key.</warning>",
    );
  });

  it("shows a placeholder and a spinner while checking", () => {
    const screen = new ApiKeyScreen("api.honcho.dev", false);
    expect(screen.render(80, plainTheme(), NOW)).toContain(">  paste your key");
    screen.handleInput("hch-v3-abc");
    screen.setChecking();
    expect(screen.animated).toBe(true);
    expect(screen.render(80, plainTheme(), 0)).toContain(
      " ⠋ Checking the key with api.honcho.dev…",
    );
  });

  it("submits the trimmed value on enter and ignores input while checking", () => {
    const screen = new ApiKeyScreen("api.honcho.dev", false);
    const onSubmit = vi.fn();
    screen.onSubmit = onSubmit;
    screen.handleInput("\r");
    expect(onSubmit).not.toHaveBeenCalled();
    screen.handleInput("\x1b[200~ hch-v3-abc\n\x1b[201~");
    screen.handleInput("\r");
    expect(onSubmit).toHaveBeenCalledWith("hch-v3-abc");
    screen.setChecking();
    screen.handleInput("d");
    screen.handleInput("\r");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.state.value).toBe("hch-v3-abc");
    expect(screen.handleInput("\x1b")).toBe(false);
  });

  it("clears the error once the key is edited", () => {
    const screen = new ApiKeyScreen("api.honcho.dev", false);
    screen.handleInput("abc");
    screen.setError("nope");
    screen.handleInput("\x7f");
    expect(screen.state.status).toEqual({ kind: "idle" });
  });
});

describe("maskKey", () => {
  it("keeps the first 7 and last 4 characters of long keys", () => {
    expect(maskKey(KEY)).toBe(`hch-v3-${"•".repeat(28)}4f2a`);
    expect(maskKey("hch-v3-a4f2a")).toBe("hch-v3-•4f2a");
  });

  it("is all bullets below 12 characters", () => {
    expect(maskKey("")).toBe("");
    expect(maskKey("abc")).toBe("•••");
    expect(maskKey("hch-v3-4f2a")).toBe("•".repeat(11));
  });

  it("shrinks the bullets to fit, keeping at least one", () => {
    expect(maskKey(KEY, 20)).toBe(`hch-v3-${"•".repeat(9)}4f2a`);
    expect(maskKey(KEY, 5)).toBe("hch-v3-•4f2a");
  });

  it("does not split surrogate pairs", () => {
    expect(maskKey("😀😀😀")).toBe("•••");
  });
});

describe("MaskedInput", () => {
  it("appends printable characters and treats a multi-character chunk as a paste", () => {
    const input = new MaskedInput();
    input.handleInput("h");
    input.handleInput("ch-v3-");
    expect(input.value).toBe("hch-v3-");
  });

  it("deletes with backspace and clears with ctrl+u", () => {
    const input = new MaskedInput();
    input.handleInput("abcd");
    input.handleInput("\x7f");
    expect(input.value).toBe("abc");
    input.handleInput("\x15");
    expect(input.value).toBe("");
    input.handleInput("\x7f");
    expect(input.value).toBe("");
  });

  it("strips whitespace and line breaks from bracketed pastes, even split across chunks", () => {
    const input = new MaskedInput();
    input.handleInput("\x1b[200~hch-v3-");
    expect(input.pasting).toBe(true);
    input.handleInput("ab cd\r\n\x1b[201~e");
    expect(input.pasting).toBe(false);
    expect(input.value).toBe("hch-v3-abcde");
  });

  it("ignores navigation keys and decodes Kitty printable keys", () => {
    const input = new MaskedInput();
    input.handleInput("\x1b[D");
    input.handleInput("\x1b[A");
    input.handleInput("\t");
    input.handleInput("\x1b[97u");
    expect(input.value).toBe("a");
  });
});

describe("formatClock", () => {
  it("formats M:SS, rounding up and never negative", () => {
    expect(formatClock(600_000)).toBe("10:00");
    expect(formatClock(59_001)).toBe("1:00");
    expect(formatClock(9_000)).toBe("0:09");
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(-5_000)).toBe("0:00");
  });
});
