import React from "react";
import { Dropdown } from "../../ui/Dropdown";
import type { ProxmoxVncEntry } from "../../proxmox-vnc";

type VncEntryDialogProps = {
  isEditing: boolean;
  workspaceName: string | undefined;
  sessionFormError: string;
  vncEntryDraft: ProxmoxVncEntry;
  setVncEntryDraft: (draft: ProxmoxVncEntry) => void;
  vncEntryModalTab: "default" | "vmSsh" | "hostSsh";
  setVncEntryModalTab: (tab: "default" | "vmSsh" | "hostSsh") => void;
  vmSshPasswordDraft: string;
  setVmSshPasswordDraft: (value: string) => void;
  vmSshPasswordSaved: boolean;
  hostSshPasswordDraft: string;
  setHostSshPasswordDraft: (value: string) => void;
  hostSshPasswordSaved: boolean;
  modalStyle: React.CSSProperties;
  onDragStart: (event: React.MouseEvent<HTMLElement>) => void;
  onClose: () => void;
  onInstallVmKey: () => void;
  onInstallHostKey: () => void;
  onRemove: () => void;
  onSave: () => void;
  vncEndpointParts: (baseUrl: string) => { host: string; port: string };
  vncUsernameParts: (username: string) => { account: string; realm: string };
};

