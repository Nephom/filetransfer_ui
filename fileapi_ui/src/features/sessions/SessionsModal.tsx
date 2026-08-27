import React from "react";
import type { SshProfile } from "../ssh/ssh-contracts";
import type { RestApiEntry } from "../../rest-api";
import type { ProxmoxVncEntry } from "../../proxmox-vnc";
import type { ManagedSession } from "./sessions-contracts";

type SessionsModalProps = {
  managedSessions: ManagedSession[];
  workspaceSessionId: string;
  activeManagedWorkspace: ManagedSession | undefined;
  sessionFormError: string;
  lastSavedSessionId: string;
  restApiModeEnabled: boolean;
  proxmoxVncModeEnabled: boolean;
  modalStyle: React.CSSProperties;
  onDragStart: (event: React.MouseEvent<HTMLElement>) => void;
  onClose: () => void;
  setWorkspaceSessionId: (id: string) => void;
  setActiveRestEntryId: (id: string) => void;
  setActiveVncEntryId: (id: string) => void;
  setAppMode: (mode: "location" | "rest" | "vnc") => void;
  startNewWorkspace: () => void;
  openWorkspaceNameDialog: (workspace: ManagedSession) => void;
  removeSession: (id: string) => void;
  openAddSshEntryDialog: () => void;
  openEditSshEntryDialog: (entry: SshProfile) => void;
  removeSshEntryDirect: (workspaceId: string, entry: SshProfile) => void;
  openAddRestEntryDialog: (workspaceId: string) => void;
  openEditRestEntryDialog: (workspaceId: string, entry: RestApiEntry) => void;
  removeRestEntryDirect: (workspaceId: string, entry: RestApiEntry) => void;
  openAddVncEntryDialog: (workspaceId: string) => void;
  openEditVncEntryDialog: (workspaceId: string, entry: ProxmoxVncEntry) => void;
  removeVncEntryDirect: (workspaceId: string, entry: ProxmoxVncEntry) => void;
};

