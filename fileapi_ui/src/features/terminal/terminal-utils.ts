import type { Terminal } from "@xterm/xterm";

export const VT_SESSION_BOUNDARY_GUARD = "\u001b\\\u001b[0m";
// A plain VT replay tail only needs the parser guard above. SSH session
// boundaries also restore input-related modes so an interrupted full-screen
// program cannot leave cursor, keypad, mouse or focus-reporting modes active
// in the next shell session. Explicit mode changes avoid RIS (`ESC c`), which
// would erase the scrollback the user expects to keep across reconnects.
export const SSH_SESSION_BOUNDARY_GUARD = [
  VT_SESSION_BOUNDARY_GUARD,
  "\u001b[?1l", // Normal cursor-key mode (Home/End use xterm's normal sequences).
  "\u001b>", // Normal keypad mode.
  "\u001b[?7h", // Normal wrapping.
  "\u001b[?25h", // Show the cursor.
  "\u001b[?45l", // Disable reverse wrapping.
  "\u001b[?9l\u001b[?1000l\u001b[?1001l\u001b[?1002l\u001b[?1003l", // Disable mouse tracking.
  "\u001b[?1004l", // Disable focus-in/focus-out reports.
  "\u001b[?1005l\u001b[?1006l\u001b[?1015l\u001b[?1016l", // Reset mouse encodings.
  "\u001b[?1007l", // Disable alternate-scroll mode.
  "\u001b[4l", // Normal replace mode.
  "\u001b[?2004l", // Disable bracketed paste.
  "\u001b[?2026l", // End synchronized output if it was interrupted.
].join("");
const SSH_ALTERNATE_SCREEN_GUARD = "\u001b[?47l\u001b[?1047l\u001b[?1049l";
const connectionBoundaries = new WeakMap<Terminal, { ready: boolean }>();
export const getTerminalConnectionBoundary = (terminal: Terminal) => connectionBoundaries.get(terminal);
export const resetTerminalConnection = (terminal: Terminal | undefined) => {
  if (!terminal) return;
  const boundary = { ready: false };
  connectionBoundaries.set(terminal, boundary);
  // Invalidate pending clipboard reads synchronously, before xterm parses the reset.
  // Leaving an alternate buffer restores its saved cursor. Sending those
  // sequences while already on the primary buffer can restore a stale cursor
  // over existing output, so only do it when xterm confirms the alternate
  // buffer is active.
  const alternateBufferActive = terminal.buffer?.active?.type === "alternate";
  const cursorBuffer = alternateBufferActive ? terminal.buffer?.normal : terminal.buffer?.active;
  const cursorX = cursorBuffer?.cursorX;
  const cursorY = cursorBuffer?.cursorY;
  // DECOM reset moves the cursor home; save and restore its position only
  // when origin mode or an alternate-buffer transition can move it.
  const resetOriginMode = Boolean(terminal.modes?.originMode);
  const restoreCursor = (alternateBufferActive || resetOriginMode) &&
    Number.isInteger(cursorX) && Number.isInteger(cursorY)
    ? `\u001b[${Math.max(1, cursorY! + 1)};${Math.max(1, Math.min(cursorX!, terminal.cols - 1) + 1)}H`
    : "";
  const guard = [
    SSH_SESSION_BOUNDARY_GUARD,
    alternateBufferActive ? SSH_ALTERNATE_SCREEN_GUARD : "",
    resetOriginMode ? "\u001b[?6l" : "",
    restoreCursor,
  ].join("");
  terminal.write(guard, () => { boundary.ready = true; });
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
