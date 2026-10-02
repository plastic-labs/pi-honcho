import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { StatusSnapshot } from "../entries.js";
import { formatCount } from "../status.js";
import { count, field, fit, styled, units, wrapWords } from "./layout.js";
import type { RenderOptions } from "./layout.js";

const LABEL_WIDTH = 11;
/** Right edge of the scope column on wide terminals. */
const SCOPE_EDGE = 72;

type State = StatusSnapshot["state"];

const STATES: Record<State, { glyph: string; label: string; color: ThemeColor }> = {
  connected: { glyph: "●", label: "connected", color: "success" },
  connecting: { glyph: "◐", label: "connecting", color: "accent" },
  off: { glyph: "○", label: "off", color: "dim" },
  "signed-out": { glyph: "○", label: "not signed in", color: "dim" },
  expired: { glyph: "▲", label: "sign-in expired", color: "warning" },
  unreachable: { glyph: "▲", label: "unreachable", color: "error" },
  error: { glyph: "▲", label: "error", color: "error" },
};

const renews = (minutes: number): string => {
  if (minutes < 1) {
    return "renews in <1m";
  }
  if (minutes < 60) {
    return `renews in ${minutes}m`;
  }
  const rest = minutes % 60;
  return `renews in ${Math.floor(minutes / 60)}h${rest ? ` ${rest}m` : ""}`;
};

const memoryParts = (memory: NonNullable<StatusSnapshot["memory"]>): string[] => {
  const conclusions =
    memory.conclusions === undefined ? "— conclusions" : count(memory.conclusions, "conclusion");
  const facts = memory.peerCardFacts;
  let card = "peer card —";
  if (facts === 0) {
    card = "no peer card yet";
  } else if (facts !== undefined) {
    card = `peer card ${count(facts, "fact")}`;
  }
  const sessions = memory.sessions === undefined ? "— sessions" : count(memory.sessions, "session");
  return [conclusions, card, sessions];
};

const queueParts = (queue: NonNullable<StatusSnapshot["queue"]>): string[] => {
  const parts: string[] = [];
  if (queue.pending) {
    parts.push(`${formatCount(queue.pending)} pending`);
  }
  if (queue.inProgress) {
    parts.push(`${formatCount(queue.inProgress)} in progress`);
  }
  return parts.length ? parts : ["idle"];
};

const perTurnValue = (injection: StatusSnapshot["injection"]): string => {
  if (injection.perTurn === "chat") {
    return `each turn: chat, ${injection.reasoning} reasoning`;
  }
  if (injection.perTurn === "context") {
    return `each turn: context, ${count(injection.maxConclusions, "conclusion")}`;
  }
  return "each turn: off";
};

/** The `/honcho` status panel. */
export const formatStatusPanel = (
  s: StatusSnapshot,
  width: number,
  theme: Theme,
  opts: RenderOptions = {},
): string[] => {
  const pad = " ".repeat(opts.pad ?? 1);
  const edge = width - pad.length;
  const scopeEdge = Math.min(edge, SCOPE_EDGE);
  const dim = (text: string) => theme.fg("dim", text);
  const label = (name: string) => `${pad}${dim(name.padEnd(LABEL_WIDTH))}`;
  const row = (name: string, value: readonly string[]) => field(label(name), value, edge);
  const scoped = (name: string, value: readonly string[], scope: string) =>
    field(label(name), value, scopeEdge, dim(scope));
  const paragraph = (text: string, color: ThemeColor) =>
    wrapWords(styled(text), edge - pad.length).map((line) => `${pad}${theme.fg(color, line)}`);

  const state = STATES[s.state];
  const stats = [
    s.endpoint,
    ...(s.latencyMs === undefined ? [] : [`${formatCount(s.latencyMs)} ms`]),
  ];
  const lines = [
    fit(
      `${pad}${theme.bold(theme.fg("accent", "Honcho"))}  ${theme.fg(state.color, `${state.glyph} ${state.label}`)}${dim(` · ${stats.join(" · ")}`)}`,
      edge,
    ),
  ];
  if (s.state !== "connected" && s.error) {
    lines.push(...paragraph(s.error, state.color === "accent" ? "dim" : state.color));
  }
  lines.push("");

  const { account } = s;
  if (account) {
    const how = `· ${account.method}${account.renewsInMin === undefined ? "" : `, ${renews(account.renewsInMin)}`}`;
    lines.push(...scoped("account", [...styled(account.name), ...styled(how, dim)], account.scope));
  } else {
    lines.push(...row("account", styled("not signed in", dim)));
  }
  lines.push(
    ...scoped("workspace", styled(s.workspace.value), s.workspace.scope),
    ...scoped("peers", units([`${s.peers.user} (you)`, `${s.peers.ai} (agent)`]), s.peers.scope),
    ...(s.session
      ? scoped("session", styled(s.session.name), s.session.strategy)
      : row("session", [dim("—")])),
    "",
  );

  if (s.state === "connected") {
    lines.push(
      ...row("memory", units(memoryParts(s.memory ?? {}))),
      ...row("queue", s.queue ? units(queueParts(s.queue)) : [dim("unavailable")]),
      "",
    );
  }

  const start = s.injection.sessionStart.length ? s.injection.sessionStart.join(", ") : "off";
  lines.push(
    ...row("injection", styled(`session start: ${start}`)),
    ...row("", styled(perTurnValue(s.injection))),
    ...row("tools", s.tools.length ? units(s.tools) : ["none"]),
    "",
  );

  if (s.warnings.length) {
    for (const warning of s.warnings) {
      lines.push(
        ...field(
          `${pad}${theme.fg("warning", "▲")} `,
          styled(warning, (w) => theme.fg("warning", w)),
          edge,
        ),
      );
    }
    lines.push("");
  }

  const commands = [
    "/honcho login",
    "/honcho logout",
    "/honcho config",
    s.state === "off" ? "/honcho on" : "/honcho off",
  ];
  lines.push(...wrapWords(units(commands, dim), edge - pad.length).map((line) => `${pad}${line}`));
  return lines;
};
