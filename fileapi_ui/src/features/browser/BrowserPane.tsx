import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ChevronLeftIcon, ChevronRightIcon, RefreshIcon, StopIcon } from "../../ui/icons";
import type { PaneBrowserWindowId } from "../../pane/pane-window-model";
import type { BrowserBounds, BrowserBoundsReadback, BrowserDownloadEvent, BrowserDownloadForRemote, BrowserDownloadTarget, BrowserNavigationState, BrowserNewPaneEvent, BrowserViewStateEvent } from "./browser-contracts";
import { BROWSER_DOWNLOAD_EVENT, BROWSER_NEW_PANE_EVENT, BROWSER_VIEW_STATE_EVENT } from "./browser-contracts";
import { captureBrowserSnapshot, clearBrowserSnapshot, useBrowserSnapshot } from "./browser-snapshot-store";
import "./browser-pane.css";

type Props = {
  paneId: PaneBrowserWindowId;
  initialUrl: string;
  visible: boolean;
  downloadContext: {
    localFolder: string;
    remote: { locationId: string; locationName: string; path: string; canUpload: boolean } | null;
  };
  onBrowserDownloadToRemote: (download: BrowserDownloadForRemote) => Promise<void>;
  onInitialUrlConsumed: () => void;
  onOpenNewPane: (url: string) => void;
};

type BrowserDownloadItem = BrowserDownloadEvent & {
  deliveryStatus: "waiting" | "saving" | "saved" | "uploading" | "queued" | "failed";
  deliveryError?: string;
  destinationPath?: string;
};

const BROWSER_DOWNLOAD_TARGET_KEY = "nfterm-browser-download-target";

function readBrowserDownloadTarget(): BrowserDownloadTarget {
  try {
    const value = JSON.parse(localStorage.getItem(BROWSER_DOWNLOAD_TARGET_KEY) || "null") as BrowserDownloadTarget | null;
    if (value?.kind === "local-current") return value;
    if (value?.kind === "local-folder" && typeof value.folder === "string") return value;
    if (value?.kind === "remote" && typeof value.locationId === "string" && typeof value.locationName === "string" && typeof value.path === "string") return value;
  } catch {
    // A stale or manually edited browser preference should not block downloads.
  }
  return { kind: "local-current" };
}

const formatDownloadSize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
};

type CaptureSelection = { x: number; y: number; width: number; height: number };
type CapturePreviewSize = { width: number; height: number };
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
 * coordinates are CSS pixels. Source edges use each tile's actual scale, while
 * destination edges use the stitched page scale; rounding the edges separately
 * prevents fractional offsets from changing a feature's width between tiles.
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
    const sourceScaleX = image.naturalWidth / capture.viewportWidth;
    const sourceScaleY = image.naturalHeight / capture.viewportHeight;
    const sourcePxX = (value: number) => Math.round(value * sourceScaleX);
    const sourcePxY = (value: number) => Math.round(value * sourceScaleY);
    const sourceLeft = sourcePxX(srcX);
    const sourceTop = sourcePxY(srcY);
    const sourceRight = sourcePxX(srcX + width);
    const sourceBottom = sourcePxY(srcY + height);
    const destinationLeft = px(dstX);
    const destinationTop = px(dstY);
    const destinationRight = px(dstX + width);
    const destinationBottom = px(dstY + height);
    const sourceWidth = sourceRight - sourceLeft;
    const sourceHeight = sourceBottom - sourceTop;
    const destinationWidth = destinationRight - destinationLeft;
    const destinationHeight = destinationBottom - destinationTop;
    if (sourceWidth <= 0 || sourceHeight <= 0 || destinationWidth <= 0 || destinationHeight <= 0) return;
    context.drawImage(
      image,
      sourceLeft,
      sourceTop,
      sourceWidth,
      sourceHeight,
      destinationLeft,
      destinationTop,
      destinationWidth,
      destinationHeight,
    );
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

