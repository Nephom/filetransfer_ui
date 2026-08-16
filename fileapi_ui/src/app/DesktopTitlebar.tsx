import React from "react";
import { createPortal } from "react-dom";
import { MobileChoiceMenu } from "../ui/MobileChoiceMenu";

type DesktopTitlebarProps = {
  appMode: "location" | "rest" | "vnc";
  vncEnabled: boolean;
  session: { username: string; onlyTerminalMode: boolean; role: string };
  accountOpen: boolean;
  accountControl: React.Ref<HTMLDivElement>;
  accountMenuStyle: React.CSSProperties;
  mobileLayout: boolean;
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
  mobileLayout,
  onModeChange,
  onAccountToggle,
  onOpenSessions,
  onOpenSettings,
  onChangePassword,
  onOpenLogView,
  onOpenHelp,
  onSignOut,
}: DesktopTitlebarProps) {
  const modeOptions = [
    { id: "location", label: "LOCATION" },
    { id: "rest", label: "REST API" },
    ...(vncEnabled ? [{ id: "vnc", label: "VNC" }] : []),
  ];
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
          {mobileLayout ? <MobileChoiceMenu label="Application mode" currentId={appMode} options={modeOptions} onSelect={(id) => onModeChange(id as "location" | "rest" | "vnc")} /> : <div className="mode-buttons" role="group" aria-label="Application mode">
            {modeOptions.map((mode) => <button type="button" key={mode.id} className={`mode-switch-button${appMode === mode.id ? " selected" : ""}`} aria-pressed={appMode === mode.id} onClick={() => onModeChange(mode.id as "location" | "rest" | "vnc")}><span className="mode-switch-dot" /><span>{mode.label}</span></button>)}
          </div>}
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
