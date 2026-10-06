import { normalizeBaseUrl } from "@honcho-ai/harness-plugin-core";
import { resolveCredential } from "../../auth/credentials.js";
import type { Credential } from "../../auth/credentials.js";
import {
  ensureHostBlock,
  hostBlock,
  readConfigStrict,
  setPath,
  updateConfig,
} from "../../config-file.js";
import type { Json, JsonObject } from "../../config-file.js";
import { deriveSessionName, sessionsMap } from "../../session-name.js";
import {
  DEFAULT_DIALECTIC_TEMPLATE,
  PER_TURN_MODES,
  REASONING_LEVELS,
  SESSION_STRATEGIES,
  endpointLabel,
  perTurnToFile,
  resolveSettings,
} from "../../settings.js";
import type { PerTurnMode, PiSettings, ReasoningLevel, SessionStrategy } from "../../settings.js";
import { scopeTag } from "../entries.js";
import type { AccountMethod, ScopeTag } from "../entries.js";

type Env = Record<string, string | undefined>;

export type Section = "Connection" | "Sessions" | "Injection" | "Tools";
export const SECTIONS: readonly Section[] = ["Connection", "Sessions", "Injection", "Tools"];

/** Row actions that need the overlay closed first. */
export type ConfigAction = "login" | "logout" | "template";

export const TEMPLATE_EDITOR_TITLE =
  "Honcho chat prompt (%{user_query} is replaced by your message)";

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const ID_ERROR = "use letters, numbers, _ or -";
const URL_ERROR = "enter an http(s) URL";

/** A dim line under a row; `value` renders in the normal text color. */
export interface HelperLine {
  text: string;
  value?: string;
  note?: string;
}

interface RowBase {
  id: string;
  section: Section;
  label: string;
  scope(): ScopeTag | undefined;
  /** The environment variable pinning this value; edits are refused while it is set. */
  envVar?(): string | undefined;
  hint?(): string | undefined;
  helpers?(): HelperLine[];
}

export interface ChoiceRow extends RowBase {
  kind: "choice";
  options: readonly string[];
  get(): string;
  set(value: string): void;
}

export type Parsed = { value: string | undefined } | { error: string };

export interface TextRow extends RowBase {
  kind: "text";
  display(): string;
  /** Prefill for the inline editor. */
  get(): string;
  /** `value: undefined` resets the key to its default. */
  parse(input: string): Parsed;
  set(value: string | undefined): void;
}

export interface NumberRow extends RowBase {
  kind: "number";
  min: number;
  max: number;
  step: number;
  get(): number;
  set(value: number): void;
}

export interface ChecksRow extends RowBase {
  kind: "checks";
  boxes: readonly { key: string; label: string }[];
  /** Checked keys. */
  get(): readonly string[];
  set(keys: string[]): void;
}

export interface ToggleRow extends RowBase {
  kind: "toggle";
  get(): boolean;
  set(value: boolean): void;
}

export interface ActionRow extends RowBase {
  kind: "action";
  display(): string;
  action(): ConfigAction;
}

export type Row = ChoiceRow | TextRow | NumberRow | ChecksRow | ToggleRow | ActionRow;

export interface ConfigModelOptions {
  path: string;
  cwd: string;
  env?: Env;
  branch?: string;
  instanceId?: string;
  /** The runtime's sign-in expired, so the account row offers sign-in instead of sign-out. */
  expired?: boolean;
}

const firstSet = (env: Env, names: string[]): string | undefined => names.find((name) => env[name]);

/** Reads the shared config file and writes each change back immediately. */
export class ConfigModel {
  readonly path: string;
  readonly cwd: string;
  readonly env: Env;
  readonly instanceId: string | undefined;
  readonly expired: boolean;
  branch: string | undefined;
  file: JsonObject = {};
  settings: PiSettings;
  credential: Credential | null = null;

  /** Throws `ConfigParseError` when the file does not parse. */
  constructor(opts: ConfigModelOptions) {
    this.path = opts.path;
    this.cwd = opts.cwd;
    this.env = opts.env ?? process.env;
    this.branch = opts.branch;
    this.instanceId = opts.instanceId;
    this.expired = opts.expired ?? false;
    this.settings = resolveSettings({}, this.env);
    this.reload();
  }

