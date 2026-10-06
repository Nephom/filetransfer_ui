import type { PaneBrowserWindowId } from "../../pane/pane-window-model";

export const BROWSER_VIEW_STATE_EVENT = "browser-view-state";
export const BROWSER_NEW_PANE_EVENT = "browser-new-pane";

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
