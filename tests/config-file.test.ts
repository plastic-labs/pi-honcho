import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigParseError,
  HOST,
  displayPath,
  ensureHostBlock,
  getConfigPath,
  getPath,
  hostBlock,
  readConfig,
  readConfigStrict,
  setPath,
  updateConfig,
  withConfigLock,
  writeConfigAtomic,
} from "../extensions/config-file.js";
import type { JsonObject } from "../extensions/config-file.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-honcho-config-"));
  path = join(dir, ".honcho", "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (content: string) => {
  mkdirSync(join(dir, ".honcho"), { recursive: true });
  writeFileSync(path, content);
};

const lockDir = () => join(dir, ".honcho", ".pi-honcho.lock");

describe("getConfigPath", () => {
  it("honors HONCHO_CONFIG_PATH verbatim", () => {
    expect(getConfigPath({ HONCHO_CONFIG_PATH: "/x/y.json", HOME: "/home/u" })).toBe("/x/y.json");
  });

  it("falls back to ~/.honcho/config.json under HOME", () => {
    expect(getConfigPath({ HOME: "/home/u" })).toBe("/home/u/.honcho/config.json");
  });
});

describe("displayPath", () => {
  it("abbreviates paths under HOME", () => {
    const home = process.env.HOME ?? "/nonexistent";
    expect(displayPath(`${home}/.honcho/config.json`)).toBe("~/.honcho/config.json");
    expect(displayPath("/etc/honcho.json")).toBe("/etc/honcho.json");
  });
});

