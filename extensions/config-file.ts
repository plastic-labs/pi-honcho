import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { configPath } from "@honcho-ai/harness-plugin-core";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface JsonObject {
  [key: string]: Json;
}

export const HOST = "pi";

export class ConfigParseError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`${path} is not valid JSON; pi will not overwrite it`);
    this.cause = cause;
  }
}

export const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `HONCHO_CONFIG_PATH`, else `~/.honcho/config.json`. */
export const getConfigPath = (env: NodeJS.ProcessEnv = process.env): string => configPath(env);

export const displayPath = (path: string): string => {
  const home = process.env.HOME;
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
};

/** Reads the file; `{}` when missing, throws `ConfigParseError` when unreadable JSON. */
export const readConfigStrict = (path = getConfigPath()): JsonObject => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) {
      throw new TypeError("top-level value is not an object");
    }
    return parsed;
  } catch (error) {
    throw new ConfigParseError(path, error);
  }
};

/** Never throws; `{}` on any read or parse failure. */
export const readConfig = (path = getConfigPath()): JsonObject => {
  try {
    return readConfigStrict(path);
  } catch {
    return {};
  }
};

/** Atomic write (temp file + rename) with mode 0600. */
export const writeConfigAtomic = (data: JsonObject, configFile = getConfigPath()): void => {
  // Write through a symlinked config (dotfile managers) instead of replacing the link
  let path = configFile;
  try {
    path = realpathSync(configFile);
  } catch {
    // Not created yet
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes
  }
};

/** Read-modify-write against a fresh read; refuses to write over a file that does not parse. */
export const updateConfig = (
  mutate: (config: JsonObject) => void,
  path = getConfigPath(),
): JsonObject => {
  const config = readConfigStrict(path);
  mutate(config);
  writeConfigAtomic(config, path);
  return config;
};

export const hostBlock = (config: JsonObject): JsonObject => {
  const { hosts } = config;
  if (!isObject(hosts)) {
    return {};
  }
  const block = hosts[HOST];
  return isObject(block) ? block : {};
};

/** Returns `hosts.pi`, creating it (and `hosts`) when absent. */
export const ensureHostBlock = (config: JsonObject): JsonObject => {
  if (!isObject(config.hosts)) {
    config.hosts = {};
  }
  const hosts = config.hosts as JsonObject;
  if (!isObject(hosts[HOST])) {
    hosts[HOST] = {};
  }
  return hosts[HOST] as JsonObject;
};

/** Sets `obj[a][b]...` creating intermediate objects; `undefined` deletes the leaf. */
export const setPath = (obj: JsonObject, path: string[], value: Json | undefined): void => {
  let cursor = obj;
  for (const key of path.slice(0, -1)) {
    if (!isObject(cursor[key])) {
      // Deleting under a missing parent must not create empty blocks
      if (value === undefined) {
        return;
      }
      cursor[key] = {};
    }
    cursor = cursor[key] as JsonObject;
  }
  const leaf = path.at(-1);
  if (leaf === undefined) {
    return;
  }
  if (value === undefined) {
    delete cursor[leaf];
  } else {
    cursor[leaf] = value;
  }
};

export const getPath = (obj: JsonObject, path: string[]): Json | undefined => {
  let cursor: Json | undefined = obj;
  for (const key of path) {
    if (!isObject(cursor)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return cursor;
};

const LOCK_STALE_MS = 20_000;
const LOCK_WAIT_MS = 25_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Cross-process mutex for token refresh, an atomic `mkdir` beside the config file. */
export const withConfigLock = async <T>(
  fn: () => Promise<T>,
  path = getConfigPath(),
): Promise<T> => {
  const lock = join(dirname(path), ".pi-honcho.lock");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const giveUp = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > giveUp) {
        throw new Error("timed out waiting for the Honcho config lock");
      }
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
};
