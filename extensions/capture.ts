import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import type { Peer, Session } from "@honcho-ai/sdk";

export const MAX_CHUNK = 24_000;
const MAX_BATCH = 100;
const TRIVIAL_REPLY =
  /^(yes|no|ok|okay|sure|thanks|y|n|yep|nope|yeah|nah|continue|go ahead|do it|proceed)[.!]*$/i;

export interface CapturedMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
}

interface ContentBlock {
  type?: string;
  text?: string;
}

const textOf = (content: unknown, opts: { images: boolean }): string => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (opts.images && block?.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
};

/** The run's prompt as pi expanded it, and what the user actually typed. */
export interface TypedPrompt {
  expanded: string;
  typed: string;
  fromExtension: boolean;
  /** Steers and follow-ups other extensions sent during the run. */
  extensionTexts?: readonly string[];
}

/** `/skill:name args` for an expanded skill block, so skill bodies aren't saved as the user's words. */
export const collapseSkillBlock = (text: string): string => {
  const skill = parseSkillBlock(text);
  if (!skill) {
    return text;
  }
  return skill.userMessage ? `/skill:${skill.name} ${skill.userMessage}` : `/skill:${skill.name}`;
};

/**
 * User and assistant text from one agent run; tool calls, thinking and pi's own injections are
 * dropped. The run's prompt is saved as typed, and not at all when another extension sent it.
 */
export const extractMessages = (
  messages: readonly unknown[],
  prompt?: TypedPrompt,
): CapturedMessage[] => {
  const out: CapturedMessage[] = [];
  let promptSeen = false;
  for (const raw of messages) {
    const message = raw as {
      role?: string;
      content?: unknown;
      timestamp?: number;
      stopReason?: string;
    };
    if (message.role === "user") {
      let text = textOf(message.content, { images: true }).trim();
      if (prompt && !promptSeen) {
        // A run starts with its prompt; later user messages are steers and follow-ups
        promptSeen = true;
        if (prompt.fromExtension) {
          continue;
        }
        if (prompt.typed.trim() !== prompt.expanded.trim()) {
          text = text.replace(prompt.expanded.trim(), () => prompt.typed.trim());
        }
      } else if (prompt?.extensionTexts?.includes(text)) {
        continue;
      }
      text = collapseSkillBlock(text);
      if (text) {
        out.push({ role: "user", text, timestamp: message.timestamp });
      }
    } else if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        continue;
      }
      const text = textOf(message.content, { images: false }).trim();
      if (text) {
        out.push({ role: "assistant", text, timestamp: message.timestamp });
      }
    }
  }
  return out;
};

/** Splits at a newline, else a space, else hard; each part stays under the server's 25k limit. */
export const chunkText = (text: string, max = MAX_CHUNK): string[] => {
  if (text.length <= max) {
    return [text];
  }
  const budget = max - 16;
  const parts: string[] = [];
  let rest = text;
  while (rest.length > budget) {
    let cut = rest.lastIndexOf("\n", budget);
    if (cut < budget / 2) {
      cut = rest.lastIndexOf(" ", budget);
    }
    if (cut < budget / 2) {
      cut = budget;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) {
    parts.push(rest);
  }
  return parts.map((part, i) => `[Part ${i + 1}/${parts.length}] ${part}`);
};

export interface UploadTarget {
  session: Session;
  userPeer: Peer;
  aiPeer: Peer;
}

export const toInputs = (
  target: UploadTarget,
  messages: CapturedMessage[],
  meta: Record<string, string>,
) =>
  messages.flatMap((message) => {
    const peer = message.role === "user" ? target.userPeer : target.aiPeer;
    const trivial = message.role === "user" && TRIVIAL_REPLY.test(message.text);
    return chunkText(message.text).map((chunk) =>
      peer.message(chunk, {
        metadata: meta,
        createdAt: message.timestamp ? new Date(message.timestamp) : undefined,
        // One-word replies carry nothing for the deriver to reason about
        configuration: trivial ? { reasoning: { enabled: false } } : undefined,
      }),
    );
  });

/** Serializes uploads so batches land in order; failures are reported, never thrown. */
export class UploadQueue {
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly onError: (error: unknown) => void) {}

  get busy(): boolean {
    return this.pending > 0;
  }

  enqueue(task: () => Promise<void>): void {
    this.pending += 1;
    this.chain = this.chain
      .then(task)
      .catch((error: unknown) => this.onError(error))
      .finally(() => {
        this.pending -= 1;
      });
  }

  /** Resolves once queued uploads finish, or after `ms`. */
  async flush(ms = 5_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.chain,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export const uploadBatches = async (
  session: Session,
  inputs: ReturnType<typeof toInputs>,
): Promise<void> => {
  for (let i = 0; i < inputs.length; i += MAX_BATCH) {
    await session.addMessages(inputs.slice(i, i + MAX_BATCH));
  }
};
