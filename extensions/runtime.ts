import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Session } from "@honcho-ai/sdk";
import { AuthenticationError, Peer, ServerError, TimeoutError } from "@honcho-ai/sdk";
import { CredentialStore, SignInExpiredError } from "./auth/credentials.js";
import type { Credential } from "./auth/credentials.js";
import { ConfigParseError, displayPath, getConfigPath, readConfigStrict } from "./config-file.js";
import type { JsonObject } from "./config-file.js";
import {
  classify,
  createClients,
  errorMessage,
  setModel,
  setToken,
  tokenOf,
  withTimeout,
} from "./honcho.js";
import type { Clients } from "./honcho.js";
import { START_ENTRY_TYPE, fetchStartupMemory } from "./memory.js";
import type { StartEntryData, StartupMemory } from "./memory.js";
import { deriveSessionName, sessionsMap } from "./session-name.js";
import { endpointLabel, resolveSettings } from "./settings.js";
import type { PiSettings } from "./settings.js";
import { FooterStatus } from "./ui/status.js";

export const TOOL_NAMES = { chat: "honcho_chat", search: "honcho_search" } as const;
const RECONNECT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;

export interface Connection {
  clients: Clients;
  credential: Credential;
  sessionName: string;
  userPeer: Peer;
  aiPeer: Peer;
  /** The user peer bound to the long-timeout dialectic client. */
  dialecticPeer: Peer;
  session: Session;
}

export type RuntimePhase =
  | "idle"
  | "off"
  | "signed-out"
  | "connecting"
  | "connected"
  | "expired"
  | "unreachable"
  | "error";

/** Per-session state; pi re-runs the extension factory for every session. */
export class HonchoRuntime {
  readonly footer = new FooterStatus();
  readonly store: CredentialStore;
  settings: PiSettings;
  file: JsonObject = {};
  credential: Credential | null = null;
  sessionName: string | undefined;
  connection: Connection | undefined;
  startup: StartupMemory | undefined;
  conclusions: number | undefined;
  phase: RuntimePhase = "idle";
  lastError: string | undefined;
  ctx: ExtensionContext | undefined;
  private connecting: Promise<Connection | undefined> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** Bumped by restart and dispose; work started under an older generation is discarded. */
  private generation = 0;
  /** The token that last failed auth, so a sign-in elsewhere can be noticed. */
  private failedToken: string | undefined;
  private model: string | undefined;
  private branch: string | undefined;

  constructor(readonly pi: ExtensionAPI) {
    this.store = new CredentialStore();
    this.settings = resolveSettings({});
  }

  get configPath(): string {
    return getConfigPath();
  }

  get active(): boolean {
    return this.phase === "connected";
  }

  get host(): string {
    return endpointLabel(this.settings.baseUrl);
  }

  /** Attach to the session and connect in the background; never awaits the network. */
  start(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.model = ctx.model?.id;
    this.footer.attach(ctx);
    void this.restart();
  }

  /** Re-reads config and credentials, then reconnects if signed in and enabled. */
  async restart(): Promise<Connection | undefined> {
    if (this.disposed) {
      return undefined;
    }
    this.generation += 1;
    this.connection = undefined;
    this.startup = undefined;
    this.connecting = undefined;
    this.failedToken = undefined;
    this.clearReconnect();
    if (!this.load()) {
      return undefined;
    }
    return this.connect();
  }

  /** Returns false when there is nothing to connect (off, signed out, unreadable config). */
  load(): boolean {
    try {
      this.file = readConfigStrict(this.store.path);
    } catch (error) {
      this.file = {};
      this.settings = resolveSettings({});
      this.setPhase(
        "error",
        error instanceof ConfigParseError
          ? `${displayPath(error.path)} is not valid JSON`
          : errorMessage(error),
      );
      return false;
    }
    this.settings = resolveSettings(this.file);
    this.credential = this.store.resolve(this.settings.baseUrl);
    this.syncTools();
    if (!this.settings.enabled) {
      this.setPhase("off");
      return false;
    }
    if (!this.credential) {
      this.setPhase("signed-out");
      return false;
    }
    // connect() no-ops while signed out, including after this load found a credential
    if (this.phase === "signed-out") {
      this.setPhase("idle");
    }
    return true;
  }

