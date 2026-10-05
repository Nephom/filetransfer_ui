import React, { useEffect, useRef, useState } from "react";
import type { PaneLayout, PaneWindowId, PaneWindowKind } from "./pane-window-model";
import { PANE_SINGLETON_KINDS, kindOf } from "./pane-window-model";
import type { SshPopupInfo } from "./ssh-popup-registry";
import { ExternalWindowIcon, FunctionsIcon, LocalIcon, LocationIcon, RemoteIcon, RestIcon, SftpIcon, TerminalIcon, VncIcon } from "./pane-icons";

export type PaneLocationChoice = {
  id: string;
  label: string;
  detail?: string;
  /** false renders the entry disabled with `disabledReason` as the hint. */
  available: boolean;
  disabledReason?: string;
  selected: boolean;
};

type Props = {
  layout: PaneLayout;
  /** Window titles by window id. */
  titles: Record<string, string>;
  restEnabled: boolean;
  vncEnabled: boolean;
  remoteChoices: PaneLocationChoice[];
  sftpChoices: PaneLocationChoice[];
  popups: readonly SshPopupInfo[];
  busy: boolean;
  onOpenLocal: () => void;
  onOpenRemote: (locationId: string) => void;
  onOpenSftp: (entryId: string) => void;
  /** Open / restore / minimize toggle for a window (also used by taskbar tabs). */
  onActivate: (id: PaneWindowId) => void;
  onCloseWindow: (id: PaneWindowId) => void;
  onFocusPopup: (label: string) => void;
  onClosePopup: (label: string) => void;
};

const KIND_ICON: Record<PaneWindowKind, React.ReactNode> = {
  local: <LocalIcon size={18} />,
  remote: <RemoteIcon size={18} />,
  vnc: <VncIcon size={18} />,
  rest: <RestIcon size={18} />,
  terminal: <TerminalIcon size={18} />,
  sftp: <SftpIcon size={18} />,
};

