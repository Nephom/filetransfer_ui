import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PaneDock, type PaneLocationChoice } from "./PaneDock";
import { PaneWindow } from "./PaneWindow";
import { usePaneWindows } from "./usePaneWindows";
import { PANE_WINDOW_KINDS, type PaneWindowKind } from "./pane-window-model";
import { LocalIcon, RemoteIcon, RestIcon, TerminalIcon, VncIcon } from "./pane-icons";
import { loadWallpaper, useWallpaper, wallpaperCssVariables } from "./pane-wallpaper-store";
import {
  closeAllSshPopups,
  closeSshPopup,
  focusSshPopup,
  getSshPopupSnapshot,
  hasUnsavedSshPopupRecording,
  reconcileSshPopups,
  startSshPopupBridge,
  subscribeSshPopups,
} from "./ssh-popup-registry";

/** Marks the content of one window; PaneDesktop places it inside that window's frame. */
export function PaneBody({ children }: { kind: PaneWindowKind; children: React.ReactNode }) {
  return <>{children}</>;
}

type Props = {
  restEnabled: boolean;
  vncEnabled: boolean;
  /** One <PaneBody kind=...> child per window. The elements keep their identity while a window is dragged, so dragging never re-renders their contents. */
  children: React.ReactNode;
  titles: Record<PaneWindowKind, string>;
  subtitles: Partial<Record<PaneWindowKind, string>>;
  remoteChoices: PaneLocationChoice[];
  sftpChoices: PaneLocationChoice[];
  busy: boolean;
  /** Pills in the top-right corner (queue, account, ...). */
  topRight: React.ReactNode;
  onSelectRemote: (locationId: string) => void;
  onSelectSftp: (entryId: string) => void;
  /** Receives the "open this window" function so the app can open windows (e.g. from the Workspace Manager). */
  openRef: React.MutableRefObject<(kind: PaneWindowKind) => void>;
  /** Called when the set of open windows or the focused window changes. */
  onWindowState: (openKinds: PaneWindowKind[], activeId: PaneWindowKind | null) => void;
  /** Resolves true when the user agrees to close the app although SSH windows hold unsaved recordings. */
  confirmDiscardRecordings: () => Promise<boolean>;
};

const KIND_ICON: Record<PaneWindowKind, React.ReactNode> = {
  local: <LocalIcon size={16} />,
  remote: <RemoteIcon size={16} />,
  vnc: <VncIcon size={16} />,
  rest: <RestIcon size={16} />,
  terminal: <TerminalIcon size={16} />,
};

const KEEP_MOUNTED: Partial<Record<PaneWindowKind, boolean>> = { terminal: true };

function Wallpaper() {
  const { config, imageUrl } = useWallpaper();
  useEffect(() => { void loadWallpaper(); }, []);
  const style = wallpaperCssVariables(config, imageUrl) as React.CSSProperties;
  return (
    <div className={`pane-wallpaper${imageUrl ? " has-image" : ""}`} style={style} aria-hidden="true">
      <div className="pane-wallpaper-image" />
    </div>
  );
}

