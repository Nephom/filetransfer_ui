import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PaneDock, type PaneLocationChoice, type PaneTerminalWorkspace } from "./PaneDock";
import type { LocalTerminalKind } from "../features/terminal/terminal-contracts";
import { PaneWindow } from "./PaneWindow";
import { usePaneWindows } from "./usePaneWindows";
import { PANE_SINGLETON_KINDS, kindOf, sftpWindowId, type PaneWindowId, type PaneWindowKind } from "./pane-window-model";
import { LocalIcon, RemoteIcon, RestIcon, SftpIcon, TerminalIcon, VncIcon } from "./pane-icons";
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

/** Marks the content of one window (by window id); PaneDesktop places it inside that window's frame. */
export function PaneBody({ children }: { id: PaneWindowId; children: React.ReactNode }) {
  return <>{children}</>;
}

type Props = {
  restEnabled: boolean;
  vncEnabled: boolean;
  /** One <PaneBody id=...> child per window. The elements keep their identity while a window is dragged, so dragging never re-renders their contents. */
  children: React.ReactNode;
  /** Window titles / subtitles by window id (`local`, `remote`, ..., `sftp:<entryId>`). */
  titles: Record<string, string>;
  subtitles: Partial<Record<string, string>>;
  remoteChoices: PaneLocationChoice[];
  sftpChoices: PaneLocationChoice[];
  /** Every Workspace with its SSH entries (Terminal menu in the dock). */
  terminalWorkspaces: PaneTerminalWorkspace[];
  /** Windows Terminal / Command Prompt can only be launched on Windows. */
  localShellsAvailable: boolean;
  /** SSH entries that still exist; an open SFTP window whose entry is gone is dropped. */
  sftpEntryIds: readonly string[];
  busy: boolean;
  /** Pills in the top-right corner (queue, account, ...). */
  topRight: React.ReactNode;
  onSelectRemote: (locationId: string) => void;
  onOpenLocalShell: (kind: LocalTerminalKind) => void;
  /** Connect the entry inside the main window's Terminal pane (the pane is opened first). */
  onOpenSshInPane: (workspaceId: string, entryId: string) => void;
  /** Connect the entry in its own native window. */
  onOpenSshWindow: (workspaceId: string, entryId: string) => void;
  onOpenEntryManager: (workspaceId?: string) => void;
  onCreateWorkspace: () => void;
  /** Receives the "open this window" function so the app can open windows (e.g. from the Workspace Manager). */
  openRef: React.MutableRefObject<(id: PaneWindowId) => void>;
  /** Called when the set of open windows or the focused window changes. */
  onWindowState: (openIds: PaneWindowId[], activeId: PaneWindowId | null) => void;
  /** Resolves true when the user agrees to close the app although SSH windows hold unsaved recordings. */
  confirmDiscardRecordings: () => Promise<boolean>;
};

const KIND_ICON: Record<PaneWindowKind, React.ReactNode> = {
  local: <LocalIcon size={16} />,
  remote: <RemoteIcon size={16} />,
  vnc: <VncIcon size={16} />,
  rest: <RestIcon size={16} />,
  terminal: <TerminalIcon size={16} />,
  sftp: <SftpIcon size={16} />,
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
  restEnabled, vncEnabled, openRef, children, titles, subtitles, remoteChoices, sftpChoices, terminalWorkspaces, localShellsAvailable, sftpEntryIds, busy, topRight,
  onSelectRemote, onOpenLocalShell, onOpenSshInPane, onOpenSshWindow, onOpenEntryManager, onCreateWorkspace, onWindowState, confirmDiscardRecordings,
}: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [layer, setLayer] = useState({ w: 0, h: 0 });
  const available: PaneWindowId[] = [
    ...PANE_SINGLETON_KINDS.filter((kind) => (kind === "vnc" ? vncEnabled : kind === "rest" ? restEnabled : true)),
    ...sftpEntryIds.map(sftpWindowId),
  ];
  const { layout, open, focus, minimize, toggleMaximize, close, setRect } = usePaneWindows(available, layer);
  const bodies: Partial<Record<string, React.ReactNode>> = {};
  React.Children.forEach(children, (child) => {
    if (React.isValidElement<{ id: PaneWindowId; children: React.ReactNode }>(child)) bodies[child.props.id] = child.props.children;
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

  const openIds = layout.windows.filter((win) => win.open).map((win) => win.id);
  const openKey = openIds.join(",");
  useEffect(() => {
    onWindowState(openIds, layout.activeId);
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

  const activate = useCallback((id: PaneWindowId) => {
    const win = layout.windows.find((item) => item.id === id);
    // Taskbar semantics: clicking the focused window minimizes it, anything else brings it forward.
    if (win && win.open && !win.minimized && layout.activeId === id) minimize(id);
    else open(id);
  }, [layout, minimize, open]);

  return (
    <div className="pane-desktop">
      <Wallpaper />
      <div className="pane-topbar">
        <span className="pane-brand"><span className="app-mark" aria-hidden="true" />nFterm</span>
        <div className="pane-topright">{topRight}</div>
      </div>
      <div className="pane-window-layer" ref={layerRef}>
        {layout.windows.map((win) => {
          const kind = kindOf(win.id);
          if (!kind || !available.includes(win.id)) return null;
          return (
            <PaneWindow
              key={win.id}
              win={win}
              title={titles[win.id] || win.id}
              subtitle={subtitles[win.id]}
              icon={KIND_ICON[kind]}
              active={layout.activeId === win.id}
              layer={layer}
              keepMounted={KEEP_MOUNTED[kind]}
              onFocus={() => focus(win.id)}
              onMinimize={() => minimize(win.id)}
              onToggleMaximize={() => toggleMaximize(win.id)}
              onClose={() => close(win.id)}
              onRect={(rect) => setRect(win.id, rect)}
            >
              {bodies[win.id]}
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
        terminalWorkspaces={terminalWorkspaces}
        localShellsAvailable={localShellsAvailable}
        popups={popups}
        busy={busy}
        onOpenLocal={() => open("local")}
        onOpenLocalShell={onOpenLocalShell}
        onOpenSshInPane={(workspaceId, entryId) => { open("terminal"); onOpenSshInPane(workspaceId, entryId); }}
        onOpenSshWindow={onOpenSshWindow}
        onOpenEntryManager={onOpenEntryManager}
        onCreateWorkspace={onCreateWorkspace}
        onOpenRemote={(id) => { onSelectRemote(id); open("remote"); }}
        onOpenSftp={(entryId) => open(sftpWindowId(entryId))}
        onActivate={activate}
        onCloseWindow={close}
        onFocusPopup={(label) => { void focusSshPopup(label).catch(() => undefined); }}
        onClosePopup={(label) => { void closeSshPopup(label).catch(() => undefined); }}
      />
    </div>
  );
}
