import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { WebglAddon } from "@xterm/addon-webgl";

// Best-effort: attaches the WebGL2 renderer to `terminal` if the runtime
// supports it, otherwise leaves xterm's default DOM renderer untouched.
// Exported for tests -- this is the one piece of renderer-selection logic
// worth covering directly, since a regression here (throwing instead of
// falling back) would break every terminal tab, not just degrade
// performance.
export const loadWebglAddon = (terminal: Terminal, WebglAddonCtor: typeof WebglAddon) => {
  try {
    const addon = new WebglAddonCtor();
    // A lost WebGL context (GPU driver reset, browser resource pressure,
    // switching GPUs on a laptop, etc.) is recoverable by xterm itself --
    // dispose the addon and let the terminal keep working via its DOM
    // renderer rather than leaving it in a half-broken WebGL state.
    addon.onContextLoss(() => addon.dispose());
    terminal.loadAddon(addon);
    return addon;
  } catch {
    // No WebGL2 (older/locked-down WebView, software-only VM graphics
    // stack, etc.) -- xterm's constructor already defaults to its DOM
    // renderer, so there is nothing further to do here.
    return undefined;
  }
};

export const normalizeTerminalPaste = (text: string, sanitizeBracketedMarkers: boolean) =>
  sanitizeBracketedMarkers ? text.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "") : text;

// Decodes an OSC 52 clipboard-set request's `Pc;Pd` payload (see xterm's
// ctlseqs docs). Full-screen interactive programs (an SSH-side TUI running
// its own mouse handling, e.g. one that has grabbed the mouse for its own
// selection UI) use this to ask the *terminal* to write their selection to
// the real system clipboard, since xterm.js disables its own native
// selection/copy path while such a program owns the mouse. Only the "set"
// direction is decoded here -- `Pd === "?"` is a clipboard *read* request,
// which is intentionally left unhandled (returns `undefined`, same as any
// other unrecognized payload) so a remote shell/program can never use OSC
// 52 to silently exfiltrate the local clipboard's contents back through
// the terminal.
export const decodeOscClipboardSet = (data: string): string | undefined => {
  const separatorIndex = data.indexOf(";");
  if (separatorIndex === -1) return undefined;
  const payload = data.slice(separatorIndex + 1);
  if (!payload || payload === "?") return undefined;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return undefined;
  }
};

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
  // Survives tab switches (each tab swap tears down and recreates the
  // xterm instance below, but "what did I last copy" should behave like
  // any other clipboard -- still pasteable after switching tabs).
  const lastCopiedTextRef = useRef("");
  useEffect(() => {
    if (!enabled || !hostRef.current) return undefined;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    // The WebGL addon is loaded alongside xterm/fit rather than imported
    // statically so a virtual machine (or sandboxed WebView) with no
    // WebGL2 support at all still gets a working terminal via xterm's
    // default DOM renderer -- `loadWebglAddon` below never throws, it only
    // logs and leaves the DOM renderer in place if anything about WebGL
    // setup fails.
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-webgl"), import("@xterm/xterm/css/xterm.css")]).then(([{ Terminal }, { FitAddon }, { WebglAddon: WebglAddonCtor }]) => {
      if (disposed || !hostRef.current) return;
      const terminal = new Terminal({ cursorBlink: true, convertEol: true, fontFamily: "monospace", fontSize: 13, theme: { background: "#020a12", foreground: "#d9eafa", cursor: "#47cdf1" } });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(hostRef.current);
      // High-throughput SSH output (builds, `tail -f`, etc.) is markedly
      // cheaper to render through xterm's WebGL2 renderer than its default
      // per-glyph DOM renderer, which matters most on resource-constrained
      // virtual machines -- exactly where DOM-renderer cost compounding
      // with a busy terminal has been reported to make the whole app feel
      // like it is hanging. `loadWebglAddon` is entirely best-effort: any
      // failure (no WebGL2, a `webglcontextlost` event later on, etc.)
      // falls back to leaving xterm's own default DOM renderer in place,
      // which is exactly the pre-existing behavior this addon is layered
      // on top of.
      const webgl = loadWebglAddon(terminal, WebglAddonCtor);
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
      // Lets a remote full-screen program (one that has grabbed the mouse
      // for its own selection UI, disabling xterm's native selection --
      // see the doc comment on decodeOscClipboardSet) hand its selection to
      // the *real* system clipboard via OSC 52, and tracks it the same way
      // a local left-click selection is tracked below so right-click-paste
      // (also below) works uniformly regardless of which side made the copy.
      const oscClipboard = terminal.parser.registerOscHandler(52, (data) => {
        const text = decodeOscClipboardSet(data);
        if (text === undefined) return true;
        lastCopiedTextRef.current = text;
        void copyTerminalText(text).catch(() => undefined);
        return true;
      });
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
          lastCopiedTextRef.current = selection;
          void copyTerminalText(selection).catch(() => undefined);
        }
        selectionAtMouseDown = "";
      };
      // Right-click pastes whatever was last copied (by a local left-click
      // selection above or a remote OSC 52 request above) instead of
      // showing the WebView's native context menu -- the classic
      // terminal-emulator convention (PuTTY, most Linux terminals). This
      // listener, not the SSH-side program, always decides what gets
      // pasted and when, so the Windows client keeps the final say even
      // over a remote program that has grabbed the mouse for itself.
      const onContextMenu = (event: MouseEvent) => {
        event.preventDefault();
        const text = lastCopiedTextRef.current;
        if (text) pasteText(text);
      };
      const host = hostRef.current;
      host?.addEventListener("paste", onPaste, true);
      host?.addEventListener("mousedown", onMouseDown, true);
      host?.addEventListener("mouseup", onMouseUp, true);
      host?.addEventListener("contextmenu", onContextMenu, true);
      cleanup = () => {
        input.dispose();
        oscClipboard.dispose();
        host?.removeEventListener("paste", onPaste, true);
        host?.removeEventListener("mousedown", onMouseDown, true);
        host?.removeEventListener("mouseup", onMouseUp, true);
        host?.removeEventListener("contextmenu", onContextMenu, true);
        observer.disconnect();
        // `terminal.dispose()` already disposes every addon it still has
        // loaded, but the WebGL addon may have already disposed *itself*
        // via its own `onContextLoss` handler above (a lost GPU context is
        // exactly the situation this guard is for) -- disposing an addon a
        // second time throws in xterm.js, which would otherwise abort this
        // entire cleanup (including `terminalRef.current = null` below) and
        // leak the terminal instance.
        try {
          webgl?.dispose();
        } catch {
          // Already disposed (context loss) or otherwise inert -- no-op.
        }
        terminal.dispose();
        terminalRef.current = null;
      };
    });
    return () => { disposed = true; cleanup?.(); };
  }, [boundaryGuard, bracketedPasteControlEnabled, enabled, hostRef, replayKey, terminalRef]);
}
