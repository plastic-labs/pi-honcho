import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  CreateAgentSessionOptions,
  ExtensionFactory,
  ExtensionUIContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { plainTheme } from "../helpers/theme.js";

type Model = NonNullable<CreateAgentSessionOptions["model"]>;
type Provider = Parameters<ModelRuntime["registerNativeProvider"]>[0];

/** The slice of pi-ai's message shapes these tests read. */
export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "toolResult";
  content: string | { type: string; text?: string; name?: string; arguments?: unknown }[];
  sections?: Record<string, string | null>;
  toolsAdded?: { name: string }[];
  toolsRemoved?: { name: string }[];
  toolName?: string;
  isError?: boolean;
}

export interface ProviderRequest {
  messages: ProviderMessage[];
}

type Block =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
interface AssistantMessage {
  role: "assistant";
  content: Block[];
}
type ResponseStep = AssistantMessage | ((context: ProviderRequest) => AssistantMessage);

interface FauxHandle {
  provider: Provider;
  getModel(): Model;
  setResponses(responses: ResponseStep[]): void;
}

interface FauxModule {
  fauxProvider: (options?: { provider?: string }) => FauxHandle;
  fauxAssistantMessage: (
    content: string | Block | Block[],
    options?: { stopReason?: "stop" | "toolUse" },
  ) => AssistantMessage;
  fauxText: (text: string) => Block;
  fauxToolCall: (name: string, args: Record<string, unknown>, options?: { id?: string }) => Block;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let fauxModule: Promise<FauxModule> | undefined;

/**
 * Pi-ai is not a direct dependency, so load the faux provider from the copy
 * pi-coding-agent itself resolves (its pnpm sibling).
 */
export const loadFaux = (): Promise<FauxModule> => {
  fauxModule ??= (async () => {
    const piPackage = realpathSync(join(ROOT, "node_modules/@earendil-works/pi-coding-agent"));
    const piAi = realpathSync(join(dirname(piPackage), "pi-ai"));
    return (await import(pathToFileURL(join(piAi, "dist/providers/faux.js")).href)) as FauxModule;
  })();
  return fauxModule;
};

/** Text of every block, with system sections rendered after the base prompt. */
export const messageText = (message: ProviderMessage): string => {
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
          .join("\n");
  const sections = Object.values(message.sections ?? {}).filter(
    (s): s is string => typeof s === "string",
  );
  return [content, ...sections].filter(Boolean).join("\n");
};

/** Current system sections, with later system messages replacing earlier ones by name. */
export const systemSections = (request: ProviderRequest): Record<string, string> => {
  const out: Record<string, string | null> = {};
  for (const message of request.messages) {
    if (message.role === "system") {
      Object.assign(out, message.sections ?? {});
    }
  }
  return Object.fromEntries(
    Object.entries(out).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
};

/** Tool names declared to the model by the time of this request. */
export const declaredTools = (request: ProviderRequest): string[] => {
  const tools = new Set<string>();
  for (const message of request.messages) {
    if (message.role !== "system") {
      continue;
    }
    for (const tool of message.toolsAdded ?? []) {
      tools.add(tool.name);
    }
    for (const tool of message.toolsRemoved ?? []) {
      tools.delete(tool.name);
    }
  }
  return [...tools];
};

export interface Notification {
  message: string;
  type: "info" | "warning" | "error" | undefined;
}

/** A headless ExtensionUIContext that records what the extension shows. */
export const recordingUi = () => {
  const notifications: Notification[] = [];
  const statuses = new Map<string, string | undefined>();
  const statusLog: string[] = [];
  const widgets = new Set<string>();
  const ui: ExtensionUIContext = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (message, type) => {
      notifications.push({ message, type });
    },
    onTerminalInput: () => () => {},
    setStatus: (key, text) => {
      statuses.set(key, text);
      if (text !== undefined) {
        statusLog.push(`${key}: ${text}`);
      }
    },
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: (key: string, content: unknown) => {
      if (content === undefined) widgets.delete(key);
      else widgets.add(key);
    },
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined as never,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: plainTheme(),
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "headless" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
  return { ui, notifications, statuses, statusLog, widgets };
};

export interface PiHarness {
  session: AgentSession;
  faux: FauxModule;
  /** Every request the model received, in order. */
  requests: ProviderRequest[];
  notifications: Notification[];
  /** Latest footer text per status key. */
  statuses: Map<string, string | undefined>;
  /** Every footer update, as `key: text`. */
  statusLog: string[];
  /** Keys of the widgets currently shown; factories are never called headless. */
  widgets: Set<string>;
  /** Queues model replies; each reply records the request it answers. */
  script(...steps: (string | Block[] | ((request: ProviderRequest) => string | Block[]))[]): void;
  entries(): SessionEntry[];
  /** Emits session_shutdown (flushing uploads) and disposes the session. */
  shutdown(): Promise<void>;
}

export interface HarnessOptions {
  /** Project directory; the extension maps it to a Honcho session. */
  cwd: string;
  /** Agent dir for pi's auth/models/settings; never the real ~/.pi. */
  agentDir: string;
  extension: ExtensionFactory;
}

/** A real pi 1.0 AgentSession with the extension loaded inline and a faux model behind it. */
export const startPi = async (opts: HarnessOptions): Promise<PiHarness> => {
  mkdirSync(opts.cwd, { recursive: true });
  mkdirSync(opts.agentDir, { recursive: true });
  const faux = await loadFaux();
  const handle = faux.fauxProvider({ provider: "faux" });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(opts.agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(handle.provider);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    settingsManager,
    extensionFactories: [{ name: "honcho", factory: opts.extension }],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "You are a test assistant.",
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    modelRuntime,
    model: handle.getModel(),
    thinkingLevel: "off",
    noTools: "builtin",
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(opts.cwd),
  });

  const { ui, notifications, statuses, statusLog, widgets } = recordingUi();
  await session.bindExtensions({ uiContext: ui, mode: "tui" });

  const requests: ProviderRequest[] = [];
  let closed = false;
  const toMessage = (value: string | Block[]) =>
    faux.fauxAssistantMessage(value, {
      stopReason:
        Array.isArray(value) && value.some((b) => b.type === "toolCall") ? "toolUse" : "stop",
    });

  return {
    session,
    faux,
    requests,
    notifications,
    statuses,
    statusLog,
    widgets,
    script(...steps) {
      handle.setResponses(
        steps.map((step) => (context: ProviderRequest) => {
          const request = { messages: structuredClone(context.messages) };
          requests.push(request);
          return toMessage(typeof step === "function" ? step(request) : step);
        }),
      );
    },
    entries: () => session.sessionManager.getEntries(),
    async shutdown() {
      if (closed) {
        return;
      }
      closed = true;
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    },
  };
};
