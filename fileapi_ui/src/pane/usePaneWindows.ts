import { useCallback, useEffect, useMemo, useReducer } from "react";
import {
  PANE_MIN_SIZE,
  PANE_WINDOW_KINDS,
  STORAGE_KEY,
  clampRect,
  defaultRect,
  loadStoredLayout,
  nextZ,
  pickActive,
  serializeLayout,
  type PaneLayout,
  type PaneRect,
  type PaneSize,
  type PaneWindowKind,
  type PaneWindowState,
} from "./pane-window-model";

type Action =
  | { type: "open"; id: PaneWindowKind; layer: PaneSize }
  | { type: "focus"; id: PaneWindowKind }
  | { type: "minimize"; id: PaneWindowKind }
  | { type: "toggleMaximize"; id: PaneWindowKind }
  | { type: "close"; id: PaneWindowKind }
  | { type: "setRect"; id: PaneWindowKind; rect: PaneRect; layer: PaneSize }
  | { type: "layerResized"; layer: PaneSize }
  | { type: "closeUnavailable"; available: readonly PaneWindowKind[] };

const update = (layout: PaneLayout, id: PaneWindowKind, change: (win: PaneWindowState) => PaneWindowState): PaneWindowState[] =>
  layout.windows.map((win) => (win.id === id ? change(win) : win));

const withActive = (windows: PaneWindowState[]): PaneLayout => ({ windows, activeId: pickActive(windows) });

export function paneReducer(layout: PaneLayout, action: Action): PaneLayout {
  switch (action.type) {
    case "open": {
      const existing = layout.windows.find((win) => win.id === action.id);
      const z = nextZ(layout.windows);
      if (existing) {
        // Opening an already-open window must behave like a taskbar click:
        // restore if minimized, otherwise just bring it to the front.
        return withActive(update(layout, action.id, (win) => ({ ...win, open: true, minimized: false, z })));
      }
      const openCount = layout.windows.filter((win) => win.open).length;
      const rect = defaultRect(action.id, action.layer, openCount);
      return withActive([...layout.windows, { id: action.id, ...rect, open: true, minimized: false, maximized: false, z }]);
    }
    case "focus": {
      const target = layout.windows.find((win) => win.id === action.id);
      if (!target || !target.open || target.minimized) return layout;
      if (layout.activeId === action.id && target.z === nextZ(layout.windows) - 1) return layout;
      const z = nextZ(layout.windows);
      return withActive(update(layout, action.id, (win) => ({ ...win, z })));
    }
    case "minimize":
      return withActive(update(layout, action.id, (win) => ({ ...win, minimized: true })));
    case "toggleMaximize": {
      const z = nextZ(layout.windows);
      return withActive(update(layout, action.id, (win) => ({ ...win, maximized: !win.maximized, minimized: false, z })));
    }
    case "close":
      return withActive(update(layout, action.id, (win) => ({ ...win, open: false, minimized: false })));
    case "setRect":
      return {
        ...layout,
        windows: update(layout, action.id, (win) => ({ ...win, ...clampRect(action.rect, action.layer, PANE_MIN_SIZE[win.id]) })),
      };
    case "layerResized": {
      if (action.layer.w <= 0 || action.layer.h <= 0) return layout;
      let changed = false;
      const windows = layout.windows.map((win) => {
        const next = clampRect(win, action.layer, PANE_MIN_SIZE[win.id]);
        if (next.x === win.x && next.y === win.y && next.w === win.w && next.h === win.h) return win;
        changed = true;
        return { ...win, ...next };
      });
      return changed ? { ...layout, windows } : layout;
    }
    case "closeUnavailable": {
      let changed = false;
      const windows = layout.windows.map((win) => {
        if (!win.open || action.available.includes(win.id)) return win;
        changed = true;
        return { ...win, open: false, minimized: false };
      });
      return changed ? withActive(windows) : layout;
    }
    default:
      return layout;
  }
}

const initialLayout = (): PaneLayout => loadStoredLayout() || { windows: [], activeId: null };

export function usePaneWindows(available: readonly PaneWindowKind[], layer: PaneSize) {
  const [layout, dispatch] = useReducer(paneReducer, undefined, initialLayout);

  // Persist geometry and open/minimized/maximized flags.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, serializeLayout(layout));
    } catch {
      /* storage may be full or unavailable; the layout then simply is not restored */
    }
  }, [layout]);

  useEffect(() => {
    dispatch({ type: "layerResized", layer });
  }, [layer.w, layer.h]);

  const availableKey = available.join(",");
  useEffect(() => {
    dispatch({ type: "closeUnavailable", available });
  }, [availableKey]);

  const open = useCallback((id: PaneWindowKind) => dispatch({ type: "open", id, layer }), [layer.w, layer.h]);
  const focus = useCallback((id: PaneWindowKind) => dispatch({ type: "focus", id }), []);
  const minimize = useCallback((id: PaneWindowKind) => dispatch({ type: "minimize", id }), []);
  const toggleMaximize = useCallback((id: PaneWindowKind) => dispatch({ type: "toggleMaximize", id }), []);
  const close = useCallback((id: PaneWindowKind) => dispatch({ type: "close", id }), []);
  const setRect = useCallback((id: PaneWindowKind, rect: PaneRect) => dispatch({ type: "setRect", id, rect, layer }), [layer.w, layer.h]);

  return useMemo(
    () => ({ layout, open, focus, minimize, toggleMaximize, close, setRect }),
    [layout, open, focus, minimize, toggleMaximize, close, setRect],
  );
}

export { PANE_WINDOW_KINDS };
