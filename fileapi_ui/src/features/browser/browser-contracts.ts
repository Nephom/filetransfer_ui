import type { PaneBrowserWindowId } from "../../pane/pane-window-model";

export const BROWSER_VIEW_STATE_EVENT = "browser-view-state";
export const BROWSER_NEW_PANE_EVENT = "browser-new-pane";
export const BROWSER_DOWNLOAD_EVENT = "browser-download";

export type BrowserViewStateEvent = {
  paneId: PaneBrowserWindowId;
  url: string;
  loading: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
};

export type BrowserNewPaneEvent = {
  paneId: PaneBrowserWindowId;
  url: string;
};

export type BrowserDownloadEvent = {
  paneId: PaneBrowserWindowId;
  downloadId: string;
  url: string;
  fileName: string;
  stagingPath: string;
  status: "started" | "progress" | "completed" | "failed";
  bytesReceived: number;
  totalBytes: number | null;
  error?: string;
};

export type BrowserDownloadTarget =
  | { kind: "local-current" }
  | { kind: "local-folder"; folder: string }
  | { kind: "remote"; locationId: string; locationName: string; path: string };

export type BrowserDownloadForRemote = {
  downloadId: string;
  stagingPath: string;
  fileName: string;
  locationId: string;
  locationName: string;
  destinationPath: string;
};

export type BrowserNavigationState = {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type BrowserBounds = {
  /** CSS pixels relative to the main WebView's viewport. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Physical pixels per CSS pixel in the main WebView (125% display = 1.25). */
  devicePixelRatio: number;
};

/** Physical child-WebView bounds relative to the native parent window client area. */
export type BrowserPhysicalBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserBoundsReadback = {
  requested: BrowserPhysicalBounds;
  actual: BrowserPhysicalBounds;
};
