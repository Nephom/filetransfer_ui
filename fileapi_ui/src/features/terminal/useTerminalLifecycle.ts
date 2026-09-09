import { useEffect, useRef, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { isTerminalPasteShortcut, normalizeTerminalPasteText } from "./terminal-utils";

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

// `navigator.clipboard.readText()` is denied by the same Tauri WebView
// permission gap noted above, and unlike copy there is no `execCommand`
// fallback for reading (browsers/WebViews disable `execCommand("paste")`
// for security). The privileged `clipboard-manager` plugin
// (`src-tauri/capabilities/default.json` grants `allow-read-text`) is the
// only way to read the real OS clipboard from script here, so right-click
// paste (below) goes through it instead of any local "last copied" state.
export const readSystemClipboardText = () => readText();

type XtermModules = { Terminal: typeof Terminal; FitAddon: typeof FitAddon; WebglAddonCtor: typeof WebglAddon };

// Loaded once and cached for the lifetime of the app -- every tab's
// Terminal is constructed from the same already-resolved module set
// instead of re-running `import()` per tab. A failed import (a transient
// asset-loading hiccup) clears the cache instead of permanently poisoning
// it, so the *next* tab creation attempt retries the import from scratch
// rather than every future tab silently failing forever.
let xtermModulesPromise: Promise<XtermModules> | null = null;
const loadXtermModules = (): Promise<XtermModules> => {
  if (!xtermModulesPromise) {
    xtermModulesPromise = Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-webgl"),
      import("@xterm/xterm/css/xterm.css"),
    ]).then(([{ Terminal: TerminalCtor }, { FitAddon: FitAddonCtor }, { WebglAddon: WebglAddonCtor }]) => ({
      Terminal: TerminalCtor,
      FitAddon: FitAddonCtor,
      WebglAddonCtor,
    }));
    xtermModulesPromise.catch(() => {
      xtermModulesPromise = null;
    });
  }
  return xtermModulesPromise;
};

type TerminalInstance = {
  terminal: Terminal;
  fit: FitAddon;
  webgl?: WebglAddon;
  dispose: () => void;
};

