import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ChevronLeftIcon, ChevronRightIcon, RefreshIcon, StopIcon } from "../../ui/icons";
import type { PaneBrowserWindowId } from "../../pane/pane-window-model";
import type { BrowserBounds, BrowserBoundsReadback, BrowserNavigationState, BrowserNewPaneEvent, BrowserViewStateEvent } from "./browser-contracts";
import { BROWSER_NEW_PANE_EVENT, BROWSER_VIEW_STATE_EVENT } from "./browser-contracts";
import { captureBrowserSnapshot, clearBrowserSnapshot, useBrowserSnapshot } from "./browser-snapshot-store";
import "./browser-pane.css";

type Props = {
  paneId: PaneBrowserWindowId;
  initialUrl: string;
  visible: boolean;
  onInitialUrlConsumed: () => void;
  onOpenNewPane: (url: string) => void;
};

type CaptureSelection = { x: number; y: number; width: number; height: number };
type BrowserScreenshotPlacement = {
  tile: number;
  dstX: number;
  dstY: number;
  width: number;
  height: number;
};
type BrowserScreenshotRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  contentWidth: number;
  contentHeight: number;
  scrollbarWidth: number;
  scrollbarHeight: number;
  description: string;
  truncated: boolean;
};
type BrowserScreenshotCapture = {
  viewportWidth: number;
  viewportHeight: number;
  region: BrowserScreenshotRegion | null;
  tiles: string[];
  placements: BrowserScreenshotPlacement[];
  skippedFrames: number;
};
type StitchedScreenshot = { dataUrl: string; notice: string };

const MAX_STITCHED_PIXELS = 40_000_000;

async function decodeScreenshotTile(data: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = `data:image/png;base64,${data}`;
  await image.decode();
  return image;
}

/**
 * Builds the full page image. The first tile is the unscrolled viewport; every
 * other tile only contributes the scrolling region at its scroll offset. All
 * coordinates are CSS pixels, converted with one scale and rounded per edge so
 * neighbouring pieces never leave a gap.
 */
