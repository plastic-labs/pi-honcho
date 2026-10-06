import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isObject } from "./config-file.js";
import type { JsonObject } from "./config-file.js";
import type { SessionStrategy } from "./settings.js";

const MAX_GIT_WALK_UP = 12;

export const sanitizeSessionPart = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9_-]/g, "-");

/** Main repository root for a linked worktree, from its `.git` pointer file. */
export const resolveWorktreeMainRoot = (dir: string): string | null => {
  try {
    const gitPath = join(dir, ".git");
    if (!statSync(gitPath).isFile()) {
      return null;
    }
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(gitPath, "utf8"));
    if (!match?.[1]) {
      return null;
    }
    const gitdir = resolve(dir, match[1]);
    const idx = gitdir.lastIndexOf(`${sep}worktrees${sep}`);
    if (idx === -1) {
      return null;
    }
    const container = gitdir.slice(0, idx);
    if (basename(container) === ".git") {
      return dirname(container);
    }
    if (container.endsWith(".git")) {
      return container;
    }
    return null;
  } catch {
    return null;
  }
};

/** Main repository root when `cwd` is inside a linked worktree, else null. */
export const worktreeMainRootFor = (cwd: string): string | null => {
  let dir = resolve(cwd);
  for (let i = 0; i < MAX_GIT_WALK_UP; i++) {
    if (existsSync(join(dir, ".git"))) {
      return resolveWorktreeMainRoot(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
};

export interface SessionNameInput {
  strategy: SessionStrategy;
  cwd: string;
  peerName: string;
  /** Root `sessions` map (absolute cwd to session name), shared with other harnesses. */
  sessions?: JsonObject;
  branch?: string;
  instanceId?: string;
  mainRoot?: string | null;
}

/** Same naming as the Claude Code plugin, so a directory maps to one session across harnesses. */
export const deriveSessionName = (input: SessionNameInput): string => {
  const mainRoot = input.mainRoot === undefined ? worktreeMainRootFor(input.cwd) : input.mainRoot;
  if (input.strategy === "per-directory" && input.sessions) {
    const mapped = input.sessions[input.cwd] ?? (mainRoot ? input.sessions[mainRoot] : undefined);
    if (typeof mapped === "string" && mapped.trim()) {
      return mapped.trim();
    }
  }
  const peer = sanitizeSessionPart(input.peerName || "user");
  const base = `${peer}-${sanitizeSessionPart(basename(mainRoot ?? input.cwd))}`;
  if (input.strategy === "git-branch" && input.branch) {
    return `${base}-${sanitizeSessionPart(input.branch)}`;
  }
  if (input.strategy === "chat-instance" && input.instanceId) {
    return `${peer}-chat-${sanitizeSessionPart(input.instanceId)}`;
  }
  return base;
};

export const sessionsMap = (file: JsonObject): JsonObject | undefined =>
  isObject(file.sessions) ? file.sessions : undefined;

export const strategyLabel = (strategy: SessionStrategy): string =>
  strategy === "per-directory"
    ? "one per directory"
    : strategy === "git-branch"
      ? "one per git branch"
      : "one per pi session";
