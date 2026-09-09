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
