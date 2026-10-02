import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { UploadQueue, extractMessages, toInputs, uploadBatches } from "./capture.js";
import { registerCommands } from "./commands.js";
import { errorMessage, withTimeout } from "./honcho.js";
import {
  SECTION_NAME,
  TURN_MESSAGE_TYPE,
  formatSection,
  recallForTurn,
  shouldSkipPrompt,
} from "./memory.js";
import { HonchoRuntime } from "./runtime.js";
import { TURN_BUDGET_MS } from "./settings.js";
import { registerTools } from "./tools.js";
import { PendingTurn } from "./ui/pending.js";
import { registerRenderers } from "./ui/renderers.js";

const recallLabel = (mode: "chat" | "context"): string =>
  mode === "chat" ? "checking memory" : "loading context";

export default function honcho(pi: ExtensionAPI): void {
  const runtime = new HonchoRuntime(pi);
  const uploads = new UploadQueue((error) => {
    runtime.lastError = `saving messages failed: ${errorMessage(error)}`;
  });
  const pending = new PendingTurn();

  registerRenderers(pi);
  registerTools(pi, runtime);
  registerCommands(pi, runtime);

  // The text as typed, before pi expands skills and prompt templates
  let typed: { text: string; source: string } | undefined;
  // This run's prompt as pi expanded it, paired with what the user typed
  let turn: { expanded: string; typed: string; fromExtension: boolean } | undefined;
  // Steers and follow-ups other extensions sent while a run was streaming
  let extensionTexts: string[] = [];

  pi.on("input", (event) => {
    pending.clear();
    if (!event.streamingBehavior) {
      typed = { text: event.text, source: event.source };
    } else if (event.source === "extension") {
      extensionTexts.push(event.text.trim());
    }
  });

  pi.on("session_start", (_event, ctx) => {
    runtime.start(ctx);
  });

  pi.on("model_select", (event) => {
    runtime.setModel(event.model.id);
  });

  pi.on("before_agent_start", async (event) => {
    const raw = typed;
    typed = undefined;
    turn = {
      expanded: event.prompt,
      typed: raw?.text ?? event.prompt,
      fromExtension: raw?.source === "extension",
    };
    if (runtime.phase === "off" || runtime.phase === "signed-out" || runtime.phase === "error") {
      return;
    }
    const { perTurn } = runtime.settings.injection;
    const query = turn.typed;
    const skip = perTurn === "off" || turn.fromExtension || shouldSkipPrompt(query);
    const recall = skip ? undefined : recallLabel(perTurn);
    pending.show(runtime.ctx, event.prompt, recall ?? "loading memory");
    try {
      return await prepareTurn(event, query, recall);
    } finally {
      pending.settle();
    }
  });

  /** Injects the session-start section and, when `recall` names a label, per-turn memory. */
  const prepareTurn = async (
    event: BeforeAgentStartEvent,
    query: string,
    recall: string | undefined,
  ): Promise<BeforeAgentStartEventResult | undefined> => {
    const deadline = Date.now() + TURN_BUDGET_MS;
    const remaining = () => Math.max(0, deadline - Date.now());

    const connection = await runtime.ready(remaining());
    if (!connection) {
      return;
    }
    const startup = await runtime.startupReady(Math.min(remaining(), 10_000));
    if (startup && (startup.peerCard.length || startup.summary)) {
      // Rebuilt each turn so the tool hints follow /honcho config
      event.systemPromptOptions.sections[SECTION_NAME] = formatSection(startup, {
        peer: runtime.settings.peerName,
        session: connection.sessionName,
        tools: runtime.settings.tools,
      });
    }

    if (!recall) {
      return;
    }
    try {
      const result = await runtime.footer.working(recall, () =>
        withTimeout(
          runtime.call(
            (c) =>
              recallForTurn(
                { userPeer: c.userPeer, dialecticPeer: c.dialecticPeer },
                runtime.settings,
                query,
              ),
            {
              quiet: true,
            },
          ),
          remaining(),
        ),
      );
      if (!result) {
        return;
      }
      return {
        message: {
          customType: TURN_MESSAGE_TYPE,
          content: result.content,
          display: runtime.settings.injection.showPerTurn,
          details: result.details,
        },
      };
    } catch (error) {
      const timedOut = (error as Error)?.name === "TurnTimeoutError";
      runtime.safe(() =>
        runtime.ctx?.ui.notify(
          timedOut
            ? `honcho: memory check timed out after ${TURN_BUDGET_MS / 1000}s; continuing without it`
            : `honcho: memory check failed (${errorMessage(error)}); continuing without it`,
          "warning",
        ),
      );
      return undefined;
    }
  };

  pi.on("message_start", (event) => {
    if (event.message.role === "user") {
      pending.clear();
    }
  });

  pi.on("agent_end", (event) => {
    pending.clear();
    const prompt = turn ? { ...turn, extensionTexts } : undefined;
    turn = undefined;
    extensionTexts = [];
    const { phase, settings } = runtime;
    if (
      !settings.enabled ||
      !settings.saveMessages ||
      phase === "off" ||
      phase === "signed-out" ||
      phase === "error"
    ) {
      return;
    }
    const messages = extractMessages(event.messages, prompt);
    if (!messages.length) {
      return;
    }
    const meta = { source: "pi", pi_session: runtime.ctx?.sessionManager.getSessionId() ?? "" };
    uploads.enqueue(() =>
      runtime.call(async (c) => {
        await uploadBatches(c.session, toInputs(c, messages, meta));
      }),
    );
  });

  pi.on("session_before_compact", async () => {
    await uploads.flush();
  });

  pi.on("session_shutdown", async () => {
    pending.clear();
    await uploads.flush();
    runtime.dispose();
  });
}