export function BrowserPane({ paneId, initialUrl, visible, downloadContext, onBrowserDownloadToRemote, onInitialUrlConsumed, onOpenNewPane }: Props) {
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
  const downloadContextRef = useRef(downloadContext);
  const onBrowserDownloadToRemoteRef = useRef(onBrowserDownloadToRemote);
  const [viewReady, setViewReady] = useState(false);
  const [address, setAddress] = useState(visibleAddress(initialUrl));
  const [error, setError] = useState("");
  const [captureImage, setCaptureImage] = useState("");
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState("");
  const [captureNotice, setCaptureNotice] = useState("");
  const [captureSelection, setCaptureSelection] = useState<CaptureSelection | null>(null);
  const captureStageRef = useRef<HTMLDivElement | null>(null);
  const captureImageRef = useRef<HTMLImageElement | null>(null);
  const [capturePreviewSize, setCapturePreviewSize] = useState<CapturePreviewSize | null>(null);
  const selectionStartRef = useRef<{ x: number; y: number } | null>(null);
  const [downloads, setDownloads] = useState<BrowserDownloadItem[]>([]);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [defaultDownloadTarget, setDefaultDownloadTarget] = useState<BrowserDownloadTarget>(readBrowserDownloadTarget);
  const [downloadBusyId, setDownloadBusyId] = useState("");
  const [downloadNotice, setDownloadNotice] = useState("");
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
  downloadContextRef.current = downloadContext;
  onBrowserDownloadToRemoteRef.current = onBrowserDownloadToRemote;

  const applyDownloadEvent = useCallback((payload: BrowserDownloadEvent) => {
    if (payload.paneId !== paneId) return;
    setDownloads((current) => {
      const previous = current.find((item) => item.downloadId === payload.downloadId);
      const status = previous && (previous.status === "completed" || previous.status === "failed")
        && (payload.status === "started" || payload.status === "progress")
        ? previous.status
        : payload.status;
      const next: BrowserDownloadItem = {
        ...previous,
        ...payload,
        status,
        bytesReceived: Math.max(previous?.bytesReceived || 0, payload.bytesReceived || 0),
        totalBytes: payload.totalBytes ?? previous?.totalBytes ?? null,
        deliveryStatus: previous?.deliveryStatus || (status === "failed" ? "failed" : "waiting"),
        ...(payload.error ? { deliveryError: payload.error } : {}),
      };
      const found = current.some((item) => item.downloadId === payload.downloadId);
      return found
        ? current.map((item) => item.downloadId === payload.downloadId ? next : item)
        : [next, ...current];
    });
    if (payload.status === "started") {
      setDownloadsOpen(true);
    }
  }, [paneId]);

  const saveDefaultDownloadTarget = (target: BrowserDownloadTarget) => {
    setDefaultDownloadTarget(target);
    try { localStorage.setItem(BROWSER_DOWNLOAD_TARGET_KEY, JSON.stringify(target)); } catch { /* storage can be disabled by the host */ }
  };

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
    let unlistenDownload: (() => void) | undefined;

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
      unlistenDownload = await listen<BrowserDownloadEvent>(BROWSER_DOWNLOAD_EVENT, ({ payload }) => {
        applyDownloadEvent(payload);
      });
      if (cancelled) {
        unlistenState?.();
        unlistenNewPane?.();
        unlistenDownload?.();
        return;
      }

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
      unlistenDownload?.();
      clearBrowserSnapshot(paneId);
      if (createdRef.current) {
        createdRef.current = false;
        nativeShownRef.current = false;
        void invoke("browser_destroy", { paneId }).catch(() => undefined);
      }
    };
  }, [paneId, readBounds, applyDownloadEvent]);

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
    // The native WebView2 child surface is above the app WebView's DOM. Hide it
    // while the downloads popover is open so this HTML panel can render above
    // the retained page snapshot instead of being covered by the native view.
    const browserVisible = visible && !captureImage && !downloadsOpen;
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
  }, [paneId, viewReady, visible, captureImage, downloadsOpen, scheduleBounds]);

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

  const activeRemoteTarget = (): BrowserDownloadTarget | null => {
    const remote = downloadContextRef.current.remote;
    return remote?.canUpload
      ? { kind: "remote", locationId: remote.locationId, locationName: remote.locationName, path: remote.path }
      : null;
  };

  const destinationLabel = (target: BrowserDownloadTarget) => {
    if (target.kind === "local-current") {
      const folder = downloadContextRef.current.localFolder;
      return `LOCAL · ${folder || "Home"}`;
    }
    if (target.kind === "local-folder") return `LOCAL · ${target.folder}`;
    const remote = downloadContextRef.current.remote;
    if (remote?.locationId === target.locationId) {
      return `Remote API · ${remote.locationName}:${remote.path || "/"}`;
    }
    return `Remote API · ${target.locationName}:${target.path || "/"}`;
  };

  const saveBrowserDownload = async (item: BrowserDownloadItem, target: BrowserDownloadTarget, selectedPath?: string) => {
    if (item.status !== "completed" || downloadBusyId) return;
    setDownloadBusyId(item.downloadId);
    setDownloadNotice("");
    setDownloads((current) => current.map((download) => download.downloadId === item.downloadId
      ? { ...download, deliveryStatus: "saving", deliveryError: undefined }
      : download));
    try {
      if (target.kind === "remote") {
        const remote = downloadContextRef.current.remote;
        if (!remote?.canUpload || remote.locationId !== target.locationId) {
          throw new Error("The selected API Location is no longer active or does not allow uploads. Select the Location again and retry.");
        }
        await onBrowserDownloadToRemoteRef.current({
          downloadId: item.downloadId,
          stagingPath: item.stagingPath,
          fileName: item.fileName,
          locationId: remote.locationId,
          locationName: remote.locationName,
          destinationPath: remote.path,
        });
        setDownloads((current) => current.map((download) => download.downloadId === item.downloadId
          ? { ...download, deliveryStatus: "queued", destinationPath: `${remote.locationName}:${remote.path || "/"}` }
          : download));
        setDownloadNotice(`${item.fileName} was added to the Remote upload queue.`);
        return;
      }

      const destinationFolder = target.kind === "local-folder"
        ? target.folder
        : downloadContextRef.current.localFolder;
      const saved = await invoke<{ path: string; cleanupWarning?: string | null }>("browser_save_download", {
        downloadId: item.downloadId,
        stagingPath: item.stagingPath,
        destinationFolder,
        selectedPath: selectedPath || null,
      });
      setDownloads((current) => current.map((download) => download.downloadId === item.downloadId
        ? { ...download, deliveryStatus: "saved", destinationPath: saved.path }
        : download));
      setDownloadNotice(`Saved ${item.fileName} to ${saved.path}${saved.cleanupWarning ? `. ${saved.cleanupWarning}` : ""}`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setDownloads((current) => current.map((download) => download.downloadId === item.downloadId
        ? { ...download, deliveryStatus: "failed", deliveryError: message }
        : download));
      setDownloadNotice(message);
    } finally {
      setDownloadBusyId("");
    }
  };

  const chooseDefaultLocalFolder = async () => {
    try {
      const folder = await invoke<string | null>("browser_pick_download_folder", {
        initialFolder: defaultDownloadTarget.kind === "local-folder" ? defaultDownloadTarget.folder : null,
      });
      if (folder) saveDefaultDownloadTarget({ kind: "local-folder", folder });
    } catch (reason) {
      setDownloadNotice(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const chooseLocalSavePath = async (item: BrowserDownloadItem) => {
    try {
      const initialFolder = defaultDownloadTarget.kind === "local-folder"
        ? defaultDownloadTarget.folder
        : undefined;
      const selectedPath = await invoke<string | null>("browser_pick_download_file", {
        fileName: item.fileName,
        initialFolder: initialFolder || null,
      });
      if (selectedPath) await saveBrowserDownload(item, { kind: "local-current" }, selectedPath);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setDownloadNotice(message);
    }
  };

  const discardBrowserDownload = async (item: BrowserDownloadItem) => {
    try {
      await invoke("browser_discard_download", { downloadId: item.downloadId, stagingPath: item.stagingPath });
      setDownloads((current) => current.filter((download) => download.downloadId !== item.downloadId));
      setDownloadNotice(`Removed ${item.fileName} from Browser downloads.`);
    } catch (reason) {
      setDownloadNotice(reason instanceof Error ? reason.message : String(reason));
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
    setCapturePreviewSize(null);
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
    const stage = captureStageRef.current;
    const image = captureImageRef.current;
    if (!stage || !image) return undefined;

    const fitPreview = (availableWidth: number, availableHeight: number) => {
      if (availableWidth <= 0 || availableHeight <= 0 || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
      const scale = Math.min(1, availableWidth / image.naturalWidth, availableHeight / image.naturalHeight);
      const next = { width: image.naturalWidth * scale, height: image.naturalHeight * scale };
      setCapturePreviewSize((current) => current
        && Math.abs(current.width - next.width) < 0.5
        && Math.abs(current.height - next.height) < 0.5
        ? current
        : next);
    };
    const updateFromStage = () => {
      const style = window.getComputedStyle(stage);
      const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      const bounds = stage.getBoundingClientRect();
      fitPreview(bounds.width - horizontalPadding, bounds.height - verticalPadding);
    };
    const resizeObserver = new ResizeObserver((entries) => {
      const content = entries[0]?.contentRect;
      if (content) fitPreview(content.width, content.height);
      else updateFromStage();
    });
    resizeObserver.observe(stage);
    image.addEventListener("load", updateFromStage);
    if (image.complete) updateFromStage();
    return () => {
      resizeObserver.disconnect();
      image.removeEventListener("load", updateFromStage);
    };
  }, [captureImage]);

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
          <button
            type="button"
            className="browser-downloads-toggle"
            aria-label="Browser downloads"
            aria-haspopup="dialog"
            aria-controls={`browser-downloads-${paneId}`}
            aria-expanded={downloadsOpen}
            title="Browser downloads"
            onClick={() => setDownloadsOpen((open) => !open)}
          >
            Downloads{downloads.some((item) => item.status === "started" || item.status === "progress") ? " •" : ""}
          </button>
        </div>
        {error && <div className="browser-error" role="alert">{error}</div>}
      </form>
      {downloadsOpen && <section
        id={`browser-downloads-${paneId}`}
        className="browser-downloads-panel"
        role="dialog"
        aria-modal="false"
        aria-label="Browser downloads"
      >
        <header className="browser-downloads-heading">
          <strong>Downloads</strong>
          <button type="button" aria-label="Close downloads" onClick={() => setDownloadsOpen(false)}>×</button>
        </header>
        <div className="browser-download-default">
          <label>
            <span>Default destination</span>
            <select
              value={defaultDownloadTarget.kind}
              onChange={(event) => {
                if (event.currentTarget.value === "local-current") saveDefaultDownloadTarget({ kind: "local-current" });
                if (event.currentTarget.value === "remote") {
                  const remote = activeRemoteTarget();
                  if (remote) saveDefaultDownloadTarget(remote);
                }
              }}
            >
              <option value="local-current">LOCAL · Home/current folder</option>
              {defaultDownloadTarget.kind === "local-folder" && <option value="local-folder">LOCAL · Chosen folder</option>}
              <option value="remote" disabled={!downloadContext.remote?.canUpload}>
                {downloadContext.remote?.canUpload
                  ? `Remote API · ${downloadContext.remote.locationName}`
                  : "Remote API · unavailable"}
              </option>
            </select>
          </label>
          <button type="button" onClick={() => { void chooseDefaultLocalFolder(); }}>Choose local folder…</button>
          {downloadContext.remote?.canUpload && <button type="button" onClick={() => {
            const remote = activeRemoteTarget();
            if (remote) saveDefaultDownloadTarget(remote);
          }}>Use current Remote</button>}
        </div>
        {defaultDownloadTarget.kind === "local-folder" && <div className="browser-download-default-path">{defaultDownloadTarget.folder}</div>}
        {defaultDownloadTarget.kind === "remote" && <div className="browser-download-default-path">{destinationLabel(defaultDownloadTarget)}</div>}
        {downloadNotice && <div className="browser-download-notice" role="status">{downloadNotice}</div>}
        {downloads.length === 0
          ? <div className="browser-download-empty">No browser downloads yet.</div>
          : <div className="browser-download-list">
            {downloads.map((item) => {
              const receiving = item.status === "started" || item.status === "progress";
              const failed = item.status === "failed" || item.deliveryStatus === "failed";
              const remoteAvailable = Boolean(downloadContext.remote?.canUpload);
              const delivered = item.deliveryStatus === "saved" || item.deliveryStatus === "queued";
              const percent = item.totalBytes && item.totalBytes > 0
                ? Math.min(100, Math.floor((item.bytesReceived / item.totalBytes) * 100))
                : null;
              const deliveryText = item.deliveryStatus === "saving" ? "Saving…"
                : item.deliveryStatus === "saved" ? `Saved to ${item.destinationPath || "LOCAL"}`
                : item.deliveryStatus === "queued" ? `Sent to Transfer Queue · ${item.destinationPath || "Remote API"}; check the queue for upload progress and result.`
                : item.deliveryStatus === "failed" ? item.deliveryError || item.error || "Delivery failed. The staged download is retained."
                : item.status === "completed" ? "Downloaded · choose where to save"
                : item.status === "failed" ? item.error || "Browser download failed"
                : "Downloading from website…";
              return <article className="browser-download-item" key={item.downloadId}>
                <div className="browser-download-item-heading">
                  <strong title={item.fileName}>{item.fileName}</strong>
                  <span className={`browser-download-status${failed ? " is-error" : ""}`}>
                    {receiving ? "Downloading" : item.status === "failed" ? "Failed" : item.deliveryStatus === "saved" ? "Saved" : item.deliveryStatus === "queued" ? "Queued" : item.deliveryStatus === "saving" ? "Saving" : "Ready"}
                  </span>
                </div>
                <div className="browser-download-url" title={item.url}>{item.url}</div>
                {(receiving || item.status === "completed") && <div className="browser-download-progress">
                  {item.totalBytes && item.totalBytes > 0
                    ? <progress
                        aria-label={`Download progress for ${item.fileName}`}
                        max={item.totalBytes}
                        value={Math.min(item.bytesReceived, item.totalBytes)}
                      />
                    : receiving && <progress aria-label={`Download progress for ${item.fileName}`} />}
                  <small>{formatDownloadSize(item.bytesReceived)}{item.totalBytes && item.totalBytes > 0 ? ` / ${formatDownloadSize(item.totalBytes)} · ${percent}%` : " received · total size unknown"}</small>
                </div>}
                <div className="browser-download-delivery" role="status">{deliveryText}</div>
                {item.status === "completed" && !delivered && <div className="browser-download-actions">
                  <button type="button" onClick={() => { void saveBrowserDownload(item, defaultDownloadTarget); }} disabled={downloadBusyId === item.downloadId || item.deliveryStatus === "saving"}>
                    {item.deliveryStatus === "saving" ? "Saving…" : `Save to default · ${destinationLabel(defaultDownloadTarget)}`}
                  </button>
                  <button type="button" onClick={() => { void chooseLocalSavePath(item); }} disabled={downloadBusyId === item.downloadId}>Save As…</button>
                  {remoteAvailable && <button type="button" onClick={() => {
                    const remote = activeRemoteTarget();
                    if (remote) void saveBrowserDownload(item, remote);
                  }} disabled={downloadBusyId === item.downloadId}>Send to current Remote</button>}
                </div>}
                {!receiving && !delivered && item.deliveryStatus !== "saving" && <div className="browser-download-actions">
                  <button type="button" className="browser-download-discard" onClick={() => { void discardBrowserDownload(item); }}>Discard staged file</button>
                </div>}
              </article>;
            })}
          </div>}
      </section>}
      <div ref={anchorRef} className="browser-viewport" aria-label="Web page content">
        {!nativeShown && snapshot && <img className="browser-snapshot" src={snapshot.dataUrl} alt="" draggable={false} />}
      </div>
      {captureImage && <div className="browser-capture-layer" role="presentation">
        <section className="browser-capture-dialog" role="dialog" aria-modal="true" aria-labelledby="browser-capture-title">
          <header className="browser-capture-heading">
            <div><strong id="browser-capture-title">Select screenshot area</strong><span>Drag across the full page preview to choose an area.</span></div>
            <button type="button" className="browser-capture-close" aria-label="Close screenshot selection" onClick={closeScreenshot}>×</button>
          </header>
          <div ref={captureStageRef} className="browser-capture-stage">
            <div
              className="browser-capture-preview"
              style={capturePreviewSize
                ? { width: `${capturePreviewSize.width}px`, height: `${capturePreviewSize.height}px` }
                : { visibility: "hidden" }}
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
