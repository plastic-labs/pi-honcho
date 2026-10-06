import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveSessionName,
  resolveWorktreeMainRoot,
  sanitizeSessionPart,
  sessionsMap,
  strategyLabel,
  worktreeMainRootFor,
} from "../extensions/session-name.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-honcho-session-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A main checkout at `<root>/<name>` with a linked worktree at `<root>/<wt>`. */
const linkedWorktree = (
  name: string,
  wt: string,
  gitdirLine?: (gitdir: string, wtPath: string) => string,
) => {
  const main = join(root, name);
  const wtPath = join(root, wt);
  const gitdir = join(main, ".git", "worktrees", wt);
  mkdirSync(gitdir, { recursive: true });
  mkdirSync(join(wtPath, "src", "deep"), { recursive: true });
  writeFileSync(
    join(wtPath, ".git"),
    gitdirLine ? gitdirLine(gitdir, wtPath) : `gitdir: ${gitdir}\n`,
  );
  return { main, wtPath };
};

describe("sanitizeSessionPart", () => {
  it("lowercases and replaces everything outside [a-z0-9_-]", () => {
    expect(sanitizeSessionPart("Feature/ABC-12_x.y z")).toBe("feature-abc-12_x-y-z");
    expect(sanitizeSessionPart("ünï")).toBe("-n-");
  });
});

