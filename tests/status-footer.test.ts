import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FooterStatus,
  STATUS_KEY,
  formatCount,
  formatSeconds,
  renderFooter,
} from "../extensions/ui/status.js";
import type { FooterState } from "../extensions/ui/status.js";
import { plainTheme, taggedTheme } from "./helpers/theme.js";

const connected: FooterState = {
  kind: "connected",
  peer: "aakash",
  workspace: "claude_code",
  session: "aakash-demo",
  conclusions: 1284,
};

describe("renderFooter copy (StatusLine.dc.html)", () => {
  const plain = (state: FooterState, frame = 0, now = 0) =>
    renderFooter(state, plainTheme(), frame, now);

  it("connected", () => {
    expect(plain(connected)).toBe("● honcho  aakash@claude_code · aakash-demo · 1,284 conclusions");
  });

  it("connected before the count loads, and with one conclusion", () => {
    expect(plain({ ...connected, conclusions: undefined })).toBe(
      "● honcho  aakash@claude_code · aakash-demo",
    );
    expect(plain({ ...connected, conclusions: 0 })).toBe(
      "● honcho  aakash@claude_code · aakash-demo · 0 conclusions",
    );
    expect(plain({ ...connected, conclusions: 1 })).toBe(
      "● honcho  aakash@claude_code · aakash-demo · 1 conclusion",
    );
  });

  it("working", () => {
    expect(plain({ kind: "working", label: "checking memory", since: 1_000 }, 0, 2_200)).toBe(
      "◐ honcho  checking memory · 1.2s",
    );
  });

  it("spins through the frames", () => {
    const frames = [0, 1, 2, 3, 4].map((f) => plain({ kind: "connecting" }, f).slice(0, 1));
    expect(frames).toEqual(["◐", "◓", "◑", "◒", "◐"]);
  });

  it("not signed in", () => {
    expect(plain({ kind: "signed-out" })).toBe("○ honcho  not signed in · /honcho login");
  });

  it("sign-in expired", () => {
    expect(plain({ kind: "expired" })).toBe("▲ honcho  sign-in expired · /honcho login");
  });

  it("endpoint unreachable", () => {
    expect(plain({ kind: "unreachable", host: "api.honcho.dev" })).toBe(
      "▲ honcho  api.honcho.dev unreachable · memory paused, retrying",
    );
  });

  it("turned off", () => {
    expect(plain({ kind: "off" })).toBe("○ honcho  off · /honcho on");
  });

  it("connecting, signing in and error", () => {
    expect(plain({ kind: "connecting" })).toBe("◐ honcho  connecting…");
    expect(plain({ kind: "signing-in" }, 2)).toBe("◑ honcho  signing in…");
    expect(plain({ kind: "error", message: "~/.honcho/config.json is not valid JSON" })).toBe(
      "▲ honcho  ~/.honcho/config.json is not valid JSON",
    );
  });
});

describe("renderFooter colors", () => {
  const tagged = (state: FooterState, now = 0) => renderFooter(state, taggedTheme(), 0, now);

  it("connected: green dot, lavender label, dim details", () => {
    expect(tagged(connected)).toBe(
      "<success>●</success> <accent>honcho</accent><dim>  aakash@claude_code · aakash-demo · 1,284 conclusions</dim>",
    );
  });

  it("working: lavender spinner and label, dim details", () => {
    expect(tagged({ kind: "working", label: "loading context", since: 0 }, 300)).toBe(
      "<accent>◐</accent> <accent>honcho</accent><dim>  loading context · 0.3s</dim>",
    );
  });

  it("signed out: dim circle and details", () => {
    expect(tagged({ kind: "signed-out" })).toBe(
      "<dim>○</dim> <accent>honcho</accent><dim>  not signed in · /honcho login</dim>",
    );
  });

  it("expired: orange triangle and text", () => {
    expect(tagged({ kind: "expired" })).toBe(
      "<warning>▲</warning> <accent>honcho</accent><warning>  sign-in expired · /honcho login</warning>",
    );
  });

  it("unreachable and error: red triangle and text", () => {
    expect(tagged({ kind: "unreachable", host: "api.honcho.dev" })).toBe(
      "<error>▲</error> <accent>honcho</accent><error>  api.honcho.dev unreachable · memory paused, retrying</error>",
    );
    expect(tagged({ kind: "error", message: "bad" })).toBe(
      "<error>▲</error> <accent>honcho</accent><error>  bad</error>",
    );
  });

  it("off: the whole line dim", () => {
    expect(tagged({ kind: "off" })).toBe("<dim>○ honcho  off · /honcho on</dim>");
  });
});

