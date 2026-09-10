import type { Terminal } from "@xterm/xterm";

export const VT_SESSION_BOUNDARY_GUARD = "\u001b\\\u001b[0m";
// Replay only needs the parser guard above; real connections also reset DEC 2004.
export const SSH_SESSION_BOUNDARY_GUARD = `${VT_SESSION_BOUNDARY_GUARD}\u001b[?2004l`;
const connectionBoundaries = new WeakMap<Terminal, { ready: boolean }>();
export const getTerminalConnectionBoundary = (terminal: Terminal) => connectionBoundaries.get(terminal);
export const resetTerminalConnection = (terminal: Terminal | undefined) => {
  if (!terminal) return;
  const boundary = { ready: false };
  connectionBoundaries.set(terminal, boundary);
  // Invalidate pending clipboard reads synchronously, before xterm parses the reset.
  terminal.write(SSH_SESSION_BOUNDARY_GUARD, () => { boundary.ready = true; });
};
export const SSH_TAB_OUTPUT_CAP = 512 * 1024;

export const stripAnsi = (value: string) =>
  value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:][\d;]*)*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");

type RecordingParserState = "text" | "escape" | "csi" | "string";

/** Removes terminal protocol bytes from the recording's plain transcript.
 * The parser is stateful because SSH output can split one VT sequence across
 * multiple Tauri events. This is intentionally separate from stripAnsi: the
 * live terminal and prompt detection must keep their existing behavior. */
export class RecordingPlainTranscript {
  private state: RecordingParserState = "text";
  private stringTerminatedByEscape = false;
  private column = 0;

  consume(value: string) {
    let plain = "";
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (this.state === "escape") {
        if (character === "[") this.state = "csi";
        else if (character === "]" || character === "P" || character === "^" || character === "_") {
          this.state = "string";
          this.stringTerminatedByEscape = false;
        } else this.state = "text";
        continue;
      }
      if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        continue;
      }
      if (this.state === "string") {
        if (this.stringTerminatedByEscape) {
          this.stringTerminatedByEscape = false;
          if (character === "\\") this.state = "text";
        } else if (code === 0x07) this.state = "text";
        else if (code === 0x1b) this.stringTerminatedByEscape = true;
        continue;
      }
      if (character === "\u001b") {
        this.state = "escape";
        continue;
      }
      if (code === 0x9b) {
        this.state = "csi";
        continue;
      }
      if (character === "\n") {
        plain += character;
        this.column = 0;
        continue;
      }
      if (character === "\r") {
        this.column = 0;
        continue;
      }
      if (character === "\t") {
        const spaces = 8 - (this.column % 8);
        plain += " ".repeat(spaces);
        this.column += spaces;
        continue;
      }
      if (character === "\b") {
        this.column = Math.max(0, this.column - 1);
        continue;
      }
      if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
      plain += character;
      this.column += 1;
    }
    return plain;
  }

}

export const normalizeTerminalPasteText = (value: string) =>
  value.replace(/\r\n?/g, "\n");

export const isTerminalPasteShortcut = (event: Pick<KeyboardEvent, "type" | "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "isComposing" | "keyCode" | "getModifierState">) =>
  event.type === "keydown" && !event.altKey && !event.isComposing && event.keyCode !== 229 && !event.getModifierState?.("AltGraph") && (
    ((event.key === "v" || event.key === "V" || event.code === "KeyV") && (event.ctrlKey || event.metaKey)) ||
    (event.key === "Insert" && event.shiftKey && !event.ctrlKey && !event.metaKey)
  );

export const appendSshTabOutput = (output: string, chunk: string) => {
  const next = output + chunk;
  if (next.length <= SSH_TAB_OUTPUT_CAP) return next;
  const cutFrom = next.length - SSH_TAB_OUTPUT_CAP;
  const newlineAt = next.indexOf("\n", cutFrom);
  return newlineAt === -1 ? next.slice(cutFrom) : next.slice(newlineAt + 1);
};

export const makeSshTabId = () => typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
