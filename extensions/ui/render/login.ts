import type { Theme } from "@earendil-works/pi-coding-agent";
import { strategyLabel } from "../../session-name.js";
import type { LoginEntryData } from "../entries.js";
import { field, fit, styled, units } from "./layout.js";
import type { RenderOptions } from "./layout.js";

const LABEL_WIDTH = 12;

/** The `honcho-login` entry shown after a successful sign-in. */
export const formatLoginEntry = (
  data: LoginEntryData,
  width: number,
  theme: Theme,
  opts: RenderOptions = {},
): string[] => {
  const pad = " ".repeat(opts.pad ?? 1);
  const edge = width - pad.length;
  const dim = (text: string) => theme.fg("dim", text);
  const row = (name: string, value: readonly string[]) =>
    field(`${pad}  ${dim(name.padEnd(LABEL_WIDTH))}`, value, edge);
  const lines = [
    fit(`${pad}${theme.fg("success", "✓")} Signed in to Honcho as ${theme.bold(data.user)}`, edge),
    ...row("endpoint", styled(data.endpoint)),
    ...row("workspace", styled(data.workspace)),
    ...row("peers", units([`${data.peer} (you)`, `${data.aiPeer} (agent)`])),
    ...row("session", [
      ...styled(data.session),
      ...styled(`· ${strategyLabel(data.strategy)}`, dim),
    ]),
    ...row("saved to", [
      ...styled(data.savedTo),
      ...(data.sharedWith ? styled(`· ${data.sharedWith}`, dim) : []),
    ]),
  ];
  if (data.note) {
    lines.push(...field(`${pad}  `, styled(data.note, dim), edge));
  }
  lines.push("", fit(`${pad}${dim("Change any of this with /honcho config.")}`, edge));
  return lines;
};