  /** Picks up settings that need no reconnect (injection, tools); reconnects when connection fields changed. */
  async refreshSettings(): Promise<void> {
    const before = this.settings;
    const credentialBefore = this.credential?.token;
    let file: JsonObject;
    try {
      file = readConfigStrict(this.store.path);
    } catch {
      await this.restart();
      return;
    }
    const next = resolveSettings(file);
    const reconnect =
      next.enabled !== before.enabled ||
      next.baseUrl !== before.baseUrl ||
      next.workspace !== before.workspace ||
      next.peerName !== before.peerName ||
      next.aiPeer !== before.aiPeer ||
      next.sessionStrategy !== before.sessionStrategy ||
      next.injection.sessionStart.summary !== before.injection.sessionStart.summary ||
      next.injection.sessionStart.peerCard !== before.injection.sessionStart.peerCard ||
      this.store.resolve(next.baseUrl)?.token !== credentialBefore;
    if (reconnect) {
      await this.restart();
      return;
    }
    this.file = file;
    this.settings = next;
    this.syncTools();
  }

  /** Connects once; concurrent callers share the attempt. */
  connect(): Promise<Connection | undefined> {
    if (this.connection) {
      return Promise.resolve(this.connection);
    }
    if (!this.settings.enabled || this.phase === "off" || this.phase === "signed-out") {
      return Promise.resolve(undefined);
    }
    if (!this.connecting) {
      const attempt: Promise<Connection | undefined> = this.doConnect(this.generation).finally(
        () => {
          if (this.connecting === attempt) {
            this.connecting = undefined;
          }
        },
      );
      this.connecting = attempt;
    }
    return this.connecting;
  }

  private stale(generation: number): boolean {
    return this.disposed || generation !== this.generation;
  }

  /** Waits for an in-flight connect, bounded by `ms`. */
  async ready(ms: number): Promise<Connection | undefined> {
    if (this.connection) {
      return this.connection;
    }
    if (!this.connecting) {
      // An expired sign-in may have been replaced by another pi or the honcho CLI
      const signedInElsewhere =
        this.phase === "expired" &&
        this.store.resolve(this.settings.baseUrl)?.token !== this.failedToken;
      if (this.phase !== "unreachable" && !signedInElsewhere) {
        return undefined;
      }
      void this.connect();
    }
    try {
      return await withTimeout(this.connecting ?? Promise.resolve(undefined), ms);
    } catch {
      return undefined;
    }
  }

  private async doConnect(generation: number): Promise<Connection | undefined> {
    const { settings } = this;
    this.setPhase("connecting");
    try {
      const credential = await this.store.fresh(settings.baseUrl);
      if (this.stale(generation)) {
        return undefined;
      }
      if (!credential) {
        this.setPhase("signed-out");
        return undefined;
      }
      this.credential = credential;
      const sessionName = await this.resolveSessionName();
      const build = async (token: string, current: Credential): Promise<Connection> => {
        const clients = createClients({
          token,
          baseUrl: settings.baseUrl,
          workspace: settings.workspace,
          timeoutMs: settings.timeoutMs,
          model: this.model,
        });
        const [userPeer, aiPeer] = await Promise.all([
          clients.fast.peer(settings.peerName),
          clients.fast.peer(settings.aiPeer),
        ]);
        const dialecticPeer = new Peer(
          userPeer.id,
          settings.workspace,
          clients.dialectic.http,
          undefined,
          undefined,
          () => Promise.resolve(),
        );
        const session = await clients.fast.session(sessionName, {
          peers: [userPeer, [aiPeer, { observeMe: false }]],
        });
        return {
          clients,
          credential: current,
          sessionName,
          userPeer,
          aiPeer,
          dialecticPeer,
          session,
        };
      };
      const attempt = async (): Promise<Connection> => {
        try {
          return await build(credential.token, credential);
        } catch (error) {
          // The SDK caches a rejected workspace call, so a refreshed token needs fresh clients
          if (!(error instanceof AuthenticationError) || credential.source !== "oauth") {
            throw error;
          }
          const fresh = await this.store.fresh(settings.baseUrl, {
            force: true,
            failedToken: credential.token,
          });
          if (!fresh || fresh.token === credential.token) {
            throw error;
          }
          if (!this.stale(generation)) {
            this.credential = fresh;
          }
          return build(fresh.token, fresh);
        }
      };
      const connection = await withTimeout(attempt(), CONNECT_TIMEOUT_MS);
      if (this.stale(generation)) {
        return undefined;
      }
      this.connection = connection;
      this.credential = connection.credential;
      this.sessionName = sessionName;
      this.lastError = undefined;
      this.failedToken = undefined;
      this.setPhase("connected");
      void this.loadStartup(connection);
      void this.refreshCounts();
      return connection;
    } catch (error) {
      if (this.stale(generation)) {
        return undefined;
      }
      const kind = classify(error);
      // A 500, a rate limit or a busy config lock at startup is worth retrying
      if (
        error instanceof ServerError ||
        kind === "rate-limited" ||
        /config lock/.test(errorMessage(error))
      ) {
        this.lastError = errorMessage(error);
        this.setPhase("unreachable");
        this.scheduleReconnect();
        return undefined;
      }
      this.fail(error);
      return undefined;
    }
  }

