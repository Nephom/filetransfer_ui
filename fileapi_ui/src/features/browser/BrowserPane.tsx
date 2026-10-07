import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
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

type CaptureSelection = { x: number; y: number; width: number; height: number };

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

const boundsKey = (bounds: BrowserBounds) => `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${bounds.devicePixelRatio}`;

/** Largest physical-pixel difference between the requested and the native rectangle. */
const readbackDelta = ({ requested, actual }: BrowserBoundsReadback) => Math.max(
  Math.abs(requested.x - actual.x),
  Math.abs(requested.y - actual.y),
  Math.abs(requested.width - actual.width),
  Math.abs(requested.height - actual.height),
);

export function BrowserPane({ paneId, initialUrl, visible, onInitialUrlConsumed, onOpenNewPane }: Props) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const createdRef = useRef(false);
  const boundsQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastBoundsRef = useRef("");
  const boundsErrorRef = useRef(false);
  const visibleRef = useRef(visible);
  const editingRef = useRef(false);
  const initialUrlRef = useRef(initialUrl);
  const onInitialUrlConsumedRef = useRef(onInitialUrlConsumed);
  const onOpenNewPaneRef = useRef(onOpenNewPane);
  const [viewReady, setViewReady] = useState(false);
  const [address, setAddress] = useState(visibleAddress(initialUrl));
  const [error, setError] = useState("");
  const [captureImage, setCaptureImage] = useState("");
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState("");
  const [captureNotice, setCaptureNotice] = useState("");
  const [captureSelection, setCaptureSelection] = useState<CaptureSelection | null>(null);
  const captureImageRef = useRef<HTMLImageElement | null>(null);
  const selectionStartRef = useRef<{ x: number; y: number } | null>(null);
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

  const readBounds = useCallback((): BrowserBounds | null => {
    const anchor = anchorRef.current;
    if (!anchor) return null;
    const rect = anchor.getBoundingClientRect();
    if (rect.width < 3 || rect.height < 3) return null;
    // CSS pixels, not rounded: the native side converts to physical pixels with
    // devicePixelRatio. Keep the child surface 1 CSS px inside the pane border.
    return {
      x: rect.left + 1,
      y: rect.top + 1,
      width: rect.width - 2,
      height: rect.height - 2,
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  }, []);

  const applyBounds = useCallback(async (bounds: BrowserBounds) => {
    const first = await invoke<BrowserBoundsReadback>("browser_set_bounds", { paneId, bounds });
    if (readbackDelta(first) <= 1) return;
    // The native rectangle differs from the request: push it once more and
    // report it if the second attempt still does not match.
    const second = await invoke<BrowserBoundsReadback>("browser_set_bounds", { paneId, bounds });
    if (readbackDelta(second) > 1) console.warn(`Browser pane ${paneId} native bounds differ from the requested rectangle`, second);
  }, [paneId]);

  const scheduleBounds = useCallback(() => {
    const bounds = readBounds();
    if (!bounds) return;
    const serialized = boundsKey(bounds);
    if (serialized === lastBoundsRef.current) return;
    lastBoundsRef.current = serialized;
    boundsQueueRef.current = boundsQueueRef.current
      .then(async () => {
        if (!createdRef.current) return;
        await applyBounds(bounds);
        if (boundsErrorRef.current) {
          boundsErrorRef.current = false;
          setError("");
        }
      })
      .catch((reason: unknown) => {
        // Forget the failed rectangle so the next layout change sends it again.
        if (lastBoundsRef.current === serialized) lastBoundsRef.current = "";
        boundsErrorRef.current = true;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [applyBounds, readBounds]);

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
      if (cancelled) {
        await invoke("browser_destroy", { paneId }).catch(() => undefined);
        return;
      }
      createdRef.current = true;
      // A creation rectangle the native side did not honour is pushed again by the first sync.
      lastBoundsRef.current = readbackDelta(readback) <= 1 ? boundsKey(bounds) : "";
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
  }, [paneId, readBounds]);

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
    // Moving the window to a display with another scale changes devicePixelRatio.
    let disposed = false;
    let unlistenScale: (() => void) | undefined;
    void getCurrentWebviewWindow().onScaleChanged(() => scheduleBounds()).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenScale = unlisten;
    }).catch(() => undefined);
    scheduleBounds();
    return () => {
      disposed = true;
      unlistenScale?.();
      resizeObserver.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", scheduleBounds);
    };
  }, [viewReady, scheduleBounds]);

  useEffect(() => {
    if (!viewReady) return;
    const browserVisible = visible && !captureImage;
    if (browserVisible) scheduleBounds();
    boundsQueueRef.current = boundsQueueRef.current
      .then(async () => { await invoke<void>("browser_set_visible", { paneId, visible: browserVisible }); })
      .catch(() => undefined);
  }, [paneId, viewReady, visible, captureImage, scheduleBounds]);

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

  const startScreenshot = async () => {
    if (!viewReady || !visible || captureBusy) return;
    setCaptureBusy(true);
    setCaptureError("");
    setCaptureNotice("");
    setError("");
    try {
      const image = await invoke<string>("browser_capture_full_page", { paneId });
      await invoke<void>("browser_set_visible", { paneId, visible: false });
      setCaptureSelection(null);
      setCaptureImage(image);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCaptureBusy(false);
    }
  };

  const closeScreenshot = () => {
    selectionStartRef.current = null;
    setCaptureSelection(null);
    setCaptureImage("");
    setCaptureError("");
    setCaptureNotice("");
  };

  const pointerPosition = (event: ReactPointerEvent<HTMLDivElement>) => {
    const image = captureImageRef.current;
    if (!image) return null;
    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };

  const handleSelectionStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = pointerPosition(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    selectionStartRef.current = point;
    setCaptureSelection({ x: point.x, y: point.y, width: 0, height: 0 });
    setCaptureError("");
  };

  const handleSelectionMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = selectionStartRef.current;
    const point = pointerPosition(event);
    if (!start || !point) return;
    setCaptureSelection({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    });
  };

  const handleSelectionEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!selectionStartRef.current) return;
    handleSelectionMove(event);
    selectionStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const saveScreenshotSelection = async () => {
    const image = captureImageRef.current;
    const selection = captureSelection;
    if (!image || !selection || selection.width <= 0 || selection.height <= 0) {
      setCaptureError("Drag on the page preview to select an area first.");
      return;
    }
    const left = Math.max(0, Math.floor(selection.x * image.naturalWidth));
    const top = Math.max(0, Math.floor(selection.y * image.naturalHeight));
    const right = Math.min(image.naturalWidth, Math.ceil((selection.x + selection.width) * image.naturalWidth));
    const bottom = Math.min(image.naturalHeight, Math.ceil((selection.y + selection.height) * image.naturalHeight));
    if (right <= left || bottom <= top) {
      setCaptureError("The selected area is too small. Drag to select a larger area.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = right - left;
    canvas.height = bottom - top;
    const context = canvas.getContext("2d");
    if (!context) {
      setCaptureError("Unable to prepare the selected screenshot.");
      return;
    }
    context.drawImage(image, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);

    setCaptureBusy(true);
    setCaptureError("");
    setCaptureNotice("");
    try {
      const pngBase64 = canvas.toDataURL("image/png").split(",", 2)[1];
      if (!pngBase64) throw new Error("Unable to encode the selected screenshot as PNG.");
      const path = await invoke<string | null>("browser_save_screenshot", { pngBase64 });
      if (path) setCaptureNotice(`Screenshot saved to ${path}`);
    } catch (reason) {
      setCaptureError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCaptureBusy(false);
    }
  };

  useEffect(() => {
    if (!captureImage) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeScreenshot();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [captureImage]);

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
          <button type="button" className="browser-screenshot" aria-label="Capture full page" title="Capture full page" disabled={!viewReady || !visible || captureBusy} onClick={() => { void startScreenshot(); }}>
            {captureBusy && !captureImage ? "…" : "Screenshot"}
          </button>
        </div>
        {error && <div className="browser-error" role="alert">{error}</div>}
      </form>
      <div ref={anchorRef} className="browser-viewport" aria-label="Web page content" />
      {captureImage && <div className="browser-capture-layer" role="presentation">
        <section className="browser-capture-dialog" role="dialog" aria-modal="true" aria-labelledby="browser-capture-title">
          <header className="browser-capture-heading">
            <div><strong id="browser-capture-title">Select screenshot area</strong><span>Drag across the full page preview to choose an area.</span></div>
            <button type="button" className="browser-capture-close" aria-label="Close screenshot selection" onClick={closeScreenshot}>×</button>
          </header>
          <div className="browser-capture-stage">
            <div
              className="browser-capture-preview"
              onPointerDown={handleSelectionStart}
              onPointerMove={handleSelectionMove}
              onPointerUp={handleSelectionEnd}
              onPointerCancel={handleSelectionEnd}
            >
              <img ref={captureImageRef} src={`data:image/png;base64,${captureImage}`} alt="Full page screenshot preview" draggable={false} />
              {captureSelection && <div
                className="browser-capture-selection"
                style={{
                  left: `${captureSelection.x * 100}%`,
                  top: `${captureSelection.y * 100}%`,
                  width: `${captureSelection.width * 100}%`,
                  height: `${captureSelection.height * 100}%`,
                }}
              />}
            </div>
          </div>
          {captureError && <div className="browser-capture-message browser-capture-error" role="alert">{captureError}</div>}
          {captureNotice && <div className="browser-capture-message" role="status">{captureNotice}</div>}
          <footer className="browser-capture-actions">
            <button type="button" onClick={closeScreenshot} disabled={captureBusy}>Cancel</button>
            <button type="button" className="browser-capture-save" onClick={() => { void saveScreenshotSelection(); }} disabled={captureBusy}>
              {captureBusy ? "Working…" : "Save selection"}
            </button>
          </footer>
        </section>
      </div>}
    </section>
  );
}