// Issue #239: switching SSH tabs used to destroy the single shared
// xterm.js `Terminal` and rebuild it from scratch, replaying up to 512KB of
// raw ANSI/VT bytes into the fresh instance -- and, racing that
// asynchronous replay, immediately re-`fit()` and unconditionally push a
// remote `ssh_resize`. A full-screen program (opencode, vim, tmux, ...)
// that relies on absolute cursor addressing got its buffer reflowed
// mid-replay and was forced to redraw via SIGWINCH on every single tab
// switch, which is exactly what produced the reported "整個破圖" corruption.
//
// This hook now keeps one Terminal instance *per tab*, created once when
// the tab first appears and disposed only when the tab is closed (or the
// owning application is unmounted). Switching tabs and collapsing the dock
// are just CSS visibility toggles
// (see terminal.css's `.xterm-host`/`.xterm-host.active`) plus a same-size
// check before ever touching the remote PTY -- there is no more
// destroy/rebuild/replay cycle on the common tab-switch path.
export function useTerminalLifecycle({
  enabled,
  tabIds,
  activeTabId,
  hostRefsRef,
  terminalsRef,
  boundaryGuard,
  bracketedPasteControlEnabled,
  getInitialOutput,
  onData,
  onResize,
  onNotice,
}: {
  enabled: boolean;
  tabIds: string[];
  activeTabId: string;
  hostRefsRef: MutableRefObject<Map<string, HTMLDivElement>>;
  terminalsRef: MutableRefObject<Map<string, Terminal>>;
  boundaryGuard: string;
  bracketedPasteControlEnabled: boolean;
  // Called exactly once, at instance-creation time, to seed a (re)created
  // tab's Terminal with whatever it already accumulated -- e.g. the whole
  // dock was collapsed and reopened, or a tab produced output before the
  // panel was ever opened. Returns "" for a genuinely brand-new tab, in
  // which case no replay happens at all.
  getInitialOutput: (tabId: string) => string;
  onData: (tabId: string, data: string) => void;
  onResize: (tabId: string, cols: number, rows: number) => void;
  onNotice: (message: string) => void;
}) {
  const dataRef = useRef(onData);
  const resizeRef = useRef(onResize);
  const noticeRef = useRef(onNotice);
  const seedRef = useRef(getInitialOutput);
  const bracketedPasteRef = useRef(bracketedPasteControlEnabled);
  const activeTabIdRef = useRef(activeTabId);
  dataRef.current = onData;
  resizeRef.current = onResize;
  noticeRef.current = onNotice;
  seedRef.current = getInitialOutput;
  bracketedPasteRef.current = bracketedPasteControlEnabled;
  activeTabIdRef.current = activeTabId;

  // Map<tabId, TerminalInstance> -- the persistent, per-tab replacement
  // for the old single `terminalRef`. Kept in a plain ref (not React
  // state) since Terminal/addon objects are imperative resources React
  // does not own.
  const instancesRef = useRef<Map<string, TerminalInstance>>(new Map());
  const tabIdsRef = useRef<string[]>(tabIds);
  tabIdsRef.current = tabIds;
  const tabIdsKey = tabIds.join(",");

  // Creates one Terminal per newly-seen tab id, and disposes any instance
  // whose tab has been closed. A collapsed dock keeps existing instances
  // alive; only creation is paused until the dock is visible again.
  // Deliberately does NOT depend on
  // `activeTabId` -- switching tabs must never re-run this effect, since
  // doing so is exactly the destroy-and-rebuild behavior this hook
  // replaces (issue #239).
  useEffect(() => {
    let disposed = false;
    const createFor = (tabId: string) => {
      const host = hostRefsRef.current.get(tabId);
      // Host div not mounted yet -- TerminalWorkspace renders one per id
      // in `tabIds`, so this should be rare/transient; a later re-run of
      // this effect (next tabIds change) will pick it up.
      if (!enabled || !host || instancesRef.current.has(tabId)) return;
      void loadXtermModules().then(({ Terminal: TerminalCtor, FitAddon: FitAddonCtor, WebglAddonCtor }) => {
        if (disposed || instancesRef.current.has(tabId)) return;
        const currentHost = hostRefsRef.current.get(tabId);
        if (!currentHost) return;
        const terminal = new TerminalCtor({ cursorBlink: true, convertEol: true, fontFamily: "monospace", fontSize: 13, theme: { background: "#020a12", foreground: "#d9eafa", cursor: "#47cdf1" } });
        const fit = new FitAddonCtor();
        terminal.loadAddon(fit);
        terminal.open(currentHost);
        fit.fit();
        terminalsRef.current.set(tabId, terminal);
        const input = terminal.onData((data) => dataRef.current(tabId, data));
        const pasteText = (text: string) => {
          if (disposed) return;
          const paste = normalizeTerminalPasteText(text);
          if (paste.includes("\n") && !terminal.modes.bracketedPasteMode && !window.confirm(
            "This terminal has not enabled bracketed paste. Pasting multiple lines may execute multiple commands. Continue?"
          )) return;
          // A tab switch can leave focus on the tab header while the newly
          // active host is still becoming visible. Focus this exact instance
          // before dispatching so xterm sends the paste through this tab's
          // onData handler, never through whichever tab was active before it.
          terminal.focus();
          // xterm.paste() handles bracketed-paste mode and emits onData, which
          // keeps the browser clipboard path identical to typed input.
          terminal.paste(normalizeTerminalPaste(paste, bracketedPasteRef.current));
        };
        const readClipboardAndPaste = () => {
          if (disposed) return;
          readSystemClipboardText()
            .then((text) => {
              if (text) pasteText(text);
            })
            .catch(() => {
              noticeRef.current("Unable to read the system clipboard for paste. Check clipboard permissions and try again.");
            });
        };
        terminal.attachCustomKeyEventHandler((event) => {
          if (!isTerminalPasteShortcut(event)) return true;
          event.preventDefault();
          event.stopPropagation();
          readClipboardAndPaste();
          return false;
        });
        // Lets a remote full-screen program (one that has grabbed the mouse
        // for its own selection UI, disabling xterm's native selection --
        // see the doc comment on decodeOscClipboardSet) hand its selection to
        // the *real* system clipboard via OSC 52. Right-click paste (below)
        // reads that same real OS clipboard back, so this needs no local
        // bookkeeping of its own beyond writing the text out.
        const oscClipboard = terminal.parser.registerOscHandler(52, (data) => {
          const text = decodeOscClipboardSet(data);
          if (text === undefined) return true;
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
            void copyTerminalText(selection).catch(() => undefined);
          }
          selectionAtMouseDown = "";
        };
        // Right-click reads the real Windows/OS clipboard through the
        // privileged clipboard-manager plugin and pastes it, instead of
        // showing the WebView's native context menu -- the classic
        // terminal-emulator convention (PuTTY, most Linux terminals). Going
        // through the real OS clipboard (rather than replaying only a local
        // "last copied in this terminal" value) is what makes content
        // copied outside the terminal -- Notepad, a browser, another app --
        // pasteable here too (issue #234). A denied/failed read is reported
        // to the user via onNotice so a right-click doesn't silently appear
        // to do nothing; an empty clipboard (nothing to paste) is not an
        // error and is left as a no-op, same as pasting nothing normally
        // would be.
        const onContextMenu = (event: MouseEvent) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          readClipboardAndPaste();
        };
        currentHost.addEventListener("paste", onPaste, true);
        currentHost.addEventListener("mousedown", onMouseDown, true);
        currentHost.addEventListener("mouseup", onMouseUp, true);
        currentHost.addEventListener("contextmenu", onContextMenu, true);
        const dispose = () => {
          input.dispose();
          oscClipboard.dispose();
          currentHost.removeEventListener("paste", onPaste, true);
          currentHost.removeEventListener("mousedown", onMouseDown, true);
          currentHost.removeEventListener("mouseup", onMouseUp, true);
          currentHost.removeEventListener("contextmenu", onContextMenu, true);
          const instance = instancesRef.current.get(tabId);
          // `terminal.dispose()` already disposes every addon it still has
          // loaded, but the WebGL addon may have already disposed *itself*
          // via its own `onContextLoss` handler above -- disposing an addon
          // a second time throws in xterm.js, which would otherwise abort
          // this entire cleanup.
          try {
            instance?.webgl?.dispose();
          } catch {
            // Already disposed (context loss) or otherwise inert -- no-op.
          }
          terminal.dispose();
          terminalsRef.current.delete(tabId);
        };
        const instance: TerminalInstance = { terminal, fit, dispose };
        instancesRef.current.set(tabId, instance);
        // Only the tab this instance was created for and that is *still*
        // the active one (by the time the async xterm import resolved)
        // gets focused/measured/reported/WebGL-accelerated -- background
        // tabs stay on the cheap DOM renderer with no resize activity
        // until they actually become active (see the activation effect
        // below), which is what keeps this creation path from repeating
        // the double-fit()/unconditional-resize race that caused #239.
        const activateIfCurrent = () => {
          if (disposed || tabId !== activeTabIdRef.current) return;
          fit.fit();
          terminal.focus();
          resizeRef.current(tabId, terminal.cols, terminal.rows);
          if (!instance.webgl) {
            void loadXtermModules().then(({ WebglAddonCtor: Ctor }) => {
              if (disposed || instance.webgl || tabId !== activeTabIdRef.current) return;
              instance.webgl = loadWebglAddon(terminal, Ctor);
            });
          }
        };
        const seed = seedRef.current(tabId);
        if (seed) {
          // A tab that already has history (the dock was collapsed and
          // reopened, or output arrived before the panel was ever opened)
          // gets that history replayed once, here, at creation time only --
          // never again on a plain tab switch. Re-fitting/reporting size is
          // deferred until *after* this write's callback fires, so it can
          // never race the still-in-flight VT parse of the replayed bytes
          // the way the old per-switch replay did.
          terminal.write(`${seed}${boundaryGuard}`, activateIfCurrent);
        } else {
          activateIfCurrent();
        }
      });
    };
    for (const tabId of tabIdsRef.current) createFor(tabId);
    const wantedIds = new Set(tabIdsRef.current);
    for (const [tabId, instance] of instancesRef.current) {
      if (!wantedIds.has(tabId)) {
        instance.dispose();
        instancesRef.current.delete(tabId);
      }
    }
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tabIdsKey, hostRefsRef, terminalsRef, boundaryGuard]);

  // A collapsed dock intentionally does not dispose its instances: the host
  // elements remain mounted and the existing VT parser state must survive
  // reopening without replaying the capped raw output buffer. This final
  // cleanup still releases everything if the owning component is unmounted.
  useEffect(() => () => {
    for (const [tabId, instance] of instancesRef.current) {
      instance.dispose();
      instancesRef.current.delete(tabId);
    }
  }, []);

  // Activates exactly one tab's terminal at a time when switching between
  // *already-existing* instances: focuses it, re-measures its size now
  // that it is visible again (a `visibility: hidden` host's layout box is
  // unaffected while hidden -- see terminal.css -- but the panel may have
  // been resized while this tab was backgrounded), reports a resize only
  // when the recomputed cols/rows actually differ, and attaches the WebGL
  // renderer only to the active tab so backgrounded tabs never hold a GPU
  // context (avoids exhausting the browser's concurrent WebGL context
  // limit when many tabs are open).
  useEffect(() => {
    if (!enabled || !activeTabId) return undefined;
    const instance = instancesRef.current.get(activeTabId);
    if (!instance) return undefined;
    let disposed = false;
    instance.fit.fit();
    instance.terminal.focus();
    resizeRef.current(activeTabId, instance.terminal.cols, instance.terminal.rows);
    if (!instance.webgl) {
      void loadXtermModules().then(({ WebglAddonCtor }) => {
        if (disposed || instance.webgl) return;
        instance.webgl = loadWebglAddon(instance.terminal, WebglAddonCtor);
      });
    }
    return () => {
      disposed = true;
      if (instance.webgl) {
        try {
          instance.webgl.dispose();
        } catch {
          // Already disposed (context loss) or otherwise inert -- no-op.
        }
        instance.webgl = undefined;
      }
    };
  }, [enabled, activeTabId]);

  // Re-fits only the active tab whenever the terminal panel itself is
  // resized (dragging the resize handle, maximizing, window resize, ...).
  // Background tabs are left alone; each re-fits itself the moment it
  // becomes active (the effect above), which is always correct because a
  // `visibility: hidden` host keeps the panel's current layout size for
  // the whole time it is hidden.
  useEffect(() => {
    if (!enabled || !activeTabId) return undefined;
    const instance = instancesRef.current.get(activeTabId);
    const host = hostRefsRef.current.get(activeTabId);
    if (!instance || !host) return undefined;
    const resize = () => {
      instance.fit.fit();
      resizeRef.current(activeTabId, instance.terminal.cols, instance.terminal.rows);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => observer.disconnect();
  }, [enabled, activeTabId, hostRefsRef]);
}
