import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import { displayPath } from "../../config-file.js";
import { errorMessage } from "../../honcho.js";
import { SECTIONS, cycleChoice, envNotice, stepNumber, toggleBox } from "./model.js";
import type { ConfigAction, ConfigModel, NumberRow, Row, TextRow } from "./model.js";

const LABEL_WIDTH = 17;
const MARKER_WIDTH = 3;
const SCOPE_GAP = 2;
const HINT_GAP = "  ";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Survives closing the overlay for the template editor, so it reopens on the same row. */
export interface ViewState {
  selected: number;
  scroll: number;
  /** Focused box within a checkbox row. */
  box: number;
}

export type OverlayResult = { action: "close" } | { action: ConfigAction };

export interface ConfigOverlayOptions {
  /** Line budget; the overlay scrolls to keep the selected row inside it. */
  maxLines: () => number;
  requestRender: () => void;
  done: (result: OverlayResult) => void;
}

interface BodyLine {
  text: string;
  row?: number;
  selected?: boolean;
}

/** Body lines plus each row's span: first line (its section header when it opens one), own line, last helper line. */
interface Body {
  lines: BodyLine[];
  spans: Map<number, [number, number, number]>;
}

interface Editing {
  row: TextRow | NumberRow;
  input: Input;
  error?: string;
}

const pad = (line: string, width: number) => truncateToWidth(line, Math.max(0, width), "…", true);

/** Left text, then `right` flush with the right edge; the left side gives way first. */
const spread = (left: string, right: string, width: number): string => {
  const rightWidth = visibleWidth(right);
  if (!rightWidth) {
    return pad(left, width);
  }
  const room = width - rightWidth - SCOPE_GAP;
  if (room <= 0) {
    return pad(left, width);
  }
  return `${pad(left, room)}${" ".repeat(SCOPE_GAP)}${right}`;
};

/** The `/honcho config` overlay, drawn by hand to match the settings artboard. */
export class ConfigOverlay implements Component, Focusable {
  private editing: Editing | undefined;
  private notice: { text: string; tone: "dim" | "error" } | undefined;
  private closed = false;
  private hasFocus = false;

  constructor(
    private readonly model: ConfigModel,
    private readonly rows: readonly Row[],
    private readonly theme: Theme,
    private readonly view: ViewState,
    private readonly opts: ConfigOverlayOptions,
  ) {
    view.selected = Math.min(Math.max(0, view.selected), rows.length - 1);
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    if (this.editing) {
      this.editing.input.focused = value;
    }
  }

  get isEditing(): boolean {
    return this.editing !== undefined;
  }

  private get current(): Row | undefined {
    return this.rows[this.view.selected];
  }

  invalidate(): void {
    this.editing?.input.invalidate();
  }

  handleInput(data: string): void {
    if (this.closed) {
      return;
    }
    if (this.editing) {
      this.editing.input.handleInput(data);
      this.opts.requestRender();
      return;
    }
    const kb = getKeybindings();
    const row = this.current;
    this.notice = undefined;
    if (kb.matches(data, "tui.select.up")) {
      this.move(-1);
    } else if (kb.matches(data, "tui.select.down")) {
      this.move(1);
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.close({ action: "close" });
    } else if (row && matchesKey(data, "left")) {
      this.change(row, -1);
    } else if (row && matchesKey(data, "right")) {
      this.change(row, 1);
    } else if (row && kb.matches(data, "tui.select.confirm")) {
      this.activate(row);
    } else if (row && matchesKey(data, "space")) {
      this.flip(row);
    }
    this.opts.requestRender();
  }

  private close(result: OverlayResult): void {
    this.closed = true;
    this.opts.done(result);
  }

  private move(delta: number): void {
    const next = Math.min(this.rows.length - 1, Math.max(0, this.view.selected + delta));
    if (next !== this.view.selected) {
      this.view.box = 0;
    }
    this.view.selected = next;
  }

  /** Runs a write unless an environment variable pins the row; failures show inline. */
  private guarded(row: Row, write: () => void): void {
    const variable = row.envVar?.();
    if (variable) {
      this.notice = { text: envNotice(row, variable), tone: "dim" };
      return;
    }
    try {
      write();
    } catch (error) {
      this.notice = { text: `could not save: ${errorMessage(error)}`, tone: "error" };
    }
  }

