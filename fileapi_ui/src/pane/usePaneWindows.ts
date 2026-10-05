import { useCallback, useEffect, useMemo, useReducer } from "react";
import {
  PANE_WINDOW_KINDS,
  STORAGE_KEY,
  clampRect,
  defaultRect,
  isEntryWindow,
  kindOf,
  loadStoredLayout,
  minSizeOf,
  nextZ,
  pickActive,
  serializeLayout,
  type PaneLayout,
  type PaneRect,
  type PaneSize,
  type PaneWindowId,
  type PaneWindowState,
} from "./pane-window-model";

type Action =
  | { type: "open"; id: PaneWindowId; layer: PaneSize }
  | { type: "focus"; id: PaneWindowId }
  | { type: "minimize"; id: PaneWindowId }
  | { type: "toggleMaximize"; id: PaneWindowId }
  | { type: "close"; id: PaneWindowId }
  | { type: "setRect"; id: PaneWindowId; rect: PaneRect; layer: PaneSize }
  | { type: "layerResized"; layer: PaneSize }
  | { type: "closeUnavailable"; available: readonly PaneWindowId[] };

const update = (layout: PaneLayout, id: PaneWindowId, change: (win: PaneWindowState) => PaneWindowState): PaneWindowState[] =>
  layout.windows.map((win) => (win.id === id ? change(win) : win));

const withActive = (windows: PaneWindowState[]): PaneLayout => ({ windows, activeId: pickActive(windows) });

export function paneReducer(layout: PaneLayout, action: Action): PaneLayout {
  switch (action.type) {
    case "open": {
      const kind = kindOf(action.id);
      if (!kind) return layout;
      const existing = layout.windows.find((win) => win.id === action.id);
      const z = nextZ(layout.windows);
      if (existing) {
        // Opening an already-open window must behave like a taskbar click:
        // restore if minimized, otherwise just bring it to the front.
        return withActive(update(layout, action.id, (win) => ({ ...win, open: true, minimized: false, z })));
      }
      const openCount = layout.windows.filter((win) => win.open).length;
      const rect = defaultRect(kind, action.layer, openCount);
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
      // An SFTP or SSH window belongs to one live connection, so closing it discards it
      // (its body unmounts and disconnects); other kinds keep their geometry.
      if (isEntryWindow(action.id)) return withActive(layout.windows.filter((win) => win.id !== action.id));
      return withActive(update(layout, action.id, (win) => ({ ...win, open: false, minimized: false })));
    case "setRect":
      return {
        ...layout,
        windows: update(layout, action.id, (win) => ({ ...win, ...clampRect(action.rect, action.layer, minSizeOf(win.id)) })),
      };
    case "layerResized": {
      if (action.layer.w <= 0 || action.layer.h <= 0) return layout;
      let changed = false;
      const windows = layout.windows.map((win) => {
        const next = clampRect(win, action.layer, minSizeOf(win.id));
        if (next.x === win.x && next.y === win.y && next.w === win.w && next.h === win.h) return win;
        changed = true;
        return { ...win, ...next };
      });
      return changed ? { ...layout, windows } : layout;
    }
    case "closeUnavailable": {
      let changed = false;
      const windows: PaneWindowState[] = [];
      for (const win of layout.windows) {
        if (action.available.includes(win.id)) { windows.push(win); continue; }
        // An unavailable SFTP/SSH window (its SSH entry was removed) is dropped; other kinds are just closed.
        if (isEntryWindow(win.id)) { changed = true; continue; }
        if (!win.open) { windows.push(win); continue; }
        changed = true;
        windows.push({ ...win, open: false, minimized: false });
      }
      return changed ? withActive(windows) : layout;
    }
    default:
      return layout;
  }
}

const initialLayout = (): PaneLayout => loadStoredLayout() || { windows: [], activeId: null };

export function usePaneWindows(available: readonly PaneWindowId[], layer: PaneSize) {

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

  const open = useCallback((id: PaneWindowId) => dispatch({ type: "open", id, layer }), [layer.w, layer.h]);
  const focus = useCallback((id: PaneWindowId) => dispatch({ type: "focus", id }), []);
  const minimize = useCallback((id: PaneWindowId) => dispatch({ type: "minimize", id }), []);
  const toggleMaximize = useCallback((id: PaneWindowId) => dispatch({ type: "toggleMaximize", id }), []);
  const close = useCallback((id: PaneWindowId) => dispatch({ type: "close", id }), []);
  const setRect = useCallback((id: PaneWindowId, rect: PaneRect) => dispatch({ type: "setRect", id, rect, layer }), [layer.w, layer.h]);

  return useMemo(
    () => ({ layout, open, focus, minimize, toggleMaximize, close, setRect }),
    [layout, open, focus, minimize, toggleMaximize, close, setRect],
  );
}

export { PANE_WINDOW_KINDS };
