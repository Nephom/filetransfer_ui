export const VT_SESSION_BOUNDARY_GUARD = "\u001b\\\u001b[0m";
export const SSH_TAB_OUTPUT_CAP = 512 * 1024;

export const stripAnsi = (value: string) =>
  value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:][\d;]*)*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");

// Right-click paste must never submit the clipboard as terminal input. A
// newline in a clipboard selection is otherwise interpreted by xterm.js as
// Enter and can execute the pasted command immediately.
export const normalizeRightClickPaste = (value: string) =>
  value.replace(/\r\n?|\n/g, " ");

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