export function PaneDock({
  layout, titles, restEnabled, vncEnabled, remoteChoices, sftpChoices, popups, busy,
  onOpenLocal, onOpenRemote, onOpenSftp, onActivate, onCloseWindow, onFocusPopup, onClosePopup,
}: Props) {
  const [functionsOpen, setFunctionsOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const closeMenus = () => { setFunctionsOpen(false); setLocationOpen(false); };

  useEffect(() => {
    if (!functionsOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape peels one layer: the Location list first, then the flyout.
      event.stopPropagation();
      if (locationOpen) setLocationOpen(false);
      else setFunctionsOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [functionsOpen, locationOpen]);

  const windowOf = (id: PaneWindowId) => layout.windows.find((win) => win.id === id);
  const isOpen = (id: PaneWindowId) => Boolean(windowOf(id)?.open);
  const anySftpOpen = layout.windows.some((win) => win.open && kindOf(win.id) === "sftp");

  const flyoutItems: { key: string; label: string; icon: React.ReactNode; open: boolean; onClick: () => void; hasMenu?: boolean; expanded?: boolean }[] = [
    {
      key: "location",
      label: "Location",
      icon: <LocationIcon size={26} />,
      open: isOpen("local") || isOpen("remote") || anySftpOpen,
      hasMenu: true,
      expanded: locationOpen,
      onClick: () => setLocationOpen((value) => !value),
    },
    ...(vncEnabled ? [{ key: "vnc", label: "VNC", icon: <VncIcon size={26} />, open: isOpen("vnc"), onClick: () => { onActivate("vnc"); closeMenus(); } }] : []),
    ...(restEnabled ? [{ key: "rest", label: "RestAPI", icon: <RestIcon size={26} />, open: isOpen("rest"), onClick: () => { onActivate("rest"); closeMenus(); } }] : []),
  ];

  const chooseRemote = (choice: PaneLocationChoice) => { onOpenRemote(choice.id); closeMenus(); };
  const chooseSftp = (choice: PaneLocationChoice) => { onOpenSftp(choice.id); closeMenus(); };

  const renderChoices = (choices: PaneLocationChoice[], onChoose: (choice: PaneLocationChoice) => void, empty: string) =>
    choices.length === 0
      ? <p className="pane-menu-empty">{empty}</p>
      : choices.map((choice) => (
        <button
          key={choice.id}
          type="button"
          role="menuitem"
          className={`pane-menu-item${choice.selected ? " is-current" : ""}`}
          disabled={!choice.available || busy}
          title={choice.available ? choice.detail : choice.disabledReason}
          onClick={() => onChoose(choice)}
        >
          <span className={`pane-status-dot${choice.available ? " is-online" : ""}`} aria-hidden="true" />
          <span className="pane-menu-text">
            <strong>{choice.label}</strong>
            <small>{choice.available ? choice.detail || "" : choice.disabledReason}</small>
          </span>
        </button>
      ));

  // Singleton windows keep a fixed order; SFTP windows follow in the order they were opened.
  const taskbarIds: PaneWindowId[] = [
    ...PANE_SINGLETON_KINDS.filter(isOpen),
    ...layout.windows.filter((win) => win.open && kindOf(win.id) === "sftp").map((win) => win.id),
  ];

  return (
    <nav className="pane-dock" aria-label="Desktop dock">
      <div className="pane-dock-launchers" ref={rootRef}>
        <div className="pane-functions">
          <div className={`pane-flyout${functionsOpen ? " is-open" : ""}`} role="menu" aria-label="Functions" aria-hidden={!functionsOpen}>
            {flyoutItems.map((item, index) => (
              <div className="pane-flyout-slot" key={item.key} style={{ "--i": index } as React.CSSProperties}>
                <button
                  type="button"
                  role="menuitem"
                  className={`pane-dock-button pane-flyout-button${item.open ? " is-open" : ""}${item.expanded ? " is-expanded" : ""}`}
                  tabIndex={functionsOpen ? 0 : -1}
                  aria-haspopup={item.hasMenu ? "menu" : undefined}
                  aria-expanded={item.hasMenu ? item.expanded : undefined}
                  onClick={item.onClick}
                >
                  <span className="pane-dock-icon">{item.icon}</span>
                  <span className="pane-dock-label">{item.label}</span>
                </button>
                {item.key === "location" && locationOpen && (
                  <div className="pane-location-menu" role="menu" aria-label="Location">
                    <button type="button" role="menuitem" className="pane-menu-item" onClick={() => { onOpenLocal(); closeMenus(); }}>
                      <span className="pane-menu-icon"><LocalIcon size={18} /></span>
                      <span className="pane-menu-text"><strong>Local</strong><small>This computer</small></span>
                    </button>
                    <div className="pane-menu-heading"><RemoteIcon size={14} /> Remote</div>
                    {renderChoices(remoteChoices, chooseRemote, "No remote locations")}
                    <div className="pane-menu-heading"><SftpIcon size={14} /> SFTP</div>
                    {renderChoices(sftpChoices, chooseSftp, "No SSH entries in the Workspace Manager")}
                  </div>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            className={`pane-dock-button pane-functions-button${functionsOpen ? " is-expanded" : ""}`}
            aria-haspopup="menu"
            aria-expanded={functionsOpen}
            onClick={() => { setFunctionsOpen((value) => !value); setLocationOpen(false); }}
          >
            <span className="pane-dock-icon"><FunctionsIcon size={26} /></span>
            <span className="pane-dock-label">Functions</span>
          </button>
        </div>
        <button
          type="button"
          className={`pane-dock-button${isOpen("terminal") ? " is-open" : ""}`}
          onClick={() => { onActivate("terminal"); closeMenus(); }}
        >
          <span className="pane-dock-icon"><TerminalIcon size={26} /></span>
          <span className="pane-dock-label">Terminal</span>
        </button>
      </div>

      <div className="pane-taskbar" role="tablist" aria-label="Open windows">
        {taskbarIds.length === 0 && popups.length === 0 && <span className="pane-taskbar-empty">No open windows</span>}
        {taskbarIds.map((id) => {
          const win = windowOf(id)!;
          const active = layout.activeId === id;
          const title = titles[id] || id;
          return (
            <span key={id} className={`pane-task${active ? " is-active" : ""}${win.minimized ? " is-minimized" : ""}`}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="pane-task-main"
                title={win.minimized ? `Restore ${title}` : active ? `Minimize ${title}` : `Show ${title}`}
                onClick={() => onActivate(id)}
              >
                {KIND_ICON[kindOf(id) || "local"]}
                <span className="pane-task-title">{title}</span>
              </button>
              <button type="button" className="pane-task-close" aria-label={`Close ${title}`} onClick={() => onCloseWindow(id)}>×</button>
            </span>
          );
        })}
        {popups.map((popup) => (
          <span key={popup.label} className="pane-task is-external">
            <button type="button" role="tab" aria-selected={false} className="pane-task-main" title={`${popup.title} (separate window) - click to bring to front`} onClick={() => onFocusPopup(popup.label)}>
              <ExternalWindowIcon size={18} />
              <span className={`pane-status-dot${popup.connected ? " is-online" : ""}`} aria-hidden="true" />
              <span className="pane-task-title">{popup.title}</span>
              {popup.recordingUnsaved && <span className="pane-task-rec" title="Unsaved recording">REC</span>}
            </button>
            <button type="button" className="pane-task-close" aria-label={`Close ${popup.title}`} onClick={() => onClosePopup(popup.label)}>×</button>
          </span>
        ))}
      </div>
    </nav>
  );
}