  private change(row: Row, dir: 1 | -1): void {
    switch (row.kind) {
      case "choice":
        this.guarded(row, () => cycleChoice(row, dir));
        return;
      case "number":
        this.guarded(row, () => stepNumber(row, dir));
        return;
      case "checks":
        this.view.box = Math.min(row.boxes.length - 1, Math.max(0, this.view.box + dir));
        return;
      case "toggle":
        this.guarded(row, () => row.set(!row.get()));
        return;
      default:
    }
  }

  private activate(row: Row): void {
    switch (row.kind) {
      case "text":
        this.startEdit(row, row.get());
        return;
      case "number":
        this.startEdit(row, String(row.get()));
        return;
      case "action":
        this.guarded(row, () => this.close({ action: row.action() }));
        return;
      default:
        this.flip(row);
    }
  }

  /** Space: toggles boxes and cycles choices forward. */
  private flip(row: Row): void {
    switch (row.kind) {
      case "checks": {
        const box = row.boxes[this.view.box];
        if (box) {
          this.guarded(row, () => toggleBox(row, box.key));
        }
        return;
      }
      case "toggle":
        this.guarded(row, () => row.set(!row.get()));
        return;
      case "choice":
        this.guarded(row, () => cycleChoice(row, 1));
        return;
      default:
    }
  }

  private startEdit(row: TextRow | NumberRow, value: string): void {
    const variable = row.envVar?.();
    if (variable) {
      this.notice = { text: envNotice(row, variable), tone: "dim" };
      return;
    }
    const input = new Input({ prompt: "" });
    // A paste leaves the cursor at the end, whatever the user's keybindings
    input.handleInput(`${PASTE_START}${value}${PASTE_END}`);
    input.focused = this.hasFocus;
    input.onSubmit = (text) => this.commit(text);
    input.onEscape = () => {
      this.editing = undefined;
    };
    this.editing = { row, input };
  }

