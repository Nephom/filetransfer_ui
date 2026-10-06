import React from "react";
import { createPortal } from "react-dom";
import { AccountIcon, QueueIcon, SettingsIcon } from "./pane-icons";

type Props = {
  session: { username: string; role: string; localOnly: boolean };
  accountOpen: boolean;
  accountControl: React.Ref<HTMLDivElement>;
  accountMenuStyle: React.CSSProperties;
  activeQueueCount: number;
  onOpenQueue: () => void;
  onAccountToggle: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onOpenSessions: () => void;
  onOpenSettings: () => void;
  onChangePassword: () => void;
  onOpenLogView: () => void;
  onOpenHelp: () => void;
  onOpenWelcomeTutorial: () => void;
  onSignOut: () => void;
};

/** Pills in the top-right corner of the desktop: transfer queue, settings and the account menu. */
export function PaneTopRight({
  session, accountOpen, accountControl, accountMenuStyle, activeQueueCount,
  onOpenQueue, onAccountToggle, onOpenSessions, onOpenSettings, onChangePassword, onOpenLogView, onOpenHelp, onOpenWelcomeTutorial, onSignOut,
}: Props) {
  const roleLabel = session.localOnly ? "Local" : session.role === "admin" ? "Admin" : session.role === "superuser" ? "Superuser" : "User";
  const roleDescription = session.localOnly ? "Local-only mode" : session.role === "admin" ? "System administrator" : session.role === "superuser" ? "Superuser" : "Standard user";
  return (
    <>
      <button
        type="button"
        className={`pane-pill pane-pill-button${activeQueueCount > 0 ? " is-busy" : ""}`}
        onClick={onOpenQueue}
        title="Transfer Queue"
        aria-label={`Transfer Queue, ${activeQueueCount} active`}
      >
        <QueueIcon size={18} />
        <span className="pane-pill-count">{activeQueueCount}</span>
      </button>
      <button type="button" className="pane-pill pane-pill-button pane-pill-icon" onClick={onOpenSettings} title="Settings" aria-label="Settings">
        <SettingsIcon size={18} />
      </button>
      <div className="account-control" ref={accountControl}>
        <button type="button" className="pane-pill pane-pill-button account" onClick={onAccountToggle} aria-expanded={accountOpen} aria-haspopup="menu">
          <AccountIcon size={18} />
          <span className="pane-account-name">{session.username}</span>
          <span className="account-role">{roleLabel}</span>
        </button>
        {accountOpen && createPortal(
          <div className="account-menu" style={accountMenuStyle} role="menu" aria-label="Account menu">
            <div className="account-summary">
              <strong>{session.username}</strong>
              <span>{roleDescription}</span>
            </div>
            <button role="menuitem" onClick={onOpenSessions}>Workspace Manager</button>
            <button role="menuitem" onClick={onOpenSettings}>Settings</button>
            {!session.localOnly && session.role !== "admin" && <button role="menuitem" onClick={onChangePassword}>Change password</button>}
            <button role="menuitem" onClick={onOpenLogView}>LogView</button>
            <button role="menuitem" onClick={onOpenHelp}>Help</button>
            <button role="menuitem" onClick={onOpenWelcomeTutorial}>Welcome tutorial</button>
            <hr />
            <button className="danger" role="menuitem" onClick={onSignOut}>Log out</button>
          </div>,
          document.body,
        )}
      </div>
    </>
  );
}