describe("formatters", () => {
  it("formatCount groups thousands", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1284)).toBe("1,284");
    expect(formatCount(1_234_567)).toBe("1,234,567");
  });

  it("formatSeconds keeps one decimal", () => {
    expect(formatSeconds(0)).toBe("0.0s");
    expect(formatSeconds(1_249)).toBe("1.2s");
    expect(formatSeconds(30_000)).toBe("30.0s");
  });
});

interface FakeCtx {
  ctx: ExtensionContext;
  setStatus: ReturnType<typeof vi.fn>;
  statuses: (string | undefined)[];
}

const fakeCtx = (opts: { mode?: string; throws?: boolean } = {}): FakeCtx => {
  const statuses: (string | undefined)[] = [];
  const setStatus = vi.fn((key: string, text: string | undefined) => {
    if (opts.throws) {
      throw new Error("This extension ctx is stale after session replacement");
    }
    expect(key).toBe(STATUS_KEY);
    statuses.push(text);
  });
  const ctx = {
    mode: opts.mode ?? "tui",
    ui: { setStatus, theme: plainTheme() },
  } as unknown as ExtensionContext;
  return { ctx, setStatus, statuses };
};

describe("FooterStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the current state on attach", () => {
    const footer = new FooterStatus();
    const { ctx, statuses } = fakeCtx();
    footer.attach(ctx);
    expect(statuses).toEqual(["◐ honcho  connecting…"]);
    footer.dispose();
  });

  it("animates while connecting and stops once connected", () => {
    const footer = new FooterStatus();
    const { ctx, statuses } = fakeCtx();
    footer.attach(ctx);
    footer.set({ kind: "connecting" });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(120 * 3);
    expect(statuses.slice(-3).map((s) => s?.slice(0, 1))).toEqual(["◓", "◑", "◒"]);
    footer.set(connected);
    expect(vi.getTimerCount()).toBe(0);
    const count = statuses.length;
    vi.advanceTimersByTime(1_000);
    expect(statuses.length).toBe(count);
    expect(statuses.at(-1)).toBe("● honcho  aakash@claude_code · aakash-demo · 1,284 conclusions");
  });

  it("does not start a second timer for consecutive animated states", () => {
    const footer = new FooterStatus();
    footer.attach(fakeCtx().ctx);
    footer.set({ kind: "connecting" });
    footer.set({ kind: "signing-in" });
    expect(vi.getTimerCount()).toBe(1);
    footer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows working for the task's duration, then restores the resting state", async () => {
    const footer = new FooterStatus();
    const { ctx, statuses } = fakeCtx();
    footer.attach(ctx);
    footer.set(connected);
    let release!: (value: string) => void;
    const result = footer.working(
      "checking memory",
      () => new Promise<string>((resolve) => (release = resolve)),
    );
    expect(footer.current.kind).toBe("working");
    expect(footer.base).toEqual(connected);
    vi.advanceTimersByTime(1_200);
    expect(statuses.at(-1)).toMatch(/^. honcho {2}checking memory · 1\.2s$/);
    release("answer");
    await expect(result).resolves.toBe("answer");
    expect(footer.current).toEqual(connected);
    expect(statuses.at(-1)).toBe("● honcho  aakash@claude_code · aakash-demo · 1,284 conclusions");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores the resting state when the task fails", async () => {
    const footer = new FooterStatus();
    footer.attach(fakeCtx().ctx);
    footer.set(connected);
    await expect(
      footer.working("saving", async () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(footer.current).toEqual(connected);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an error that arrives mid-task instead of restoring", async () => {
    const footer = new FooterStatus();
    footer.attach(fakeCtx().ctx);
    footer.set(connected);
    await footer.working("checking memory", async () => {
      footer.set({ kind: "unreachable", host: "api.honcho.dev" });
    });
    expect(footer.current).toEqual({ kind: "unreachable", host: "api.honcho.dev" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the spinner when a count refresh lands mid-task", async () => {
    const footer = new FooterStatus();
    const { ctx, statuses } = fakeCtx();
    footer.attach(ctx);
    footer.set({ ...connected, conclusions: undefined });
    let release!: () => void;
    const pending = footer.working(
      "checking memory",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    footer.set(connected);
    expect(footer.current.kind).toBe("working");
    expect(vi.getTimerCount()).toBe(1);
    expect(statuses.at(-1)).toMatch(/checking memory/);
    release();
    await pending;
    expect(footer.current).toEqual(connected);
    expect(statuses.at(-1)).toBe("● honcho  aakash@claude_code · aakash-demo · 1,284 conclusions");
  });

  it("shows a recovery after a mid-task error", async () => {
    const footer = new FooterStatus();
    footer.attach(fakeCtx().ctx);
    footer.set(connected);
    await footer.working("checking memory", async () => {
      footer.set({ kind: "unreachable", host: "api.honcho.dev" });
      footer.set(connected);
    });
    expect(footer.current).toEqual(connected);
  });

  it("keeps working until the last overlapping task ends", async () => {
    const footer = new FooterStatus();
    footer.attach(fakeCtx().ctx);
    footer.set(connected);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = footer.working(
      "saving",
      () => new Promise<void>((resolve) => (releaseFirst = resolve)),
    );
    const second = footer.working(
      "checking memory",
      () => new Promise<void>((resolve) => (releaseSecond = resolve)),
    );
    releaseFirst();
    await first;
    expect(footer.current).toMatchObject({ kind: "working", label: "checking memory" });
    expect(vi.getTimerCount()).toBe(1);
    releaseSecond();
    await second;
    expect(footer.current).toEqual(connected);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("survives a throwing setStatus and stops its timer", () => {
    const footer = new FooterStatus();
    const { ctx, setStatus } = fakeCtx({ throws: true });
    expect(() => footer.attach(ctx)).not.toThrow();
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(() => footer.set({ kind: "connecting" })).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(setStatus).toHaveBeenCalledTimes(1);
  });

  it("stops when the timer's own render throws", () => {
    const footer = new FooterStatus();
    let fail = false;
    const setStatus = vi.fn(() => {
      if (fail) {
        throw new Error("stale");
      }
    });
    footer.attach({
      mode: "tui",
      ui: { setStatus, theme: plainTheme() },
    } as unknown as ExtensionContext);
    footer.set({ kind: "connecting" });
    expect(vi.getTimerCount()).toBe(1);
    fail = true;
    vi.advanceTimersByTime(120);
    expect(vi.getTimerCount()).toBe(0);
    const calls = setStatus.mock.calls.length;
    footer.set(connected);
    expect(setStatus.mock.calls.length).toBe(calls);
  });

  it("does not render outside the TUI", () => {
    const footer = new FooterStatus();
    const { ctx, setStatus } = fakeCtx({ mode: "print" });
    footer.attach(ctx);
    footer.set(connected);
    expect(setStatus).not.toHaveBeenCalled();
    footer.dispose();
  });

  it("does nothing after dispose", () => {
    const footer = new FooterStatus();
    const { ctx, setStatus } = fakeCtx();
    footer.attach(ctx);
    footer.dispose();
    footer.set({ kind: "connecting" });
    expect(vi.getTimerCount()).toBe(0);
    expect(setStatus).toHaveBeenCalledTimes(1);
  });
});
