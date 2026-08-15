import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";

export function useTerminalLifecycle({ enabled, hostRef, terminalRef, replayOutput, boundaryGuard, onData, onResize }: {
  enabled: boolean;
  hostRef: RefObject<HTMLDivElement>;
  terminalRef: MutableRefObject<Terminal | null>;
  replayOutput: string;
  boundaryGuard: string;
  onData: (data: string, replaying: boolean) => void;
  onResize: (cols: number, rows: number) => void;
}) {
  const dataRef = useRef(onData);
  const resizeRef = useRef(onResize);
  dataRef.current = onData;
  resizeRef.current = onResize;
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
      terminal.write(`${replayOutput}${boundaryGuard}`, () => { replaying = false; });
      const resize = () => { fit.fit(); resizeRef.current(terminal.cols, terminal.rows); };
      const observer = new ResizeObserver(resize);
      observer.observe(hostRef.current);
      resize();
      const input = terminal.onData((data) => dataRef.current(data, replaying));
      cleanup = () => { input.dispose(); observer.disconnect(); terminal.dispose(); terminalRef.current = null; };
    });
    return () => { disposed = true; cleanup?.(); };
  }, [boundaryGuard, enabled, hostRef, replayOutput, terminalRef]);
}