export function SessionsModal({
  managedSessions,
  workspaceSessionId,
  activeManagedWorkspace,
  sessionFormError,
  lastSavedSessionId,
  restApiModeEnabled,
  proxmoxVncModeEnabled,
  modalStyle,
  onDragStart,
  onClose,
  setWorkspaceSessionId,
  setActiveRestEntryId,
  setActiveVncEntryId,
  setAppMode,
  startNewWorkspace,
  openWorkspaceNameDialog,
  removeSession,
  openAddSshEntryDialog,
  openEditSshEntryDialog,
  removeSshEntryDirect,
  openAddRestEntryDialog,
  openEditRestEntryDialog,
  removeRestEntryDirect,
  openAddVncEntryDialog,
  openEditVncEntryDialog,
  removeVncEntryDirect,
}: SessionsModalProps) {
  return (
    <div className="modal-cover" onMouseDown={onClose}>
      <div className="modal sessions-modal" style={modalStyle} onMouseDown={(event) => event.stopPropagation()}>
        <div className="workspace-manager-heading modal-drag-handle" onMouseDown={onDragStart}>
          <h2>Workspace Manager</h2>
          <div className="workspace-list-heading">
            <strong>Workspaces</strong>
            <button type="button" className="confirm" onClick={startNewWorkspace}>Add</button>
          </div>
        </div>
        {sessionFormError && <output className="form-error" role="alert">{sessionFormError}</output>}
        {lastSavedSessionId && <span className="session-saved-note">Saved successfully.</span>}
        {!managedSessions.length && <p className="muted workspace-empty">No Workspaces saved yet. Use Add to create one.</p>}
        <div className="workspace-card-list">
          {managedSessions.map((managedSession) => (
            <article className={`workspace-card${managedSession.id === workspaceSessionId ? " selected" : ""}`} key={managedSession.id}>
              <div className="workspace-card-heading">
                <button type="button" className="workspace-name" onClick={() => openWorkspaceNameDialog(managedSession)}>{managedSession.name}</button>
                <button type="button" onClick={() => openWorkspaceNameDialog(managedSession)}>Edit</button>
              </div>
              <section className="workspace-entry-section">
                <h3>SSH Entries</h3>
                {!managedSession.sshEntries.length && <span className="muted">No SSH entries yet.</span>}
                <ol className="workspace-entry-list">
                  {managedSession.sshEntries.map((entry) => (
                    <li key={entry.id}>
                      <button type="button" className="workspace-entry-button" onClick={() => { setWorkspaceSessionId(managedSession.id); openEditSshEntryDialog(entry); }}>
                        <strong>{entry.name}</strong>
                        <span>{entry.username}@{entry.host}:{entry.port}</span>
                      </button>
                      <button type="button" className="workspace-entry-remove" onClick={(event) => { event.stopPropagation(); removeSshEntryDirect(managedSession.id, entry); }}>Remove</button>
                    </li>
                  ))}
                </ol>
              </section>
              {restApiModeEnabled && <section className="workspace-entry-section">
                <h3>REST API Entries</h3>
                {!managedSession.restApiEntries.length && <span className="muted">No REST API entries yet.</span>}
                <ol className="workspace-entry-list">
                  {managedSession.restApiEntries.map((entry) => (
                    <li key={entry.id}>
                      <button type="button" className="workspace-entry-button" onClick={() => { setWorkspaceSessionId(managedSession.id); setActiveRestEntryId(entry.id); setAppMode("rest"); onClose(); }}>
                        <strong>{entry.name}</strong>
                        <span>{entry.baseUrl}{entry.defaultPath}</span>
                      </button>
                      <button type="button" className="workspace-entry-edit" onClick={(event) => { event.stopPropagation(); openEditRestEntryDialog(managedSession.id, entry); }}>Edit</button>
                      <button type="button" className="workspace-entry-remove" onClick={(event) => { event.stopPropagation(); removeRestEntryDirect(managedSession.id, entry); }}>Remove</button>
                    </li>
                  ))}
                </ol>
              </section>}
              {proxmoxVncModeEnabled && <section className="workspace-entry-section">
                <h3>Proxmox VNC Entries</h3>
                {!managedSession.proxmoxVncEntries.length && <span className="muted">No Proxmox VNC entries yet.</span>}
                <ol className="workspace-entry-list">
                  {managedSession.proxmoxVncEntries.map((entry) => (
                    <li key={entry.id}>
                      <button type="button" className="workspace-entry-button" onClick={() => { setWorkspaceSessionId(managedSession.id); setActiveVncEntryId(entry.id); setAppMode("vnc"); onClose(); }}>
                        <strong>{entry.name}</strong>
                        <span>{entry.baseUrl} · {entry.node || "No node"}/{entry.vmid || "No VMID"}</span>
                      </button>
                      <button type="button" className="workspace-entry-edit" onClick={(event) => { event.stopPropagation(); openEditVncEntryDialog(managedSession.id, entry); }}>Edit</button>
                      <button type="button" className="workspace-entry-remove" onClick={(event) => { event.stopPropagation(); removeVncEntryDirect(managedSession.id, entry); }}>Remove</button>
                    </li>
                  ))}
                </ol>
              </section>}
              <div className="workspace-entry-actions">
                <button type="button" className="confirm" onClick={() => { setWorkspaceSessionId(managedSession.id); openAddSshEntryDialog(); }}>Add SSH Entry</button>
                {restApiModeEnabled && <button type="button" className="confirm" onClick={() => openAddRestEntryDialog(managedSession.id)}>Add REST API Entry</button>}
                {proxmoxVncModeEnabled && <button type="button" className="confirm" onClick={() => openAddVncEntryDialog(managedSession.id)}>Add Proxmox VNC Entry</button>}
                {restApiModeEnabled && <button type="button" onClick={() => { setWorkspaceSessionId(managedSession.id); setAppMode("rest"); onClose(); }}>Open REST API</button>}
                {proxmoxVncModeEnabled && <button type="button" onClick={() => { setWorkspaceSessionId(managedSession.id); setAppMode("vnc"); onClose(); }}>Open VNC</button>}
              </div>
            </article>
          ))}
        </div>
        <div className="workspace-modal-footer">
          {managedSessions.length > 1 ? (
            <button
              type="button"
              className="danger"
              disabled={!activeManagedWorkspace}
              title={activeManagedWorkspace ? undefined : "請先選擇一個 Workspace 才能移除"}
              onClick={() => activeManagedWorkspace && removeSession(activeManagedWorkspace.id)}
            >
              Remove Workspace
            </button>
          ) : (
            <span className="muted workspace-remove-hint">僅有 1 個 Workspace，如需移除請先建立另一個 Workspace</span>
          )}
          <button type="button" className="confirm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
