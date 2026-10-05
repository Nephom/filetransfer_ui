import React, { useEffect, useRef, useState } from "react";
import type { PaneLayout, PaneWindowId, PaneWindowKind } from "./pane-window-model";
import { PANE_SINGLETON_KINDS, isEntryWindow, kindOf, sshPaneEntryIdOf } from "./pane-window-model";
import type { SshPopupInfo } from "./ssh-popup-registry";
import { EntryManagerIcon, ExternalWindowIcon, FunctionsIcon, LocalIcon, LocationIcon, RemoteIcon, RestIcon, SftpIcon, SshEntriesIcon, TerminalIcon, VncIcon } from "./pane-icons";
import { CommandPromptIcon, WindowsTerminalIcon } from "../ui/icons";
import type { LocalTerminalKind } from "../features/terminal/terminal-contracts";

export type PaneLocationChoice = {
  id: string;
  label: string;
  detail?: string;
  /** false renders the entry disabled with `disabledReason` as the hint. */
  available: boolean;
  disabledReason?: string;
  selected: boolean;
};

export type PaneTerminalEntry = {
  entryId: string;
  label: string;
  detail: string;
  connected: boolean;
};

export type PaneTerminalWorkspace = {
  id: string;
  name: string;
  entries: PaneTerminalEntry[];
};

type Props = {
  layout: PaneLayout;
  /** Window titles by window id. */
  titles: Record<string, string>;
  restEnabled: boolean;
  vncEnabled: boolean;
  remoteChoices: PaneLocationChoice[];
  sftpChoices: PaneLocationChoice[];
  /** Every Workspace (also the ones without SSH entries) with its SSH entries. */
  terminalWorkspaces: PaneTerminalWorkspace[];
  /** Windows Terminal / Command Prompt can only be launched on Windows. */
  localShellsAvailable: boolean;
  /** Live state of each open SSH pane by entry id (taskbar status dot / unsaved-recording marker). */
  sshPaneStates: Readonly<Record<string, { connected: boolean; recordingUnsaved: boolean } | undefined>>;
  popups: readonly SshPopupInfo[];
  busy: boolean;
  onOpenLocal: () => void;
  onOpenLocalShell: (kind: LocalTerminalKind) => void;
  /** Open (or raise) the entry's SSH pane in the main window. */
  onOpenSshInPane: (entryId: string) => void;
  /** Open the entry in its own native window. */
  onOpenSshWindow: (workspaceId: string, entryId: string) => void;
  /** Opens the Workspace Manager (optionally focused on one Workspace). */
  onOpenEntryManager: (workspaceId?: string) => void;
  onCreateWorkspace: () => void;
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
  sftp: <SftpIcon size={18} />,
  ssh: <TerminalIcon size={18} />,
};

