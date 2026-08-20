import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";

export const normalizeTerminalPaste = (text: string, sanitizeBracketedMarkers: boolean) =>
  sanitizeBracketedMarkers ? text.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "") : text;

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
      terminal.attachCustomKeyEventHandler((event) => {
        // Cmd+C remains the browser/xterm copy shortcut; only Ctrl+C without
        // a selection is the terminal interrupt key.
        if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "c" && !terminal.hasSelection()) {
          event.preventDefault();
          terminal.input("\u0003");
          return false;
        }
        return true;
      });
      const host = hostRef.current;
      host?.addEventListener("paste", onPaste, true);
      cleanup = () => {
        input.dispose();
        host?.removeEventListener("paste", onPaste, true);
        observer.disconnect();
        terminal.dispose();
        terminalRef.current = null;
      };
    });
    return () => { disposed = true; cleanup?.(); };
  }, [boundaryGuard, bracketedPasteControlEnabled, enabled, hostRef, replayKey, terminalRef]);
}
