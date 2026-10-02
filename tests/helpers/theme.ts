import type { Theme } from "@earendil-works/pi-coding-agent";

/** Identity theme: renders plain text so assertions can match exact copy. */
export const plainTheme = (): Theme => {
  const id = (s: string) => s;
  const theme = {
    fg: (_color: string, s: string) => s,
    bg: (_color: string, s: string) => s,
    style: (s: string) => s,
    bold: id,
    italic: id,
    underline: id,
    inverse: id,
    strikethrough: id,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
  };
  return theme as unknown as Theme;
};

/** Tags colors as `<color>text</color>` so tests can assert which color a fragment used. */
export const taggedTheme = (): Theme => {
  const id = (s: string) => s;
  const theme = {
    fg: (color: string, s: string) => `<${color}>${s}</${color}>`,
    bg: (color: string, s: string) => `<bg:${color}>${s}</bg:${color}>`,
    style: (s: string) => s,
    bold: (s: string) => `<b>${s}</b>`,
    italic: id,
    underline: id,
    inverse: id,
    strikethrough: id,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
  };
  return theme as unknown as Theme;
};
