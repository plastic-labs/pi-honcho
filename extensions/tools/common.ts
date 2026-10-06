import type { HonchoRuntime } from "../runtime.js";

/** How long a tool call waits for an in-flight connect before giving up. */
export const READY_MS = 5_000;

export type ToolRuntime = Pick<
  HonchoRuntime,
  "active" | "ready" | "describeUnavailable" | "call" | "settings"
>;

/** Waits briefly for the connection; throws the user-facing reason when Honcho can't serve the call. */
export const ensureActive = async (runtime: ToolRuntime): Promise<void> => {
  await runtime.ready(READY_MS);
  if (!runtime.active) {
    throw new Error(runtime.describeUnavailable());
  }
};