export function PaneDesktop({
  restEnabled, vncEnabled, openRef, children, titles, subtitles, remoteChoices, sftpChoices, busy, topRight,
  onSelectRemote, onSelectSftp, onWindowState, confirmDiscardRecordings,
}: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [layer, setLayer] = useState({ w: 0, h: 0 });
  const available: PaneWindowKind[] = PANE_WINDOW_KINDS.filter((kind) => (kind === "vnc" ? vncEnabled : kind === "rest" ? restEnabled : true));
  const { layout, open, focus, minimize, toggleMaximize, close, setRect } = usePaneWindows(available, layer);
  const bodies: Partial<Record<PaneWindowKind, React.ReactNode>> = {};
  React.Children.forEach(children, (child) => {
    if (React.isValidElement<{ kind: PaneWindowKind; children: React.ReactNode }>(child)) bodies[child.props.kind] = child.props.children;
  });
  const popups = useSyncExternalStore(subscribeSshPopups, getSshPopupSnapshot, getSshPopupSnapshot);

  useEffect(() => {
    const element = layerRef.current;
    if (!element) return undefined;
    const measure = () => setLayer((current) => {
      const next = { w: Math.round(element.clientWidth), h: Math.round(element.clientHeight) };
      return current.w === next.w && current.h === next.h ? current : next;
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  openRef.current = open;

  // First launch (nothing stored): start with Local and Remote side by side.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || layer.w <= 0 || layer.h <= 0) return;
    seededRef.current = true;
    if (layout.windows.length === 0) {
      open("local");
      open("remote");
    }
  }, [layer.w, layer.h, layout.windows.length, open]);

  const openKinds = layout.windows.filter((win) => win.open).map((win) => win.id);
  const openKey = openKinds.join(",");
  useEffect(() => {
    onWindowState(openKinds, layout.activeId);
  }, [openKey, layout.activeId]);

  // Native SSH popup windows: track, reconcile, and report their state.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void startSshPopupBridge().then((dispose) => { if (disposed) dispose(); else unlisten = dispose; }).catch(() => undefined);
    void reconcileSshPopups().catch(() => undefined);
    const onFocusEvent = () => { void reconcileSshPopups().catch(() => undefined); };
    window.addEventListener("focus", onFocusEvent);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("focus", onFocusEvent);
    };
  }, []);

  // Closing the main window closes every SSH popup first (asking once when a
  // recording would be lost) so no orphaned native window keeps running.
  const confirmRef = useRef(confirmDiscardRecordings);
  confirmRef.current = confirmDiscardRecordings;
  useEffect(() => {
    const current = getCurrentWebviewWindow();
    const unlisten = current.onCloseRequested(async (event) => {
      if (getSshPopupSnapshot().length === 0) return;
      event.preventDefault();
      if (hasUnsavedSshPopupRecording() && !(await confirmRef.current())) return;
      await closeAllSshPopups(true);
      await current.destroy();
    });
    return () => { void unlisten.then((dispose) => dispose()); };
  }, []);

  const activate = useCallback((kind: PaneWindowKind) => {
    const win = layout.windows.find((item) => item.id === kind);
    // Taskbar semantics: clicking the focused window minimizes it, anything else brings it forward.
    if (win && win.open && !win.minimized && layout.activeId === kind) minimize(kind);
    else open(kind);
  }, [layout, minimize, open]);

  return (
    <div className="pane-desktop">
      <Wallpaper />
      <div className="pane-topbar">
        <span className="pane-brand"><span className="app-mark" aria-hidden="true" />nFterm</span>
        <div className="pane-topright">{topRight}</div>
      </div>
      <div className="pane-window-layer" ref={layerRef}>
        {PANE_WINDOW_KINDS.map((kind) => {
          const win = layout.windows.find((item) => item.id === kind);
          if (!win || !available.includes(kind)) return null;
          return (
            <PaneWindow
              key={kind}
              win={win}
              title={titles[kind]}
              subtitle={subtitles[kind]}
              icon={KIND_ICON[kind]}
              active={layout.activeId === kind}
              layer={layer}
              keepMounted={KEEP_MOUNTED[kind]}
              onFocus={() => focus(kind)}
              onMinimize={() => minimize(kind)}
              onToggleMaximize={() => toggleMaximize(kind)}
              onClose={() => close(kind)}
              onRect={(rect) => setRect(kind, rect)}
            >
              {bodies[kind]}
            </PaneWindow>
          );
        })}
      </div>
      <PaneDock
        layout={layout}
        titles={titles}
        restEnabled={restEnabled}
        vncEnabled={vncEnabled}
        remoteChoices={remoteChoices}
        sftpChoices={sftpChoices}
        popups={popups}
        busy={busy}
        onOpenLocal={() => open("local")}
        onOpenRemote={(id) => { onSelectRemote(id); open("remote"); }}
        onOpenSftp={(id) => { onSelectSftp(id); open("remote"); }}
        onActivate={activate}
        onCloseWindow={close}
        onFocusPopup={(label) => { void focusSshPopup(label).catch(() => undefined); }}
        onClosePopup={(label) => { void closeSshPopup(label).catch(() => undefined); }}
      />
    </div>
  );
}
