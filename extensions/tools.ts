import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HonchoRuntime } from "./runtime.js";
import { createChatTool } from "./tools/chat.js";
import { createSearchTool } from "./tools/search.js";

/** Registers honcho_chat and honcho_search; runtime.syncTools() turns them on and off with the connection. */
export const registerTools = (pi: ExtensionAPI, runtime: HonchoRuntime): void => {
  pi.registerTool(createChatTool(runtime));
  pi.registerTool(createSearchTool(runtime));
};
