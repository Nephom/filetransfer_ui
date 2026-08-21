import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";

export const normalizeTerminalPaste = (text: string, sanitizeBracketedMarkers: boolean) =>
  sanitizeBracketedMarkers ? text.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "") : text;

// Tauri's WebView does not grant navigator.clipboard permission for the
// tauri.localhost origin. execCommand uses the document clipboard event path,
// which is also the fallback used by noVNC in the desktop client.
export const copyTerminalText = async (text: string) => {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    textarea.remove();
  }
  if (!copied && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
  }
  return copied;
};

export function useTerminalLifecycle({ enabled, hostRef, terminalRef, replayOutput, replayKey, boundaryGuard, bracketedPasteControlEnabled, onData, onResize }: {
  enabled: boolean;
  hostRef: RefObject<HTMLDivElement>;
  terminalRef: MutableRefObject<Terminal | null>;
  replayOutput: string;
  replayKey: string;
  boundaryGuard: string;
  bracketedPasteControlEnabled: boolean;
  onData: (data: string, replaying: boolean) => void;
  onResize: (cols: number, rows: number) => void;
}) {
  const dataRef = useRef(onData);
  const resizeRef = useRef(onResize);
  const replayOutputRef = useRef(replayOutput);
  dataRef.current = onData;
  resizeRef.current = onResize;
  replayOutputRef.current = replayOutput;
  useEffect(() => {
    if (!enabled || !hostRef.current) return undefined;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]).then(([{ Terminal }, { FitAddon }]) => {
      if (disposed || !hostRef.current) return;
      const terminal = new Terminal({ cursorBlink: true, convertEol: true, fontFamily: "monospace", fontSize: 13, theme: { background: "#020a12", foreground: "#d9eafa", cursor: "#47cdf1" } });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(hostRef.current);
      fit.fit();
      terminal.focus();
      terminalRef.current = terminal;
      let replaying = true;
      terminal.write(`${replayOutputRef.current}${boundaryGuard}`, () => { replaying = false; });
      const resize = () => { fit.fit(); resizeRef.current(terminal.cols, terminal.rows); };
      const observer = new ResizeObserver(resize);
      observer.observe(hostRef.current);
      resize();
      const input = terminal.onData((data) => dataRef.current(data, replaying));
      const pasteText = (text: string) => {
        // xterm.paste() handles bracketed-paste mode and emits onData, which
        // keeps the browser clipboard path identical to typed input.
        terminal.paste(normalizeTerminalPaste(text, bracketedPasteControlEnabled));
      };
      const onPaste = (event: ClipboardEvent) => {
        const text = event.clipboardData?.getData("text/plain");
        if (text === undefined) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        pasteText(text);
      };
      let selectionAtMouseDown = "";
      const onMouseDown = (event: MouseEvent) => {
        if (event.button !== 0) return;
        selectionAtMouseDown = terminal.getSelection();
        terminal.focus();
      };
      const onMouseUp = (event: MouseEvent) => {
        if (event.button !== 0) return;
        const selection = terminal.getSelection();
        if (selection && selection !== selectionAtMouseDown) {
          void copyTerminalText(selection).catch(() => undefined);
        }
        selectionAtMouseDown = "";
      };
      const host = hostRef.current;
      host?.addEventListener("paste", onPaste, true);
      host?.addEventListener("mousedown", onMouseDown, true);
      host?.addEventListener("mouseup", onMouseUp, true);
      cleanup = () => {
        input.dispose();
        host?.removeEventListener("paste", onPaste, true);
        host?.removeEventListener("mousedown", onMouseDown, true);
        host?.removeEventListener("mouseup", onMouseUp, true);
        observer.disconnect();
        terminal.dispose();
        terminalRef.current = null;
      };
    });
    return () => { disposed = true; cleanup?.(); };
  }, [boundaryGuard, bracketedPasteControlEnabled, enabled, hostRef, replayKey, terminalRef]);
}