export function VncEntryDialog({
  isEditing,
  workspaceName,
  sessionFormError,
  vncEntryDraft,
  setVncEntryDraft,
  vncEntryModalTab,
  setVncEntryModalTab,
  vmSshPasswordDraft,
  setVmSshPasswordDraft,
  vmSshPasswordSaved,
  hostSshPasswordDraft,
  setHostSshPasswordDraft,
  hostSshPasswordSaved,
  modalStyle,
  onDragStart,
  onClose,
  onInstallVmKey,
  onInstallHostKey,
  onRemove,
  onSave,
  vncEndpointParts,
  vncUsernameParts,
}: VncEntryDialogProps) {
  const endpoint = vncEndpointParts(vncEntryDraft.baseUrl);
  const proxmoxUsername = vncUsernameParts(vncEntryDraft.username);
  const updateEndpoint = (host: string, port: string) => setVncEntryDraft({ ...vncEntryDraft, baseUrl: `https://${host}:${port}` });
  const updateUsername = (account: string, realm: string) => setVncEntryDraft({ ...vncEntryDraft, username: `${account}@${realm}` });
  return (
    <div className="modal-cover modal-layer-top" onMouseDown={onClose}>
      <div className="modal vnc-entry-modal" style={modalStyle} onMouseDown={(event) => event.stopPropagation()}>
        <h2 className="modal-drag-handle" onMouseDown={onDragStart}>{isEditing ? "Edit Proxmox VNC Entry" : "Add Proxmox VNC Entry"}</h2>
        <div className="vnc-entry-modal-tabs" role="tablist" aria-label="Proxmox VNC entry section">
          <button type="button" role="tab" aria-selected={vncEntryModalTab === "default"} className={`vnc-entry-modal-tab${vncEntryModalTab === "default" ? " active" : ""}`} onClick={() => setVncEntryModalTab("default")}>Host Entry</button>
          <button type="button" role="tab" aria-selected={vncEntryModalTab === "vmSsh"} className={`vnc-entry-modal-tab${vncEntryModalTab === "vmSsh" ? " active" : ""}`} onClick={() => setVncEntryModalTab("vmSsh")}>VM SSH</button>
          <button type="button" role="tab" aria-selected={vncEntryModalTab === "hostSsh"} className={`vnc-entry-modal-tab${vncEntryModalTab === "hostSsh" ? " active" : ""}`} onClick={() => setVncEntryModalTab("hostSsh")}>Host SSH (jump)</button>
        </div>
        <p>Workspace: {workspaceName || "—"}</p>
        {sessionFormError && <output className="form-error" role="alert">{sessionFormError}</output>}
        {vncEntryModalTab === "default" && <>
          <label>Name<input value={vncEntryDraft.name} onChange={(event) => setVncEntryDraft({ ...vncEntryDraft, name: event.target.value })} /></label>
          <div className="vnc-form-grid">
            <label>Proxmox host<input value={endpoint.host} onChange={(event) => updateEndpoint(event.target.value, endpoint.port)} placeholder="proxmox.example.com" /></label>
            <label>Port<input type="number" min="1" max="65535" value={endpoint.port} onChange={(event) => updateEndpoint(endpoint.host, event.target.value)} placeholder="8006" /></label>
          </div>
          <div className="vnc-username-field">
            <label>Username<input value={proxmoxUsername.account} onChange={(event) => updateUsername(event.target.value, proxmoxUsername.realm)} placeholder="root" /></label>
            <div className="vnc-realm-options">
              <label><input type="radio" name={`realm-${vncEntryDraft.id}`} checked={proxmoxUsername.realm === "pam"} onChange={() => updateUsername(proxmoxUsername.account, "pam")} /> pam</label>
              <label><input type="radio" name={`realm-${vncEntryDraft.id}`} checked={proxmoxUsername.realm === "pve"} onChange={() => updateUsername(proxmoxUsername.account, "pve")} /> pve</label>
            </div>
          </div>
          <label>PVE version<Dropdown label="PVE version" value={vncEntryDraft.proxmoxVersion} onChange={(nextVersion) => setVncEntryDraft({ ...vncEntryDraft, proxmoxVersion: nextVersion as ProxmoxVncEntry["proxmoxVersion"] })} options={[{ value: "auto", label: "Auto detect" }, { value: "6.4", label: "6.4" }, { value: "7.x", label: "7.x" }, { value: "8.x", label: "8.x" }, { value: "9.x", label: "9.x" }]} /></label>
          <label className="tls-option"><input type="checkbox" checked={vncEntryDraft.ignoreTlsErrors} onChange={(event) => setVncEntryDraft({ ...vncEntryDraft, ignoreTlsErrors: event.target.checked })} /> Ignore TLS certificate errors</label>
          <small className="field-help">Password, node, and VM selection are configured from the entry's own connection controls once this entry is selected in the VNC mode.</small>
        </>}
        {vncEntryModalTab === "vmSsh" && <>
          <strong>File transfer: VM SSH</strong>
          <small className="field-help">Credentials for the VM's own SSH/SFTP server, used when this client (or the Proxmox host, as a jump) can reach the VM directly. Leave the password blank to keep a previously saved one.</small>
          <div className="vnc-form-grid">
            <label>VM SSH username<input value={vncEntryDraft.vmSshUsername || ""} onChange={(event) => setVncEntryDraft({ ...vncEntryDraft, vmSshUsername: event.target.value })} placeholder="root" /></label>
            <label>VM SSH port<input type="number" min="1" max="65535" value={vncEntryDraft.vmSshPort || 22} onChange={(event) => setVncEntryDraft({ ...vncEntryDraft, vmSshPort: Number(event.target.value) || 22 })} /></label>
          </div>
          <label>VM SSH private key path (optional)<input value={vncEntryDraft.vmSshPrivateKeyPath || ""} onChange={(event) => setVncEntryDraft({ ...vncEntryDraft, vmSshPrivateKeyPath: event.target.value })} placeholder="/home/test/.ssh/id_ed25519" /></label>
          <label>VM SSH password<input type="password" value={vmSshPasswordDraft} onChange={(event) => setVmSshPasswordDraft(event.target.value)} placeholder={vmSshPasswordSaved ? "Saved - leave blank to keep it" : "Not saved"} autoComplete="new-password" /></label>
          <label>Fallback VM IP (optional)<input value={vncEntryDraft.fileTransferIpOverride || ""} onChange={(event) => setVncEntryDraft({ ...vncEntryDraft, fileTransferIpOverride: event.target.value })} placeholder="Only needed if the Guest Agent can't report it (e.g. LXC)" /></label>
          <div className="modal-actions"><button type="button" onClick={onInstallVmKey}>Install SSH key on VM</button></div>
        </>}
        {vncEntryModalTab === "hostSsh" && <>
          <strong>File transfer: Host SSH (jump)</strong>
          <small className="field-help">Only needed when the VM isn't directly reachable from this client -- the Proxmox host itself is then used as an SSH jump to reach the VM's SFTP over a tunneled connection.</small>
          <div className="vnc-form-grid">
            <label>Host SSH username<input value={vncEntryDraft.hostSshUsername || ""} onChange={(event) => setVncEntryDraft({ ...vncEntryDraft, hostSshUsername: event.target.value })} placeholder="root" /></label>
            <label>Host SSH port<input type="number" min="1" max="65535" value={vncEntryDraft.hostSshPort || 22} onChange={(event) => setVncEntryDraft({ ...vncEntryDraft, hostSshPort: Number(event.target.value) || 22 })} /></label>
          </div>
          <label>Host SSH private key path (optional)<input value={vncEntryDraft.hostSshPrivateKeyPath || ""} onChange={(event) => setVncEntryDraft({ ...vncEntryDraft, hostSshPrivateKeyPath: event.target.value })} placeholder="/home/test/.ssh/id_ed25519" /></label>
          <label>Host SSH password<input type="password" value={hostSshPasswordDraft} onChange={(event) => setHostSshPasswordDraft(event.target.value)} placeholder={hostSshPasswordSaved ? "Saved - leave blank to keep it" : "Not saved"} autoComplete="new-password" /></label>
          <div className="modal-actions"><button type="button" onClick={onInstallHostKey}>Install SSH key on host</button></div>
        </>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          {isEditing && <button type="button" className="session-delete" onClick={onRemove}>Remove</button>}
          <button type="button" className="confirm" onClick={onSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