  private commit(text: string): void {
    const { editing } = this;
    if (!editing) {
      return;
    }
    const { row } = editing;
    try {
      if (row.kind === "number") {
        const n = Number(text.trim());
        if (!text.trim() || !Number.isInteger(n) || n < row.min || n > row.max) {
          editing.error = `enter a whole number from ${row.min} to ${row.max}`;
          return;
        }
        if (n !== row.get()) {
          row.set(n);
        }
      } else {
        const parsed = row.parse(text);
        if ("error" in parsed) {
          editing.error = parsed.error;
          return;
        }
        if (parsed.value !== row.get()) {
          row.set(parsed.value);
        }
      }
      this.editing = undefined;
    } catch (error) {
      editing.error = `could not save: ${errorMessage(error)}`;
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const inner = Math.max(1, width - 2);
    const frame = (line: string) => ` ${pad(line, inner)} `;
    const border = t.fg("borderAccent", "─".repeat(width));

    const head = [border, frame(spread(t.bold("Honcho settings"), this.keyHints(), inner))];
    const saved = `Saved to ${displayPath(this.model.path)}. "shared" applies to every harness, "pi only" to pi.`;
    for (const line of wrapTextWithAnsi(t.fg("dim", saved), inner)) {
      head.push(frame(line));
    }
    head.push(frame(""));

    const body = this.body(inner);
    const budget = Math.max(1, this.opts.maxLines() - head.length - 1);
    const lines = [...head];
    if (body.lines.length <= budget) {
      this.view.scroll = 0;
      for (const line of body.lines) {
        lines.push(this.paint(line, inner));
      }
    } else {
      const window = Math.max(1, budget - 1);
      const visible = this.scrollTo(body, window);
      for (const line of visible) {
        lines.push(this.paint(line, inner));
      }
      lines.push(frame(this.moreHint(body, window)));
    }
    lines.push(border);
    return lines;
  }

  private paint(line: BodyLine, inner: number): string {
    const text = ` ${pad(line.text, inner)} `;
    return line.selected ? this.theme.bg("selectedBg", text) : text;
  }

  private keyHints(): string {
    const t = this.theme;
    const pairs = this.editing
      ? [
          ["enter", "save"],
          ["esc", "cancel"],
        ]
      : [
          ["↑↓", "move"],
          ["←→", "change"],
          ["enter", "edit"],
          ["esc", "close"],
        ];
    return pairs.map(([key, word]) => `${t.fg("dim", `${key} `)}${word}`).join(t.fg("dim", " · "));
  }

  /** Keeps the selected row, its helper lines and the header of a section it opens inside the window. */
  private scrollTo(body: Body, window: number): BodyLine[] {
    const [start, line, end] = body.spans.get(this.view.selected) ?? [0, 0, 0];
    let { scroll } = this.view;
    if (start < scroll) {
      scroll = start;
    }
    if (end >= scroll + window) {
      scroll = end - window + 1;
    }
    // A window shorter than the span still shows the row itself
    if (line < scroll) {
      scroll = line;
    }
    scroll = Math.min(Math.max(0, scroll), Math.max(0, body.lines.length - window));
    this.view.scroll = scroll;
    return body.lines.slice(scroll, scroll + window);
  }

  private moreHint(body: Body, window: number): string {
    const rowsIn = (lines: BodyLine[]) => lines.filter((line) => line.row !== undefined).length;
    const above = rowsIn(body.lines.slice(0, this.view.scroll));
    const below = rowsIn(body.lines.slice(this.view.scroll + window));
    const parts = [above ? `↑ ${above} more` : "", below ? `↓ ${below} more` : ""].filter(Boolean);
    return this.theme.fg("dim", `  ${parts.join(" · ")}`);
  }

  private body(inner: number): Body {
    const t = this.theme;
    const lines: BodyLine[] = [];
    const spans = new Map<number, [number, number, number]>();
    for (const section of SECTIONS) {
      const indices = this.rows.flatMap((row, i) => (row.section === section ? [i] : []));
      if (!indices.length) {
        continue;
      }
      if (lines.length) {
        lines.push({ text: "" });
      }
      const header = lines.length;
      lines.push({ text: ` ${t.fg("accent", t.bold(section))}` });
      for (const i of indices) {
        const row = this.rows[i];
        if (!row) {
          continue;
        }
        const selected = i === this.view.selected;
        const own = lines.length;
        lines.push({ text: this.rowLine(row, selected, inner), row: i, selected });
        for (const helper of row.helpers?.() ?? []) {
          const note = helper.note ? t.fg("dim", helper.note) : "";
          lines.push({
            text: `${" ".repeat(MARKER_WIDTH + LABEL_WIDTH)}${t.fg("dim", helper.text)}${helper.value ?? ""}${note}`,
          });
        }
        spans.set(i, [i === indices[0] ? header : own, own, lines.length - 1]);
      }
    }
    return { lines, spans };
  }

  private rowLine(row: Row, selected: boolean, inner: number): string {
    const t = this.theme;
    const marker = selected ? ">  " : "   ";
    const label = row.label.padEnd(LABEL_WIDTH);
    const scope = row.scope();
    const right = scope ? t.fg("dim", scope) : "";
    const prefix = `${marker}${selected ? label : t.fg("dim", label)}`;
    const editing = this.editing?.row === row ? this.editing : undefined;
    if (editing) {
      const error = editing.error ? `${HINT_GAP}${t.fg("error", editing.error)}` : "";
      const room =
        inner -
        MARKER_WIDTH -
        LABEL_WIDTH -
        (right ? visibleWidth(right) + SCOPE_GAP : 0) -
        visibleWidth(error);
      const fieldWidth = Math.max(4, Math.min(room, visibleWidth(editing.input.getValue()) + 1));
      const field = editing.input.render(fieldWidth)[0] ?? "";
      return spread(`${prefix}${field}${error}`, right, inner);
    }
    const hint = this.hintText(row, selected);
    return spread(
      `${prefix}${this.valueText(row, selected)}${hint ? `${HINT_GAP}${hint}` : ""}`,
      right,
      inner,
    );
  }

  private hintText(row: Row, selected: boolean): string | undefined {
    const t = this.theme;
    if (selected && this.notice) {
      return t.fg(this.notice.tone === "error" ? "error" : "dim", this.notice.text);
    }
    const hint = row.hint?.();
    return hint ? t.fg("dim", hint) : undefined;
  }

  private valueText(row: Row, selected: boolean): string {
    const t = this.theme;
    const box = (on: boolean) => (on ? t.fg("success", "[x]") : t.fg("dim", "[ ]"));
    switch (row.kind) {
      case "choice":
        return t.fg("accent", `‹ ${row.get()} ›`);
      case "text":
      case "action":
        return row.display();
      case "number":
        return String(row.get());
      case "toggle":
        return box(row.get());
      case "checks": {
        const on = new Set(row.get());
        return row.boxes
          .map(
            (b, i) =>
              `${box(on.has(b.key))} ${selected && i === this.view.box ? t.fg("accent", t.underline(b.label)) : b.label}`,
          )
          .join("  ");
      }
    }
  }
}