  reload(): void {
    this.file = readConfigStrict(this.path);
    this.settings = resolveSettings(this.file, this.env);
    this.credential = resolveCredential(this.file, this.settings.baseUrl, this.env);
  }

  /** Read-modify-write against the file on disk, so unknown keys and other hosts survive. */
  write(mutate: (config: JsonObject) => void): void {
    updateConfig(mutate, this.path);
    this.reload();
  }

  /** Sets `hosts.pi.<path>`; `undefined` deletes it. */
  setPi(path: string[], value: Json | undefined): void {
    this.write((config) =>
      setPath(value === undefined ? hostBlock(config) : ensureHostBlock(config), path, value),
    );
  }

  envVar(
    field:
      | "enabled"
      | "baseUrl"
      | "workspace"
      | "peerName"
      | "aiPeer"
      | "sessionStrategy"
      | "apiKey",
  ): string | undefined {
    const { env } = this;
    switch (field) {
      case "enabled":
        return env.HONCHO_ENABLED === "false" ? "HONCHO_ENABLED=false" : undefined;
      case "baseUrl":
        return firstSet(env, ["HONCHO_BASE_URL", "HONCHO_URL", "HONCHO_ENDPOINT"]);
      case "workspace":
        return firstSet(env, ["HONCHO_WORKSPACE", "HONCHO_WORKSPACE_ID"]);
      case "peerName":
        return firstSet(env, ["HONCHO_PEER_NAME"]);
      case "aiPeer":
        return firstSet(env, ["HONCHO_AI_PEER"]);
      case "sessionStrategy":
        return firstSet(env, ["HONCHO_SESSION_STRATEGY"]);
      case "apiKey":
        return firstSet(env, ["HONCHO_API_KEY"]);
    }
  }

  /** The session this folder maps to under the current strategy. */
  sessionName(): string {
    return deriveSessionName({
      strategy: this.settings.sessionStrategy,
      cwd: this.cwd,
      peerName: this.settings.peerName,
      sessions: sessionsMap(this.file),
      branch: this.branch,
      instanceId: this.instanceId,
    });
  }
}

export const accountMethod = (credential: Credential): AccountMethod =>
  credential.source === "oauth" ? "oauth" : credential.source === "env" ? "env key" : "api key";

export const credentialScope = (credential: Credential): ScopeTag =>
  credential.source === "env" ? "env" : credential.source === "pi-key" ? "pi only" : "shared";

export const envNotice = (row: Row, variable: string): string =>
  `set by ${variable}; unset it to ${row.id === "account" ? "sign out" : "edit here"}`;

export const parseId = (input: string, opts: { allowEmpty: boolean }): Parsed => {
  const value = input.trim();
  if (!value) {
    return opts.allowEmpty ? { value: undefined } : { error: "can't be empty" };
  }
  return ID_PATTERN.test(value) ? { value } : { error: ID_ERROR };
};

export const parseBaseUrl = (input: string): Parsed => {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) {
    return { error: URL_ERROR };
  }
  // NormalizeBaseUrl would turn "ftp://x" into "https://ftp://x"
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) {
    return { error: URL_ERROR };
  }
  const url = normalizeBaseUrl(raw);
  try {
    const parsed = new URL(url);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
      return { error: URL_ERROR };
    }
  } catch {
    return { error: URL_ERROR };
  }
  return { value: url };
};

/**
 * Writes the endpoint where every harness reads it: `environmentUrl` for the honcho CLI, plus
 * `endpoint.baseUrl` for v0 readers or `baseUrl` once the file is v1. pi's own overrides go so
 * the shared value applies.
 */
export const writeEndpoint = (config: JsonObject, url: string): void => {
  config.environmentUrl = url;
  const v1 = typeof config.schemaVersion === "number" && config.schemaVersion >= 1;
  if (v1) {
    config.baseUrl = url;
  } else {
    config.endpoint = { baseUrl: url };
    // A stray root baseUrl would shadow environmentUrl in harness core's migration
    if (typeof config.baseUrl === "string") {
      config.baseUrl = url;
    }
  }
  const pi = hostBlock(config);
  delete pi.endpoint;
  delete pi.baseUrl;
  delete pi.environmentUrl;
};

/** Saving the default text or nothing removes the key, so future default changes apply. */
export const saveTemplate = (model: ConfigModel, text: string): void => {
  const value = text.trim();
  const isDefault = !value || value === DEFAULT_DIALECTIC_TEMPLATE.trim();
  model.setPi(["injection", "dialecticTemplate"], isDefault ? undefined : value);
};