describe("readConfigStrict", () => {
  it("returns {} when the file is missing", () => {
    expect(readConfigStrict(path)).toEqual({});
  });

  it("returns {} for an empty or whitespace-only file", () => {
    write("");
    expect(readConfigStrict(path)).toEqual({});
    write("  \n\t");
    expect(readConfigStrict(path)).toEqual({});
  });

  it("throws ConfigParseError on invalid JSON, keeping the cause", () => {
    write('{"apiKey": "k",');
    const error = (() => {
      try {
        readConfigStrict(path);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ConfigParseError);
    expect((error as ConfigParseError).path).toBe(path);
    expect((error as ConfigParseError).message).toBe(
      `${path} is not valid JSON; pi will not overwrite it`,
    );
    expect((error as ConfigParseError).cause).toBeInstanceOf(SyntaxError);
  });

  it("parses an object", () => {
    write('{"apiKey":"k","hosts":{"pi":{"workspace":"w"}}}');
    expect(readConfigStrict(path)).toEqual({ apiKey: "k", hosts: { pi: { workspace: "w" } } });
  });

  it("rethrows read errors other than ENOENT", () => {
    mkdirSync(path, { recursive: true });
    expect(() => readConfigStrict(path)).toThrow(/EISDIR/);
    expect(readConfig(path)).toEqual({});
  });
});

describe("readConfig", () => {
  it("never throws", () => {
    write("not json");
    expect(readConfig(path)).toEqual({});
  });
});

describe("writeConfigAtomic", () => {
  it("creates the directory, writes mode 0600 JSON with a trailing newline", () => {
    writeConfigAtomic({ apiKey: "k", nested: { a: [1, 2] } }, path);
    const raw = readFileSync(path, "utf8");
    expect(raw).toBe(`${JSON.stringify({ apiKey: "k", nested: { a: [1, 2] } }, null, 2)}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, ".honcho")).mode & 0o777).toBe(0o700);
  });

  it("tightens an existing world-readable file to 0600", () => {
    write("{}");
    chmodSync(path, 0o644);
    writeConfigAtomic({ a: 1 }, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp files behind", () => {
    writeConfigAtomic({ a: 1 }, path);
    writeConfigAtomic({ a: 2 }, path);
    expect(readdirSync(join(dir, ".honcho"))).toEqual(["config.json"]);
  });
});

describe("updateConfig", () => {
  it("preserves unknown root keys, other hosts and unknown keys inside hosts.pi", () => {
    const original = {
      apiKey: "root-key",
      environmentUrl: "https://api.honcho.dev",
      statusline: "on",
      sessions: { "/a": "aakash-a" },
      oauth: {
        accessToken: "at",
        refreshToken: "rt",
        accessExpiresAt: 1,
        clientId: "honcho-cli",
        scope: "write",
        host: "h",
      },
      hosts: {
        claude_code: { enabled: true, injection: { perTurn: ["dialectic"] }, rememberTool: true },
        hermes: { sessionStrategy: "global" },
        pi: { workspace: "claude_code", aiPeer: "pi", futureKey: { x: 1 } },
      },
    };
    write(JSON.stringify(original));
    const result = updateConfig((config) => {
      ensureHostBlock(config).enabled = false;
    }, path);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    const expected = structuredClone(original) as JsonObject;
    (expected.hosts as { pi: JsonObject }).pi.enabled = false;
    expect(onDisk).toEqual(expected);
    expect(result).toEqual(expected);
  });

  it("refuses to write over a file that does not parse", () => {
    write("{oops");
    let called = false;
    expect(() =>
      updateConfig(() => {
        called = true;
      }, path),
    ).toThrow(ConfigParseError);
    expect(called).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{oops");
  });

  it("creates the file when missing", () => {
    updateConfig((config) => {
      config.peerName = "aakash";
    }, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ peerName: "aakash" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("does not write when the mutator throws", () => {
    write('{"a":1}');
    expect(() =>
      updateConfig(() => {
        throw new Error("boom");
      }, path),
    ).toThrow("boom");
    expect(readFileSync(path, "utf8")).toBe('{"a":1}');
  });
});

describe("hostBlock / ensureHostBlock", () => {
  it("returns hosts.pi by reference when present", () => {
    const config: JsonObject = { hosts: { pi: { workspace: "w" } } };
    const block = hostBlock(config);
    block.aiPeer = "pi";
    expect(config).toEqual({ hosts: { pi: { workspace: "w", aiPeer: "pi" } } });
    expect(HOST).toBe("pi");
  });

  it("returns a detached {} when absent or malformed", () => {
    for (const config of [
      {},
      { hosts: [] },
      { hosts: { pi: "x" } },
      { hosts: null },
    ] as JsonObject[]) {
      const before = JSON.stringify(config);
      hostBlock(config).x = 1;
      expect(JSON.stringify(config)).toBe(before);
    }
  });

  it("ensureHostBlock creates hosts and hosts.pi, keeping siblings", () => {
    const config: JsonObject = { hosts: { claude_code: { enabled: true } } };
    ensureHostBlock(config).enabled = false;
    expect(config).toEqual({ hosts: { claude_code: { enabled: true }, pi: { enabled: false } } });
    const empty: JsonObject = { hosts: "bad" };
    ensureHostBlock(empty).a = 1;
    expect(empty).toEqual({ hosts: { pi: { a: 1 } } });
  });
});

describe("setPath / getPath", () => {
  it("sets nested values, creating intermediate objects", () => {
    const obj: JsonObject = { hosts: { claude_code: { x: 1 } } };
    setPath(obj, ["hosts", "pi", "injection", "perTurn"], ["dialectic"]);
    expect(obj).toEqual({
      hosts: { claude_code: { x: 1 }, pi: { injection: { perTurn: ["dialectic"] } } },
    });
    expect(getPath(obj, ["hosts", "pi", "injection", "perTurn"])).toEqual(["dialectic"]);
  });

  it("replaces a non-object intermediate", () => {
    const obj: JsonObject = { hosts: { pi: { endpoint: "https://x" } } };
    setPath(obj, ["hosts", "pi", "endpoint", "baseUrl"], "https://y");
    expect(obj).toEqual({ hosts: { pi: { endpoint: { baseUrl: "https://y" } } } });
  });

  it("deletes the leaf on undefined without creating missing parents", () => {
    const obj: JsonObject = { hosts: { pi: { apiKey: "k", workspace: "w" } } };
    setPath(obj, ["hosts", "pi", "apiKey"], undefined);
    expect(obj).toEqual({ hosts: { pi: { workspace: "w" } } });
    const empty: JsonObject = {};
    setPath(empty, ["hosts", "pi", "injection", "perTurn"], undefined);
    expect(empty).toEqual({});
  });

  it("stores null and false as values, not deletions", () => {
    const obj: JsonObject = {};
    setPath(obj, ["a"], null);
    setPath(obj, ["b"], false);
    expect(obj).toEqual({ a: null, b: false });
  });

  it("is a no-op for an empty path", () => {
    const obj: JsonObject = { a: 1 };
    setPath(obj, [], 2);
    expect(obj).toEqual({ a: 1 });
  });

  it("getPath returns undefined through non-objects", () => {
    const obj: JsonObject = { a: { b: "s" }, list: [{ c: 1 }] };
    expect(getPath(obj, ["a", "b", "c"])).toBeUndefined();
    expect(getPath(obj, ["list", "0", "c"])).toBeUndefined();
    expect(getPath(obj, ["missing", "x"])).toBeUndefined();
    expect(getPath(obj, [])).toBe(obj);
  });
});

describe("withConfigLock", () => {
  it("serializes concurrent callers and releases the lock", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const task = (name: string) =>
      withConfigLock(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(`end ${name}`);
        active -= 1;
        return name;
      }, path);
    const results = await Promise.all([task("a"), task("b"), task("c")]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(maxActive).toBe(1);
    // Every start is immediately followed by its own end
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]?.replace("start", "end")).toBe(order[i + 1]);
    }
    expect(existsSync(lockDir())).toBe(false);
  });

  it("releases the lock when fn throws", async () => {
    await expect(
      withConfigLock(async () => {
        throw new Error("inside");
      }, path),
    ).rejects.toThrow("inside");
    expect(existsSync(lockDir())).toBe(false);
    await expect(withConfigLock(async () => "again", path)).resolves.toBe("again");
  });

  it("waits for a lock held by another process", async () => {
    mkdirSync(lockDir(), { recursive: true });
    let ran = false;
    const pending = withConfigLock(async () => {
      ran = true;
    }, path);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(ran).toBe(false);
    rmSync(lockDir(), { recursive: true });
    await pending;
    expect(ran).toBe(true);
  });

  it("recovers a stale lock left by a crashed process", async () => {
    mkdirSync(lockDir(), { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir(), old, old);
    const started = Date.now();
    await expect(withConfigLock(async () => "ok", path)).resolves.toBe("ok");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(existsSync(lockDir())).toBe(false);
  });

  it("puts the lock beside the config file", async () => {
    let seen = false;
    await withConfigLock(async () => {
      seen = existsSync(lockDir());
    }, path);
    expect(seen).toBe(true);
  });
});