async function stitchBrowserScreenshot(capture: BrowserScreenshotCapture): Promise<StitchedScreenshot> {
  const baseData = capture.tiles[0];
  if (!baseData || !(capture.viewportWidth > 0) || !(capture.viewportHeight > 0)) {
    throw new Error("The browser did not return a usable screenshot image.");
  }
  const skippedNote = capture.skippedFrames > 0
    ? ` ${capture.skippedFrames} frame(s) could not be inspected and are shown as visible.`
    : "";
  const region = capture.region;
  if (!region) {
    return {
      dataUrl: `data:image/png;base64,${baseData}`,
      notice: `No scrollable area was detected, so only the current view is shown.${skippedNote}`,
    };
  }

  const base = await decodeScreenshotTile(baseData);
  const scale = base.naturalWidth / capture.viewportWidth;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("The browser returned invalid screenshot dimensions.");
  }
  const extraWidth = Math.max(0, region.contentWidth - region.width);
  const extraHeight = Math.max(0, region.contentHeight - region.height);
  const px = (value: number) => Math.round(value * scale);

  const canvas = document.createElement("canvas");
  canvas.width = px(capture.viewportWidth + extraWidth);
  canvas.height = px(capture.viewportHeight + extraHeight);
  if (canvas.width < 1 || canvas.height < 1 || canvas.width * canvas.height > MAX_STITCHED_PIXELS) {
    throw new Error("The full page image is too large to preview and select.");
  }
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to prepare the full page screenshot.");

  const copy = (image: HTMLImageElement, srcX: number, srcY: number, width: number, height: number, dstX: number, dstY: number) => {
    const left = px(srcX);
    const top = px(srcY);
    const sourceWidth = px(srcX + width) - left;
    const sourceHeight = px(srcY + height) - top;
    if (sourceWidth <= 0 || sourceHeight <= 0) return;
    context.drawImage(image, left, top, sourceWidth, sourceHeight, px(dstX), px(dstY), sourceWidth, sourceHeight);
  };
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const probeContext = probe.getContext("2d");
  const sample = (x: number, y: number): string | null => {
    const sx = px(x);
    const sy = px(y);
    if (!probeContext || sx < 0 || sy < 0 || sx >= base.naturalWidth || sy >= base.naturalHeight) return null;
    probeContext.clearRect(0, 0, 1, 1);
    probeContext.drawImage(base, sx, sy, 1, 1, 0, 0, 1, 1);
    const [red, green, blue] = probeContext.getImageData(0, 0, 1, 1).data;
    return `rgb(${red}, ${green}, ${blue})`;
  };
  const fill = (color: string, x: number, y: number, width: number, height: number) => {
    context.fillStyle = color;
    context.fillRect(px(x), px(y), px(x + width) - px(x), px(y + height) - px(y));
  };

  const viewportWidth = capture.viewportWidth;
  const viewportHeight = capture.viewportHeight;
  const right = region.x + region.width;
  const bottom = region.y + region.height;
  const rightStart = right + region.scrollbarWidth;
  const probeY = Math.max(0, bottom - 2);

  // Background for the blank areas that appear where the region grew.
  fill(sample(region.x + region.width / 2, probeY) ?? "#ffffff", 0, 0, viewportWidth + extraWidth, viewportHeight + extraHeight);
  if (extraHeight > 0) {
    if (region.x >= 4) {
      const color = sample(region.x / 2, probeY);
      if (color) fill(color, 0, bottom, region.x, extraHeight);
    }
    if (rightStart + 4 <= viewportWidth) {
      const color = sample((rightStart + viewportWidth) / 2, probeY);
      if (color) fill(color, rightStart + extraWidth, bottom, viewportWidth - rightStart, extraHeight);
    }
  }

  // Everything around the region comes from the unscrolled base image; the
  // parts after the region move down/right by the amount the region grew. The
  // region's own scrollbars are left out.
  const columns = [
    { x: 0, width: region.x, shift: 0 },
    { x: region.x, width: region.width, shift: 0 },
    { x: right, width: Math.max(0, viewportWidth - right), shift: extraWidth },
  ];
  const rows = [
    { y: 0, height: region.y, shift: 0 },
    { y: region.y, height: region.height, shift: 0 },
    { y: bottom, height: Math.max(0, viewportHeight - bottom), shift: extraHeight },
  ];
  rows.forEach((row, rowIndex) => {
    columns.forEach((column, columnIndex) => {
      if (rowIndex === 1 && columnIndex === 1) return;
      let { x, width } = column;
      let { y, height } = row;
      if (rowIndex === 1 && columnIndex === 2) {
        const skip = Math.min(width, region.scrollbarWidth);
        x += skip;
        width -= skip;
      }
      if (rowIndex === 2 && columnIndex === 1) {
        const skip = Math.min(height, region.scrollbarHeight);
        y += skip;
        height -= skip;
      }
      if (width <= 0 || height <= 0) return;
      copy(base, x, y, width, height, x + column.shift, y + row.shift);
    });
  });

  // The region content: every tile contributes the region rectangle of its
  // viewport image at the scroll offset it was captured at.
  for (let tile = 0; tile < capture.tiles.length; tile += 1) {
    const placements = capture.placements.filter((placement) => placement.tile === tile);
    if (placements.length > 0) {
      const image = tile === 0 ? base : await decodeScreenshotTile(capture.tiles[tile]);
      for (const placement of placements) {
        copy(image, region.x, region.y, placement.width, placement.height, region.x + placement.dstX, region.y + placement.dstY);
      }
      if (image !== base) image.removeAttribute("src");
    }
    capture.tiles[tile] = "";
  }
  base.removeAttribute("src");

  const size = (width: number, height: number) => `${Math.round(width)}×${Math.round(height)}`;
  const truncatedNote = region.truncated ? " Capture stopped at the maximum image size." : "";
  return {
    dataUrl: canvas.toDataURL("image/png"),
    notice: `Captured scrolling area "${region.description}": ${size(region.width, region.height)} px visible, ${size(region.contentWidth, region.contentHeight)} px of content.${truncatedNote}${skippedNote}`,
  };
}

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
  // Whether the native child view is showing right now (it is hidden whenever the
  // pane is not the active one, an overlay is open or the screenshot picker is up).
  const nativeShownRef = useRef(false);
  const viewUrlRef = useRef(initialUrl || "about:blank");
  const [nativeShown, setNativeShown] = useState(false);
  const snapshot = useBrowserSnapshot(paneId);
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
  viewUrlRef.current = viewState.url;
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
      const createdVisible = visibleRef.current;
      const readback = await invoke<BrowserBoundsReadback>("browser_create", { paneId, initialUrl: url, bounds, visible: createdVisible });
      if (cancelled) {
        await invoke("browser_destroy", { paneId }).catch(() => undefined);
        return;
      }
      createdRef.current = true;
      nativeShownRef.current = createdVisible;
      setNativeShown(createdVisible);
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
      clearBrowserSnapshot(paneId);
      if (createdRef.current) {
        createdRef.current = false;
        nativeShownRef.current = false;
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
      .then(async () => {
        if (!createdRef.current) return;
        // A hidden native view cannot be captured, so the stand-in picture is taken
        // while the view is still showing, right before it is hidden.
        if (!browserVisible && nativeShownRef.current) {
          await captureBrowserSnapshot(paneId, viewUrlRef.current);
          if (!createdRef.current) {
            clearBrowserSnapshot(paneId);
            return;
          }
        }
        await invoke<void>("browser_set_visible", { paneId, visible: browserVisible });
        nativeShownRef.current = browserVisible;
        setNativeShown(browserVisible);
      })
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
      const capture = await invoke<BrowserScreenshotCapture>("browser_capture_full_page", { paneId });
      const stitched = await stitchBrowserScreenshot(capture);
      await captureBrowserSnapshot(paneId, viewUrlRef.current);
      await invoke<void>("browser_set_visible", { paneId, visible: false });
      nativeShownRef.current = false;
      setNativeShown(false);
      setCaptureSelection(null);
      setCaptureImage(stitched.dataUrl);
      setCaptureNotice(stitched.notice);
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
      <div ref={anchorRef} className="browser-viewport" aria-label="Web page content">
        {!nativeShown && snapshot && <img className="browser-snapshot" src={snapshot.dataUrl} alt="" draggable={false} />}
      </div>
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
              <img ref={captureImageRef} src={captureImage} alt="Full page screenshot preview" draggable={false} />
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