/** Snaps to the next multiple of `step` in the given direction, clamped to the range. */
export const stepValue = (
  value: number,
  dir: 1 | -1,
  step: number,
  min: number,
  max: number,
): number => {
  const next =
    dir > 0 ? Math.floor(value / step) * step + step : Math.ceil(value / step) * step - step;
  return Math.min(max, Math.max(min, next));
};

export const cycleChoice = (row: ChoiceRow, dir: 1 | -1): void => {
  const count = row.options.length;
  const index = row.options.indexOf(row.get());
  const next = row.options[(((index + dir) % count) + count) % count];
  if (next !== undefined && next !== row.get()) {
    row.set(next);
  }
};

export const stepNumber = (row: NumberRow, dir: 1 | -1): void => {
  const next = stepValue(row.get(), dir, row.step, row.min, row.max);
  if (next !== row.get()) {
    row.set(next);
  }
};

export const toggleBox = (row: ChecksRow, key: string): void => {
  const on = new Set(row.get());
  if (on.has(key)) {
    on.delete(key);
  } else {
    on.add(key);
  }
  row.set(row.boxes.map((box) => box.key).filter((k) => on.has(k)));
};

const piOnly = (): ScopeTag => "pi only";

/** Every row of the overlay in display order; values are read live from the model. */
export const buildRows = (model: ConfigModel): Row[] => {
  const s = () => model.settings;
  const injection = () => model.settings.injection;
  const sessionStart = (): string[] => {
    const parts = injection().sessionStart;
    return [parts.summary && "summary", parts.peerCard && "peerCard"].filter((k): k is string =>
      Boolean(k),
    );
  };
  const showInChat = (): string[] => {
    const { showSessionStart, showPerTurn } = injection();
    return [showSessionStart && "sessionStart", showPerTurn && "perTurn"].filter((k): k is string =>
      Boolean(k),
    );
  };

  return [
    {
      id: "enabled",
      section: "Connection",
      label: "honcho",
      kind: "choice",
      options: ["on", "off"],
      get: () => (s().enabled ? "on" : "off"),
      set: (value) => model.setPi(["enabled"], value === "on"),
      hint: () => (s().enabled ? undefined : "nothing is injected or saved"),
      scope: () => scopeTag(s().sources.enabled, false),
      envVar: () => model.envVar("enabled"),
    },
    {
      id: "account",
      section: "Connection",
      label: "account",
      kind: "action",
      display: () =>
        model.credential ? `${s().peerName} · ${accountMethod(model.credential)}` : "not signed in",
      hint: () => {
        const { credential } = model;
        if (!credential) {
          return "enter to sign in";
        }
        if (credential.source === "env") {
          return "from HONCHO_API_KEY";
        }
        if (credential.source === "shared-key") {
          return "shared key · enter to add a pi-only key";
        }
        return model.expired && credential.source === "oauth"
          ? "expired, enter to sign in"
          : "enter to sign out";
      },
      // A pi key or OAuth grant outranks the shared apiKey, which logout won't remove
      action: () =>
        !model.credential ||
        model.credential.source === "shared-key" ||
        (model.expired && model.credential.source === "oauth")
          ? "login"
          : "logout",
      scope: () => (model.credential ? credentialScope(model.credential) : undefined),
      envVar: () => (model.credential?.source === "env" ? model.envVar("apiKey") : undefined),
    },
    {
      id: "endpoint",
      section: "Connection",
      label: "endpoint",
      kind: "text",
      display: () => endpointLabel(s().baseUrl),
      get: () => s().baseUrl,
      parse: parseBaseUrl,
      set: (url) => {
        if (url) {
          model.write((config) => writeEndpoint(config, url));
        }
      },
      scope: () => scopeTag(s().sources.baseUrl, true),
      envVar: () => model.envVar("baseUrl"),
    },
    {
      id: "workspace",
      section: "Connection",
      label: "workspace",
      kind: "text",
      display: () => s().workspace,
      get: () => s().workspace,
      parse: (input) => parseId(input, { allowEmpty: true }),
      set: (value) => model.setPi(["workspace"], value),
      scope: () => scopeTag(s().sources.workspace, false),
      envVar: () => model.envVar("workspace"),
    },
    {
      id: "peerName",
      section: "Connection",
      label: "your peer",
      kind: "text",
      display: () => s().peerName,
      get: () => s().peerName,
      parse: (input) => parseId(input, { allowEmpty: false }),
      set: (value) =>
        model.write((config) => {
          if (value) {
            config.peerName = value;
          }
          // A pi-only peer name would shadow the shared one
          delete hostBlock(config).peerName;
        }),
      scope: () => scopeTag(s().sources.peerName, true),
      envVar: () => model.envVar("peerName"),
    },
    {
      id: "aiPeer",
      section: "Connection",
      label: "agent peer",
      kind: "text",
      display: () => s().aiPeer,
      get: () => s().aiPeer,
      parse: (input) => parseId(input, { allowEmpty: true }),
      set: (value) => model.setPi(["aiPeer"], value),
      scope: () => scopeTag(s().sources.aiPeer, false),
      envVar: () => model.envVar("aiPeer"),
    },
    {
      id: "sessionStrategy",
      section: "Sessions",
      label: "mapping",
      kind: "choice",
      options: SESSION_STRATEGIES,
      get: () => s().sessionStrategy,
      set: (value: SessionStrategy) => model.setPi(["sessionStrategy"], value),
      helpers: () => [
        { text: SESSION_STRATEGIES.join(" · ") },
        {
          text: "this folder uses session ",
          value: model.sessionName(),
          note:
            s().sessionStrategy === "git-branch" && !model.branch
              ? "  (no git branch here)"
              : undefined,
        },
      ],
      scope: () => (model.envVar("sessionStrategy") ? "env" : "pi only"),
      envVar: () => model.envVar("sessionStrategy"),
    },
    {
      id: "sessionStart",
      section: "Injection",
      label: "session start",
      kind: "checks",
      boxes: [
        { key: "summary", label: "summary" },
        { key: "peerCard", label: "peer card" },
      ],
      get: sessionStart,
      set: (keys) => model.setPi(["injection", "sessionStart"], keys),
      scope: piOnly,
    },
    {
      id: "perTurn",
      section: "Injection",
      label: "each turn",
      kind: "choice",
      options: PER_TURN_MODES,
      get: () => injection().perTurn,
      set: (value: PerTurnMode) => model.setPi(["injection", "perTurn"], perTurnToFile(value)),
      hint: () => PER_TURN_MODES.join(" · "),
      scope: piOnly,
    },
    {
      id: "reasoning",
      section: "Injection",
      label: "reasoning",
      kind: "choice",
      options: REASONING_LEVELS,
      get: () => injection().reasoning,
      set: (value: ReasoningLevel) => model.setPi(["injection", "dialecticReasoning"], value),
      hint: () => "for chat",
      scope: piOnly,
    },
    {
      id: "template",
      section: "Injection",
      label: "chat prompt",
      kind: "action",
      display: () =>
        injection().template === DEFAULT_DIALECTIC_TEMPLATE
          ? "default template"
          : "custom template",
      hint: () => "enter to edit",
      action: () => "template",
      scope: piOnly,
    },
    {
      id: "maxConclusions",
      section: "Injection",
      label: "max conclusions",
      kind: "number",
      min: 1,
      max: 100,
      step: 5,
      get: () => injection().maxConclusions,
      set: (value) => model.setPi(["injection", "maxConclusions"], value),
      hint: () => "for context",
      scope: piOnly,
    },
    {
      id: "showInChat",
      section: "Injection",
      label: "show in chat",
      kind: "checks",
      boxes: [
        { key: "sessionStart", label: "session start" },
        { key: "perTurn", label: "each turn" },
      ],
      get: showInChat,
      set: (keys) => model.setPi(["injection", "showInChat"], keys),
      scope: piOnly,
    },
    {
      id: "honcho_chat",
      section: "Tools",
      label: "honcho_chat",
      kind: "toggle",
      get: () => s().tools.chat,
      set: (value) => model.setPi(["tools", "honcho_chat"], value),
      scope: piOnly,
    },
    {
      id: "honcho_search",
      section: "Tools",
      label: "honcho_search",
      kind: "toggle",
      get: () => s().tools.search,
      set: (value) => model.setPi(["tools", "honcho_search"], value),
      scope: piOnly,
    },
  ];
};
