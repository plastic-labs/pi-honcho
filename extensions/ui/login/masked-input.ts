import { decodeKittyPrintable, getKeybindings } from "@earendil-works/pi-tui";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const isControl = (ch: string): boolean => {
  const code = ch.charCodeAt(0);
  return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
};

/** Single-line secret field: holds the value and leaves rendering (masked) to the caller. */
export class MaskedInput {
  private text = "";
  private pasteBuffer: string | undefined;

  get value(): string {
    return this.text;
  }

  /** True between bracketed-paste markers, when escape bytes belong to the paste. */
  get pasting(): boolean {
    return this.pasteBuffer !== undefined;
  }

  clear(): void {
    this.text = "";
  }

  handleInput(data: string): void {
    if (this.pasteBuffer === undefined) {
      const start = data.indexOf(PASTE_START);
      if (start === -1) {
        this.handleKey(data);
        return;
      }
      if (start > 0) {
        this.handleKey(data.slice(0, start));
      }
      this.pasteBuffer = "";
      data = data.slice(start + PASTE_START.length);
    }
    this.pasteBuffer += data;
    const end = this.pasteBuffer.indexOf(PASTE_END);
    if (end === -1) {
      return;
    }
    const pasted = this.pasteBuffer.slice(0, end);
    const rest = this.pasteBuffer.slice(end + PASTE_END.length);
    this.pasteBuffer = undefined;
    this.insert(pasted);
    if (rest) {
      this.handleInput(rest);
    }
  }

  private handleKey(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.editor.deleteCharBackward")) {
      this.text = Array.from(this.text).slice(0, -1).join("");
      return;
    }
    if (
      kb.matches(data, "tui.editor.deleteToLineStart") ||
      kb.matches(data, "tui.editor.deleteWordBackward")
    ) {
      this.text = "";
      return;
    }
    const printable = decodeKittyPrintable(data);
    if (printable !== undefined) {
      this.insert(printable);
      return;
    }
    // Unbracketed pastes arrive as one multi-character chunk; key sequences carry control bytes
    if (!Array.from(data).some(isControl)) {
      this.insert(data);
    }
  }

  /** Keys never contain whitespace, so line breaks and spaces from a paste are dropped. */
  private insert(text: string): void {
    this.text += Array.from(text)
      .filter((ch) => !isControl(ch) && !/\s/.test(ch))
      .join("");
  }
}
