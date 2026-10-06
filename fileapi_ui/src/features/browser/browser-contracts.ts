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
  x: number;
  y: number;
  width: number;
  height: number;
};
