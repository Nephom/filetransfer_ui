import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ChevronLeftIcon, ChevronRightIcon, RefreshIcon, StopIcon } from "../../ui/icons";
import type { PaneBrowserWindowId } from "../../pane/pane-window-model";
import type { BrowserBounds, BrowserBoundsReadback, BrowserNavigationState, BrowserNewPaneEvent, BrowserViewStateEvent } from "./browser-contracts";
import { BROWSER_NEW_PANE_EVENT, BROWSER_VIEW_STATE_EVENT } from "./browser-contracts";
import "./browser-pane.css";

type Props = {
  paneId: PaneBrowserWindowId;
  initialUrl: string;
  visible: boolean;
  onInitialUrlConsumed: () => void;
  onOpenNewPane: (url: string) => void;
};

const isHostWithPort = (value: string) => /^(?:\[[\da-f:.]+\]|[^/:?#\s]+):\d+(?:[/?#]|$)/i.test(value);

export function normalizeBrowserUrl(value: string): string {
  const input = value.trim();
  if (!input) throw new Error("Enter a web address.");

  const hasHttpScheme = /^https?:\/\//i.test(input);
  const hasOtherScheme = /^[a-z][a-z\d+.-]*:/i.test(input) && !hasHttpScheme && !isHostWithPort(input);
  if (hasOtherScheme) throw new Error("Only HTTP and HTTPS addresses are supported.");

  const url = new URL(hasHttpScheme ? input : `https://${input}`);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new Error("Enter a valid HTTP or HTTPS address.");
  }
  return url.href;
}

const visibleAddress = (url: string) => url === "about:blank" ? "" : url;

export function BrowserPane({ paneId, initialUrl, visible, onInitialUrlConsumed, onOpenNewPane }: Props) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const createdRef = useRef(false);
  const boundsQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastBoundsRef = useRef("");
  const visibleRef = useRef(visible);
  const editingRef = useRef(false);
  const initialUrlRef = useRef(initialUrl);
  const onInitialUrlConsumedRef = useRef(onInitialUrlConsumed);
  const onOpenNewPaneRef = useRef(onOpenNewPane);
  const [viewReady, setViewReady] = useState(false);
  const [address, setAddress] = useState(visibleAddress(initialUrl));
  const [error, setError] = useState("");
  const [viewState, setViewState] = useState<BrowserViewStateEvent>({
    paneId,
    url: initialUrl || "about:blank",
    loading: false,
    canGoBack: false,
    canGoForward: false,
  });

  visibleRef.current = visible;
  onInitialUrlConsumedRef.current = onInitialUrlConsumed;
  onOpenNewPaneRef.current = onOpenNewPane;

  const reportBoundsReadback = useCallback((readback: BrowserBoundsReadback) => {
    if (!import.meta.env.DEV) return;
    const delta = Math.max(
      Math.abs(readback.requested.x - readback.actual.x),
      Math.abs(readback.requested.y - readback.actual.y),
      Math.abs(readback.requested.width - readback.actual.width),
      Math.abs(readback.requested.height - readback.actual.height),
    );
    if (delta > 1) console.warn(`Browser pane ${paneId} native bounds differ from the requested rectangle`, readback);
  }, [paneId]);

  const readBounds = useCallback((): BrowserBounds | null => {
    const anchor = anchorRef.current;
    if (!anchor) return null;
    const rect = anchor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  }, []);

  const scheduleBounds = useCallback(() => {
    const bounds = readBounds();
    if (!bounds) return;
    const serialized = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${bounds.devicePixelRatio}`;
    if (serialized === lastBoundsRef.current) return;
    lastBoundsRef.current = serialized;
    boundsQueueRef.current = boundsQueueRef.current
      .then(async () => {
        if (!createdRef.current) return;
        const readback = await invoke<BrowserBoundsReadback>("browser_set_bounds", { paneId, bounds });
        reportBoundsReadback(readback);
      })
      .catch(() => undefined);
  }, [paneId, readBounds, reportBoundsReadback]);

  useEffect(() => {
    let cancelled = false;
    let unlistenState: (() => void) | undefined;
    let unlistenNewPane: (() => void) | undefined;

    const start = async () => {
      unlistenState = await listen<BrowserViewStateEvent>(BROWSER_VIEW_STATE_EVENT, ({ payload }) => {
        if (payload.paneId !== paneId) return;
        setViewState((current) => ({
          ...current,
          ...payload,
          canGoBack: payload.canGoBack ?? current.canGoBack,
          canGoForward: payload.canGoForward ?? current.canGoForward,
        }));
        if (!editingRef.current) setAddress(visibleAddress(payload.url));
      });
      unlistenNewPane = await listen<BrowserNewPaneEvent>(BROWSER_NEW_PANE_EVENT, ({ payload }) => {
        if (payload.paneId !== paneId) return;
        try {
          onOpenNewPaneRef.current(normalizeBrowserUrl(payload.url));
        } catch {
          setError("This link cannot be opened in a Browser pane.");
        }
      });
      if (cancelled) return;

      const bounds = readBounds();
      if (!bounds) throw new Error("Browser pane has no visible content area.");
      const url = initialUrlRef.current ? normalizeBrowserUrl(initialUrlRef.current) : "about:blank";
      const readback = await invoke<BrowserBoundsReadback>("browser_create", { paneId, initialUrl: url, bounds, visible: visibleRef.current });
      reportBoundsReadback(readback);
      if (cancelled) {
        await invoke("browser_destroy", { paneId }).catch(() => undefined);
        return;
      }
      createdRef.current = true;
      lastBoundsRef.current = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${bounds.devicePixelRatio}`;
      setViewReady(true);
      onInitialUrlConsumedRef.current();
    };

    void start().catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });

    return () => {
      cancelled = true;
      unlistenState?.();
      unlistenNewPane?.();
      if (createdRef.current) {
        createdRef.current = false;
        void invoke("browser_destroy", { paneId }).catch(() => undefined);
      }
    };
  }, [paneId, readBounds, reportBoundsReadback]);

  useEffect(() => {
    if (!viewReady) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const resizeObserver = new ResizeObserver(scheduleBounds);
    resizeObserver.observe(anchor);
    const pane = anchor.closest(".pane-window");
    const mutationObserver = pane ? new MutationObserver(scheduleBounds) : null;
    mutationObserver?.observe(pane!, { attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener("resize", scheduleBounds);
    let disposed = false;
    let unlistenScaleChange: (() => void) | undefined;
    void getCurrentWebviewWindow().onScaleChanged(() => scheduleBounds()).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenScaleChange = unlisten;
    }).catch(() => undefined);
    scheduleBounds();
    return () => {
      disposed = true;
      unlistenScaleChange?.();
      resizeObserver.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", scheduleBounds);
    };
  }, [viewReady, scheduleBounds]);

  useEffect(() => {
    if (!viewReady) return;
    if (visible) scheduleBounds();
    boundsQueueRef.current = boundsQueueRef.current
      .then(async () => { await invoke<void>("browser_set_visible", { paneId, visible }); })
      .catch(() => undefined);
  }, [paneId, viewReady, visible, scheduleBounds]);

  useEffect(() => {
    if (!viewReady || !visible) return undefined;
    let current = true;
    const refreshState = async () => {
      try {
        const state = await invoke<BrowserNavigationState>("browser_get_state", { paneId });
        if (!current) return;
        setViewState((previous) => ({ ...previous, ...state, loading: previous.loading }));
        if (!editingRef.current) setAddress(visibleAddress(state.url));
      } catch {
        // The native view can be destroyed between polling and a pane close.
      }
    };
    void refreshState();
    const timer = window.setInterval(() => { void refreshState(); }, 350);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [paneId, viewReady, visible]);

  const runBrowserCommand = async (command: string, args: Record<string, unknown> = {}) => {
    setError("");
    try {
      await invoke(command, { paneId, ...args });
      if (command === "browser_stop") setViewState((current) => ({ ...current, loading: false }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const submitAddress = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const url = normalizeBrowserUrl(address);
      editingRef.current = false;
      setError("");
      setAddress(url);
      await invoke("browser_navigate", { paneId, url });
      setViewState((current) => ({ ...current, url, loading: true }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <section className="browser-pane" aria-label="Browser">
      <form className="browser-toolbar" onSubmit={(event) => { void submitAddress(event); }}>
        <div className="browser-toolbar-controls">
          <button type="button" className="browser-control" aria-label="Back" title="Back" disabled={!viewState.canGoBack} onClick={() => { void runBrowserCommand("browser_history", { direction: "back" }); }}>
            <ChevronLeftIcon size={17} />
          </button>
          <button type="button" className="browser-control" aria-label="Forward" title="Forward" disabled={!viewState.canGoForward} onClick={() => { void runBrowserCommand("browser_history", { direction: "forward" }); }}>
            <ChevronRightIcon size={17} />
          </button>
          <button type="button" className="browser-control" aria-label="Refresh" title="Refresh" onClick={() => { void runBrowserCommand("browser_reload"); }}>
            <RefreshIcon size={16} />
          </button>
          <button type="button" className="browser-control" aria-label="Stop" title="Stop" disabled={!viewState.loading} onClick={() => { void runBrowserCommand("browser_stop"); }}>
            <StopIcon size={15} />
          </button>
          <input
            className="browser-address"
            type="text"
            value={address}
            placeholder="Enter a web address"
            aria-label="Web address"
            autoComplete="off"
            spellCheck={false}
            onFocus={() => { editingRef.current = true; }}
            onBlur={() => { editingRef.current = false; }}
            onChange={(event) => setAddress(event.currentTarget.value)}
          />
          <button type="submit" className="browser-go" aria-label="Go" title="Go">Go</button>
        </div>
        {error && <div className="browser-error" role="alert">{error}</div>}
      </form>
      <div ref={anchorRef} className="browser-viewport" aria-label="Web page content" />
    </section>
  );
}