describe("deriveSessionName", () => {
  const base = { cwd: "/Users/aakash/workspace/Pi Honcho", peerName: "Aakash", mainRoot: null };

  it("per-directory: <peer>-<basename>", () => {
    expect(deriveSessionName({ ...base, strategy: "per-directory" })).toBe("aakash-pi-honcho");
  });

  it("git-branch: appends the sanitized branch, or falls back to per-directory", () => {
    expect(deriveSessionName({ ...base, strategy: "git-branch", branch: "aakash/v2" })).toBe(
      "aakash-pi-honcho-aakash-v2",
    );
    expect(deriveSessionName({ ...base, strategy: "git-branch" })).toBe("aakash-pi-honcho");
  });

  it("chat-instance: <peer>-chat-<id>, or falls back to per-directory", () => {
    expect(
      deriveSessionName({ ...base, strategy: "chat-instance", instanceId: "0199ABCD-ef" }),
    ).toBe("aakash-chat-0199abcd-ef");
    expect(deriveSessionName({ ...base, strategy: "chat-instance" })).toBe("aakash-pi-honcho");
  });

  it("uses user when the peer name is empty", () => {
    expect(deriveSessionName({ ...base, peerName: "", strategy: "per-directory" })).toBe(
      "user-pi-honcho",
    );
  });

  it("always yields a valid Honcho id", () => {
    for (const strategy of ["per-directory", "git-branch", "chat-instance"] as const) {
      const name = deriveSessionName({
        cwd: "/tmp/we!rd dir.d",
        peerName: "Ünïcode Name",
        strategy,
        branch: "a/b@{c}",
        instanceId: "x:y",
      });
      expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("honors the shared sessions map for per-directory only", () => {
    const sessions = { "/Users/aakash/workspace/Pi Honcho": "  custom-session  " };
    expect(deriveSessionName({ ...base, strategy: "per-directory", sessions })).toBe(
      "custom-session",
    );
    expect(deriveSessionName({ ...base, strategy: "git-branch", branch: "main", sessions })).toBe(
      "aakash-pi-honcho-main",
    );
    expect(
      deriveSessionName({ ...base, strategy: "chat-instance", instanceId: "i", sessions }),
    ).toBe("aakash-chat-i");
  });

  it("ignores blank or non-string map entries", () => {
    expect(
      deriveSessionName({ ...base, strategy: "per-directory", sessions: { [base.cwd]: "  " } }),
    ).toBe("aakash-pi-honcho");
    expect(
      deriveSessionName({ ...base, strategy: "per-directory", sessions: { [base.cwd]: 5 } }),
    ).toBe("aakash-pi-honcho");
  });

  it("falls back to the worktree's main root in the sessions map and for the basename", () => {
    const input = { cwd: "/w/feature-x", peerName: "aakash", mainRoot: "/repos/app" };
    expect(
      deriveSessionName({
        ...input,
        strategy: "per-directory",
        sessions: { "/repos/app": "app-session" },
      }),
    ).toBe("app-session");
    expect(
      deriveSessionName({
        ...input,
        strategy: "per-directory",
        sessions: { "/w/feature-x": "own", "/repos/app": "app-session" },
      }),
    ).toBe("own");
    expect(deriveSessionName({ ...input, strategy: "per-directory" })).toBe("aakash-app");
    expect(deriveSessionName({ ...input, strategy: "git-branch", branch: "feature-x" })).toBe(
      "aakash-app-feature-x",
    );
  });

  it("detects the worktree itself when mainRoot is not given", () => {
    const { main, wtPath } = linkedWorktree("my-repo", "my-repo-feature");
    expect(
      deriveSessionName({
        cwd: join(wtPath, "src"),
        peerName: "aakash",
        strategy: "per-directory",
      }),
    ).toBe("aakash-my-repo");
    expect(
      deriveSessionName({
        cwd: wtPath,
        peerName: "aakash",
        strategy: "per-directory",
        sessions: { [main]: "mapped" },
      }),
    ).toBe("mapped");
  });
});

describe("worktree detection", () => {
  it("resolves the main root of a standard linked worktree from any subdirectory", () => {
    const { main, wtPath } = linkedWorktree("repo", "repo-wt");
    expect(resolveWorktreeMainRoot(wtPath)).toBe(main);
    expect(worktreeMainRootFor(wtPath)).toBe(main);
    expect(worktreeMainRootFor(join(wtPath, "src", "deep"))).toBe(main);
  });

  it("accepts a relative gitdir and surrounding whitespace", () => {
    const { main, wtPath } = linkedWorktree(
      "rel",
      "rel-wt",
      (gitdir, wt) => `gitdir:   ${relative(wt, gitdir)}   \n`,
    );
    expect(resolveWorktreeMainRoot(wtPath)).toBe(main);
  });

  it("resolves a bare hub layout to the hub directory", () => {
    const hub = join(root, "project.git");
    const wtPath = join(root, "project-main");
    mkdirSync(join(hub, "worktrees", "main"), { recursive: true });
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(wtPath, ".git"), `gitdir: ${join(hub, "worktrees", "main")}\n`);
    expect(resolveWorktreeMainRoot(wtPath)).toBe(hub);
    expect(deriveSessionName({ cwd: wtPath, peerName: "aakash", strategy: "per-directory" })).toBe(
      "aakash-project-git",
    );
  });

  it("returns null for a regular repository", () => {
    const repo = join(root, "plain");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "a", "b"), { recursive: true });
    expect(resolveWorktreeMainRoot(repo)).toBeNull();
    expect(worktreeMainRootFor(join(repo, "a", "b"))).toBeNull();
  });

  it("returns null for submodules and separate git dirs", () => {
    const sub = join(root, "super", "sub");
    mkdirSync(join(root, "super", ".git", "modules", "sub"), { recursive: true });
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, ".git"), "gitdir: ../.git/modules/sub\n");
    expect(resolveWorktreeMainRoot(sub)).toBeNull();
    const sep = join(root, "sep");
    mkdirSync(sep, { recursive: true });
    writeFileSync(join(sep, ".git"), `gitdir: ${join(root, "elsewhere.git")}\n`);
    expect(resolveWorktreeMainRoot(sep)).toBeNull();
  });

  it("returns null for a malformed .git file or a missing directory", () => {
    const bad = join(root, "bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, ".git"), "not a pointer");
    expect(resolveWorktreeMainRoot(bad)).toBeNull();
    expect(resolveWorktreeMainRoot(join(root, "missing"))).toBeNull();
    expect(worktreeMainRootFor(join(root, "missing", "deeper"))).toBeNull();
  });

  it("stops at the nearest .git, so a nested plain repo inside a worktree is not the worktree", () => {
    const { wtPath } = linkedWorktree("outer", "outer-wt");
    const nested = join(wtPath, "vendor", "lib");
    mkdirSync(join(nested, ".git"), { recursive: true });
    expect(worktreeMainRootFor(nested)).toBeNull();
  });
});

describe("helpers", () => {
  it("sessionsMap reads only an object", () => {
    expect(sessionsMap({ sessions: { "/a": "b" } })).toEqual({ "/a": "b" });
    expect(sessionsMap({ sessions: ["x"] })).toBeUndefined();
    expect(sessionsMap({})).toBeUndefined();
  });

  it("strategyLabel", () => {
    expect(strategyLabel("per-directory")).toBe("one per directory");
    expect(strategyLabel("git-branch")).toBe("one per git branch");
    expect(strategyLabel("chat-instance")).toBe("one per pi session");
  });
});