export function PaneDock({
  layout, titles, restEnabled, vncEnabled, remoteChoices, sftpChoices, terminalWorkspaces, localShellsAvailable, sshPaneStates, popups, busy,
  onOpenLocal, onOpenLocalShell, onOpenSshInPane, onOpenSshWindow, onOpenEntryManager, onCreateWorkspace, onOpenRemote, onOpenSftp, onActivate, onCloseWindow, onFocusPopup, onClosePopup,
}: Props) {
  const [functionsOpen, setFunctionsOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [sshListOpen, setSshListOpen] = useState(false);
  const [activeEntry, setActiveEntry] = useState<{ workspaceId: string; entryId: string } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const closeMenus = () => {
    setFunctionsOpen(false);
    setLocationOpen(false);
    setTerminalOpen(false);
    setSshListOpen(false);
    setActiveEntry(null);
  };

  const anyMenuOpen = functionsOpen || terminalOpen;
  useEffect(() => {
    if (!anyMenuOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape peels one layer: the entry actions, then the Location / SSH list, then the flyout.
      event.stopPropagation();
      if (activeEntry) setActiveEntry(null);
      else if (sshListOpen) setSshListOpen(false);
      else if (locationOpen) setLocationOpen(false);
      else if (terminalOpen) setTerminalOpen(false);
      else setFunctionsOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anyMenuOpen, functionsOpen, locationOpen, terminalOpen, sshListOpen, activeEntry]);

  const windowOf = (id: PaneWindowId) => layout.windows.find((win) => win.id === id);
  const isOpen = (id: PaneWindowId) => Boolean(windowOf(id)?.open);
  const anySftpOpen = layout.windows.some((win) => win.open && kindOf(win.id) === "sftp");
  const anySshOpen = layout.windows.some((win) => win.open && kindOf(win.id) === "ssh");

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

  const totalEntries = terminalWorkspaces.reduce((count, workspace) => count + workspace.entries.length, 0);
  const activeEntryInfo = activeEntry
    ? terminalWorkspaces.find((workspace) => workspace.id === activeEntry.workspaceId)?.entries.find((entry) => entry.entryId === activeEntry.entryId)
    : undefined;

  const terminalFlyoutItems: { key: string; label: string; icon: React.ReactNode; hasMenu?: boolean; expanded?: boolean; onClick: () => void }[] = [
    {
      key: "entry-manager",
      label: "Entry Manager",
      icon: <EntryManagerIcon size={26} />,
      onClick: () => { onOpenEntryManager(); closeMenus(); },
    },
    {
      key: "ssh-entries",
      label: "SSH Entries",
      icon: <SshEntriesIcon size={26} />,
      hasMenu: true,
      expanded: sshListOpen,
      onClick: () => { setSshListOpen((value) => !value); setActiveEntry(null); },
    },
    ...(localShellsAvailable ? [
      {
        key: "cmd",
        label: "CMD",
        icon: <CommandPromptIcon size={26} />,
        onClick: () => { onOpenLocalShell("cmd"); closeMenus(); },
      },
      {
        key: "terminal",
        label: "Terminal",
        icon: <WindowsTerminalIcon size={26} />,
        onClick: () => { onOpenLocalShell("windowsTerminal"); closeMenus(); },
      },
    ] : []),
  ];

  const renderSshEntries = () => {
    if (terminalWorkspaces.length === 0) {
      return (
        <button type="button" role="menuitem" className="pane-menu-item" onClick={() => { onCreateWorkspace(); closeMenus(); }}>
          <span className="pane-menu-icon"><EntryManagerIcon size={18} /></span>
          <span className="pane-menu-text"><strong>No Workspace yet</strong><small>Create a Workspace first</small></span>
        </button>
      );
    }
    if (totalEntries === 0) {
      return (
        <button type="button" role="menuitem" className="pane-menu-item" onClick={() => { onOpenEntryManager(terminalWorkspaces[0].id); closeMenus(); }}>
          <span className="pane-menu-icon"><EntryManagerIcon size={18} /></span>
          <span className="pane-menu-text"><strong>No SSH Entry yet</strong><small>Add one in Entry Manager</small></span>
        </button>
      );
    }
    return terminalWorkspaces.filter((workspace) => workspace.entries.length > 0).map((workspace) => (
      <React.Fragment key={workspace.id}>
        <div className="pane-menu-heading">{workspace.name}</div>
        {workspace.entries.map((entry) => {
          const selected = activeEntry?.workspaceId === workspace.id && activeEntry.entryId === entry.entryId;
          return (
            <button
              key={entry.entryId}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={selected}
              className={`pane-menu-item${selected ? " is-current" : ""}`}
              title={entry.detail}
              onClick={() => setActiveEntry(selected ? null : { workspaceId: workspace.id, entryId: entry.entryId })}
            >
              <span className={`pane-status-dot${entry.connected ? " is-online" : ""}`} aria-hidden="true" />
              <span className="pane-menu-text">
                <strong>{entry.label}</strong>
                <small>{entry.detail}</small>
              </span>
            </button>
          );
        })}
      </React.Fragment>
    ));
  };

  // Singleton windows keep a fixed order; SSH and SFTP windows follow in the order they were opened.
  const taskbarIds: PaneWindowId[] = [
    ...PANE_SINGLETON_KINDS.filter(isOpen),
    ...layout.windows.filter((win) => win.open && isEntryWindow(win.id)).map((win) => win.id),
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
            onClick={() => { setFunctionsOpen((value) => !value); setLocationOpen(false); setTerminalOpen(false); setSshListOpen(false); setActiveEntry(null); }}
          >
            <span className="pane-dock-icon"><FunctionsIcon size={26} /></span>
            <span className="pane-dock-label">Functions</span>
          </button>
        </div>
        <div className="pane-terminal">
          <div className={`pane-flyout${terminalOpen ? " is-open" : ""}`} role="menu" aria-label="Terminal" aria-hidden={!terminalOpen}>
            {terminalFlyoutItems.map((item, index) => (
              <div className="pane-flyout-slot" key={item.key} style={{ "--i": index } as React.CSSProperties}>
                <button
                  type="button"
                  role="menuitem"
                  className={`pane-dock-button pane-flyout-button${item.expanded ? " is-expanded" : ""}`}
                  tabIndex={terminalOpen ? 0 : -1}
                  aria-haspopup={item.hasMenu ? "menu" : undefined}
                  aria-expanded={item.hasMenu ? item.expanded : undefined}
                  onClick={item.onClick}
                >
                  <span className="pane-dock-icon">{item.icon}</span>
                  <span className="pane-dock-label">{item.label}</span>
                </button>
                {item.key === "ssh-entries" && sshListOpen && (
                  <div className="pane-ssh-menu-wrap">
                    <div className="pane-location-menu pane-ssh-menu" role="menu" aria-label="SSH Entries">
                      {renderSshEntries()}
                    </div>
                    {activeEntry && activeEntryInfo && (
                      <div className="pane-entry-actions" role="menu" aria-label={`${activeEntryInfo.label} actions`}>
                        <div className="pane-menu-heading">{activeEntryInfo.label}</div>
                        <button type="button" role="menuitem" className="pane-menu-item" onClick={() => { onOpenSshWindow(activeEntry.workspaceId, activeEntry.entryId); closeMenus(); }}>
                          <span className="pane-menu-icon"><ExternalWindowIcon size={18} /></span>
                          <span className="pane-menu-text"><strong>Open a new Window</strong></span>
                        </button>
                        <button type="button" role="menuitem" className="pane-menu-item" onClick={() => { onOpenSshInPane(activeEntry.entryId); closeMenus(); }}>
                          <span className="pane-menu-icon"><TerminalIcon size={18} /></span>
                          <span className="pane-menu-text"><strong>Open SSH</strong></span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            className={`pane-dock-button pane-terminal-button${anySshOpen ? " is-open" : ""}${terminalOpen ? " is-expanded" : ""}`}
            aria-haspopup="menu"
            aria-expanded={terminalOpen}
            onClick={() => { setTerminalOpen((value) => !value); setFunctionsOpen(false); setLocationOpen(false); setSshListOpen(false); setActiveEntry(null); }}
          >
            <span className="pane-dock-icon"><TerminalIcon size={26} /></span>
            <span className="pane-dock-label">Terminal</span>
          </button>
        </div>
      </div>

      <div className="pane-taskbar" role="tablist" aria-label="Open windows">
        {taskbarIds.length === 0 && popups.length === 0 && <span className="pane-taskbar-empty">No open windows</span>}
        {taskbarIds.map((id) => {
          const win = windowOf(id)!;
          const active = layout.activeId === id;
          const title = titles[id] || id;
          const sshEntryId = sshPaneEntryIdOf(id);
          const sshState = sshEntryId ? sshPaneStates[sshEntryId] : undefined;
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
                {sshEntryId && <span className={`pane-status-dot${sshState?.connected ? " is-online" : ""}`} aria-hidden="true" />}
                <span className="pane-task-title">{title}</span>
                {sshState?.recordingUnsaved && <span className="pane-task-rec" title="Unsaved recording">REC</span>}
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
