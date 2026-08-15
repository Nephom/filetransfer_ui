import React from "react";
import { createPortal } from "react-dom";

type DesktopTitlebarProps = {
  appMode: "location" | "rest" | "vnc";
  vncEnabled: boolean;
  session: { username: string; onlyTerminalMode: boolean; role: string };
  accountOpen: boolean;
  accountControl: React.Ref<HTMLDivElement>;
  accountMenuStyle: React.CSSProperties;
  onModeChange: (mode: "location" | "rest" | "vnc") => void;
  onAccountToggle: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onOpenSessions: () => void;
  onOpenSettings: () => void;
  onChangePassword: () => void;
  onOpenLogView: () => void;
  onOpenHelp: () => void;
  onSignOut: () => void;
};

export function DesktopTitlebar({
  appMode,
  vncEnabled,
  session,
  accountOpen,
  accountControl,
  accountMenuStyle,
  onModeChange,
  onAccountToggle,
  onOpenSessions,
  onOpenSettings,
  onChangePassword,
  onOpenLogView,
  onOpenHelp,
  onSignOut,
}: DesktopTitlebarProps) {
  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <span className="app-mark" />
        <span className="app-name">
          Nephom <span className="connection-status">File manager</span> cross <span className="connection-status">Terminal</span>
        </span>
      </div>
      <div className="titlebar-main">
        <div className={`mode-switcher ${appMode === "rest" ? "rest-active" : appMode === "vnc" ? "vnc-active" : "location-active"}`}>
          <div className="mode-buttons" role="group" aria-label="Application mode">
            <button type="button" className={`mode-switch-button${appMode === "location" ? " selected" : ""}`} aria-pressed={appMode === "location"} onClick={() => onModeChange("location")}><span className="mode-switch-dot" /><span>LOCATION</span></button>
            <button type="button" className={`mode-switch-button${appMode === "rest" ? " selected" : ""}`} aria-pressed={appMode === "rest"} onClick={() => onModeChange("rest")}><span className="mode-switch-dot" /><span>REST API</span></button>
            {vncEnabled && <button type="button" className={`mode-switch-button${appMode === "vnc" ? " selected" : ""}`} aria-pressed={appMode === "vnc"} onClick={() => onModeChange("vnc")}><span className="mode-switch-dot" /><span>VNC</span></button>}
          </div>
        </div>
      </div>
      <div className="titlebar-account">
        <div className="account-control" ref={accountControl}>
          <button className="account" onClick={onAccountToggle} aria-expanded={accountOpen} aria-haspopup="menu">
            {session.username}
            <span className="account-role">{session.onlyTerminalMode ? "Only Terminal" : session.role === "admin" ? "Admin" : "User"}</span>
            <span className="account-chevron">⌄</span>
          </button>
          {accountOpen && createPortal(
            <div className="account-menu" style={accountMenuStyle} role="menu" aria-label="Account menu">
              <div className="account-summary">
                <strong>{session.username}</strong>
                <span>{session.onlyTerminalMode ? "Offline dev session — no API server connected" : session.role === "admin" ? "System administrator" : "Standard user"}</span>
              </div>
              <button role="menuitem" onClick={onOpenSessions}>Workspace Manager</button>
              <button role="menuitem" onClick={onOpenSettings}>Settings</button>
              {!session.onlyTerminalMode && session.role !== "admin" && <button role="menuitem" onClick={onChangePassword}>Change password</button>}
              <button role="menuitem" onClick={onOpenLogView}>LogView</button>
              <button role="menuitem" onClick={onOpenHelp}>Help</button>
              <hr />
              <button className="danger" role="menuitem" onClick={onSignOut}>Log out</button>
            </div>,
            document.body,
          )}
        </div>
      </div>
    </header>
  );
}