  private async resolveSessionName(): Promise<string> {
    const cwd = this.ctx?.cwd ?? process.cwd();
    if (this.settings.sessionStrategy === "git-branch") {
      const result = await this.pi
        .exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 3_000 })
        .catch(() => undefined);
      this.branch = result && result.code === 0 ? result.stdout.trim() || undefined : undefined;
    }
    return deriveSessionName({
      strategy: this.settings.sessionStrategy,
      cwd,
      peerName: this.settings.peerName,
      sessions: sessionsMap(this.file),
      branch: this.branch,
      instanceId: this.ctx?.sessionManager.getSessionId(),
    });
  }

  private async loadStartup(connection: Connection): Promise<void> {
    const { settings } = this;
    const startup = await fetchStartupMemory(connection, settings, connection.sessionName);
    if (this.disposed || this.connection !== connection) {
      return;
    }
    this.startup = startup;
    const { summary, peerCard } = settings.injection.sessionStart;
    if (settings.injection.showSessionStart && (summary || peerCard)) {
      const data: StartEntryData = {
        peer: settings.peerName,
        session: connection.sessionName,
        peerCard: startup.peerCard,
        summary: startup.summary,
        peerCardSelected: peerCard,
        summarySelected: summary,
      };
      this.safe(() => this.pi.appendEntry(START_ENTRY_TYPE, data));
    }
  }

  /** Resolves when startup memory has loaded, bounded by `ms`. */
  async startupReady(ms: number): Promise<StartupMemory | undefined> {
    const deadline = Date.now() + ms;
    while (!this.startup && this.connection && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.startup;
  }

  async refreshCounts(): Promise<void> {
    const { connection } = this;
    if (!connection) {
      return;
    }
    try {
      const page = await connection.userPeer.conclusions.list({ size: 1 });
      this.conclusions = page.total;
    } catch {
      // Peer- or session-scoped keys cannot list conclusions
    }
    if (this.connection === connection && this.phase === "connected") {
      this.setPhase("connected");
    }
  }

  /**
   * Runs a Honcho call with token refresh, one retry after a 401, and footer bookkeeping.
   * `quiet` keeps slow-endpoint failures (5xx, timeouts) from marking Honcho unreachable.
   */
  async call<T>(
    fn: (connection: Connection) => Promise<T>,
    opts: { quiet?: boolean } = {},
  ): Promise<T> {
    const { generation } = this;
    const connection = this.connection ?? (await this.connect());
    if (!connection) {
      throw new Error(this.describeUnavailable());
    }
    let fresh: Credential | null;
    try {
      fresh = await this.store.fresh(this.settings.baseUrl);
    } catch (error) {
      if (!this.stale(generation)) {
        this.fail(error);
      }
      throw error;
    }
    if (!fresh) {
      // Signed out from another terminal; stop using the old credential
      if (!this.stale(generation)) {
        this.connection = undefined;
        this.startup = undefined;
        this.credential = null;
        this.clearReconnect();
        this.setPhase("signed-out");
      }
      throw new Error(this.describeUnavailable());
    }
    if (fresh.token !== tokenOf(connection.clients)) {
      setToken(connection.clients, fresh.token);
      connection.credential = fresh;
      this.credential = fresh;
    }
    try {
      const result = await this.withAuthRetry(connection, () => fn(connection));
      if (!this.stale(generation) && this.connection === connection && this.phase !== "connected") {
        this.setPhase("connected");
      }
      return result;
    } catch (error) {
      const kind = classify(error);
      const slow = error instanceof ServerError || error instanceof TimeoutError;
      if (
        !this.stale(generation) &&
        (kind === "auth" || kind === "expired" || (kind === "unreachable" && !(opts.quiet && slow)))
      ) {
        this.fail(error);
      }
      throw error;
    }
  }

  private async withAuthRetry<T>(connection: Connection, fn: () => Promise<T>): Promise<T> {
    const { clients } = connection;
    const used = tokenOf(clients);
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof AuthenticationError) || connection.credential.source !== "oauth") {
        throw error;
      }
      // A concurrent call already swapped in a newer token
      if (tokenOf(clients) !== used) {
        return fn();
      }
      const fresh = await this.store.fresh(this.settings.baseUrl, {
        force: true,
        failedToken: used,
      });
      if (!fresh || fresh.token === used) {
        throw error;
      }
      setToken(clients, fresh.token);
      connection.credential = fresh;
      this.credential = fresh;
      return fn();
    }
  }

  describeUnavailable(): string {
    switch (this.phase) {
      case "off":
        return "Honcho is off for pi. Run /honcho on to turn it back on.";
      case "signed-out":
        return "Not signed in to Honcho. Run /honcho login.";
      case "expired":
        return "Honcho sign-in expired. Run /honcho login.";
      case "unreachable":
        return `${this.host} is unreachable; Honcho memory is paused.`;
      case "error":
        return this.lastError ?? "Honcho is not configured correctly.";
      default:
        return "Honcho is not connected yet.";
    }
  }

  private fail(error: unknown): void {
    if (this.disposed) {
      return;
    }
    this.lastError = errorMessage(error);
    const kind = error instanceof SignInExpiredError ? "expired" : classify(error);
    if (kind === "expired" || kind === "auth") {
      this.failedToken = this.credential?.token;
    }
    if (kind === "expired") {
      this.setPhase("expired");
    } else if (kind === "auth") {
      this.setPhase(
        this.credential?.source === "oauth" ? "expired" : "error",
        `${this.host} rejected the key: ${this.lastError}`,
      );
    } else if (kind === "unreachable" || (error as Error)?.name === "TurnTimeoutError") {
      this.setPhase("unreachable");
      this.scheduleReconnect();
    } else {
      this.setPhase("error", this.lastError);
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    if (this.disposed) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.phase !== "unreachable" || !this.settings.enabled) {
        return;
      }
      const probe = this.connection ? this.call((c) => c.userPeer.getCard()) : this.connect();
      void probe
        .catch(() => undefined)
        .finally(() => {
          if (this.phase === "unreachable" && !this.reconnectTimer) {
            this.scheduleReconnect();
          }
        });
    }, RECONNECT_MS);
    this.reconnectTimer.unref?.();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = undefined;
  }

  setPhase(phase: RuntimePhase, message?: string): void {
    this.phase = phase;
    if (phase === "error" && message) {
      this.lastError = message;
    }
    switch (phase) {
      case "off":
        this.footer.set({ kind: "off" });
        break;
      case "signed-out":
        this.footer.set({ kind: "signed-out" });
        break;
      case "connecting":
        this.footer.set({ kind: "connecting" });
        break;
      case "connected":
        this.footer.set({
          kind: "connected",
          peer: this.settings.peerName,
          workspace: this.settings.workspace,
          session: this.sessionName ?? "",
          conclusions: this.conclusions,
        });
        break;
      case "expired":
        this.footer.set({ kind: "expired" });
        break;
      case "unreachable":
        this.footer.set({ kind: "unreachable", host: this.host });
        break;
      case "error":
        this.footer.set({ kind: "error", message: this.lastError ?? "configuration error" });
        break;
      case "idle":
        break;
    }
    this.syncTools();
  }

  /** Tools are visible to the model only while they can work. */
  syncTools(): void {
    if (this.disposed) {
      return;
    }
    this.safe(() => {
      const active = new Set(this.pi.getActiveTools());
      const usable =
        this.settings.enabled &&
        this.credential !== null &&
        this.phase !== "off" &&
        this.phase !== "signed-out" &&
        this.phase !== "expired" &&
        this.phase !== "error";
      const want = {
        [TOOL_NAMES.chat]: usable && this.settings.tools.chat,
        [TOOL_NAMES.search]: usable && this.settings.tools.search,
      };
      let changed = false;
      for (const [name, on] of Object.entries(want)) {
        if (on && !active.has(name)) {
          active.add(name);
          changed = true;
        } else if (!on && active.has(name)) {
          active.delete(name);
          changed = true;
        }
      }
      if (changed) {
        this.pi.setActiveTools([...active]);
      }
    });
  }

  setModel(model: string | undefined): void {
    this.model = model;
    if (this.connection) {
      setModel(this.connection.clients, model);
    }
  }

  /** Runs a pi API call that may throw once the session has been replaced. */
  safe(fn: () => void): void {
    if (this.disposed) {
      return;
    }
    try {
      fn();
    } catch {
      // Stale ctx after session replacement
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.clearReconnect();
    this.footer.dispose();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get configFile(): string {
    return getConfigPath();
  }
}
