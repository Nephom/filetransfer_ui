import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";

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
        const clean = bracketedPasteControlEnabled
          ? text.replace(/\x1b\[200~|\x1b\[201~/g, "")
          : text;
        if (bracketedPasteControlEnabled) terminal.input(clean);
        else terminal.paste(clean);
      };
      const onPaste = (event: ClipboardEvent) => {
        if (!bracketedPasteControlEnabled) return;
        const text = event.clipboardData?.getData("text/plain");
        if (text === undefined) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        pasteText(text);
      };
      const onContextMenu = (event: MouseEvent) => {
        event.preventDefault();
        void navigator.clipboard.readText().then(pasteText).catch(() => undefined);
      };
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.ctrlKey && event.key.toLowerCase() === "c" && !terminal.hasSelection()) {
          event.preventDefault();
          terminal.input("\u0003");
          return false;
        }
        return true;
      });
      const host = hostRef.current;
      host?.addEventListener("paste", onPaste, true);
      host?.addEventListener("contextmenu", onContextMenu);
      cleanup = () => {
        input.dispose();
        host?.removeEventListener("paste", onPaste, true);
        host?.removeEventListener("contextmenu", onContextMenu);
        observer.disconnect();
        terminal.dispose();
        terminalRef.current = null;
      };
    });
    return () => { disposed = true; cleanup?.(); };
  }, [boundaryGuard, bracketedPasteControlEnabled, enabled, hostRef, replayKey, terminalRef]);
}
