import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FloatingWindow } from "../../ui/FloatingWindow";
import { ProxmoxVncWorkspace, ProxmoxVncScreenPane, vmSshProfileId, vmSshProfileKey, type ProxmoxVncEntry, type ProxmoxVncSecret, type ProxmoxVmSummary, type VmSshProfile } from "../../proxmox-vnc";

export { ProxmoxVncScreenPane };

export type VncWorkspaceControllerProps = {
  workspaceName: string;
  entries: ProxmoxVncEntry[];
  activeEntryId: string;
  secrets: Record<string, ProxmoxVncSecret>;
  commandbarHost: HTMLElement | null;
  collapseMainPaneEnabled: boolean;
  onSelectEntry: (id: string) => void;
  onChangeEntries: (entries: ProxmoxVncEntry[]) => void;
  onChangeSecret: (entryId: string, secret: ProxmoxVncSecret) => void;
  onAddEntry: () => void;
  onEditEntry: (entry: ProxmoxVncEntry) => void;
  onRemoveEntry: (entry: ProxmoxVncEntry) => void;
};

export function VncWorkspaceController(props: VncWorkspaceControllerProps) {
  return <ProxmoxVncWorkspace {...props} />;
}

export type ProxmoxVncLoginOperations = {
  loadPassword: (entryId: string) => Promise<string | null>;
  login: (entry: ProxmoxVncEntry, password: string) => Promise<string>;
  listVms: (entry: ProxmoxVncEntry, sessionId: string) => Promise<ProxmoxVmSummary[]>;
  logout: (sessionId: string) => Promise<unknown>;
};

export type ProxmoxVncLoginResult =
  | { kind: "missing-password" }
  | { kind: "ready"; sessionId: string; vms: ProxmoxVmSummary[] };

/** Load a stored credential, authenticate, and list VMs as one owned operation. */
export async function loginProxmoxVncEntry(entry: ProxmoxVncEntry, operations: ProxmoxVncLoginOperations): Promise<ProxmoxVncLoginResult> {
  const password = await operations.loadPassword(entry.id);
  if (!password) return { kind: "missing-password" };
  const sessionId = await operations.login(entry, password);
  try {
    const vms = await operations.listVms(entry, sessionId);
    return { kind: "ready", sessionId, vms };
  } catch (error) {
    await operations.logout(sessionId).catch(() => undefined);
    throw error;
  }
}

export type VncVmPickerPaneProps = {
  entry: ProxmoxVncEntry;
  vms: ProxmoxVmSummary[];
  authenticated: boolean;
  loading: boolean;
  error: string;
  onChangeEntry: (updates: Partial<ProxmoxVncEntry>) => void;
  onConnect: (vm: ProxmoxVmSummary) => void;
  onRetry: () => void;
  onLogout: () => void;
  onEditEntry: () => void;
};

export function VncVmPickerPane({ entry, vms, authenticated, loading, error, onChangeEntry, onConnect, onRetry, onLogout, onEditEntry }: VncVmPickerPaneProps) {
  const nodes = [...new Set(vms.map((vm) => vm.node))].sort();
  const nodeVms = vms.filter((vm) => vm.node === entry.node);
  const selectedVm = nodeVms.find((vm) => vm.vmid === entry.vmid);
  const selectedVmKey = vmSshProfileKey(entry.node, entry.vmid);
  const storedVmSshProfile = entry.vmSshProfiles?.[selectedVmKey];
  const [vmSshSettingsOpen, setVmSshSettingsOpen] = useState(false);
  const [vmSshDraft, setVmSshDraft] = useState<VmSshProfile>(storedVmSshProfile || { username: "root", port: 22, privateKeyPath: "", fallbackIp: "" });
  const [vmSshPassword, setVmSshPassword] = useState("");
  const [vmSshPasswordSaved, setVmSshPasswordSaved] = useState(false);
  const [vmSshSaving, setVmSshSaving] = useState(false);
  const [vmSshError, setVmSshError] = useState("");
  useEffect(() => {
    setVmSshDraft(storedVmSshProfile || { username: "root", port: 22, privateKeyPath: "", fallbackIp: "" });
    setVmSshPassword("");
    setVmSshPasswordSaved(false);
    setVmSshError("");
    setVmSshSettingsOpen(false);
    if (selectedVm) {
      void invoke<boolean>("ssh_has_password", { entryId: vmSshProfileId(entry.id, entry.node, entry.vmid) })
        .then(setVmSshPasswordSaved)
        .catch(() => setVmSshPasswordSaved(false));
    }
  }, [entry.id, entry.node, entry.vmid]);
  const saveVmSshProfile = async () => {
    if (!selectedVm || !vmSshDraft.username.trim()) return;
    const profile = { ...vmSshDraft, username: vmSshDraft.username.trim(), port: vmSshDraft.port || 22, privateKeyPath: vmSshDraft.privateKeyPath.trim(), fallbackIp: vmSshDraft.fallbackIp.trim() };
    setVmSshSaving(true);
    setVmSshError("");
    try {
      if (vmSshPassword) {
        await invoke("ssh_save_password", { entryId: vmSshProfileId(entry.id, entry.node, entry.vmid), password: vmSshPassword });
        setVmSshPassword("");
        setVmSshPasswordSaved(true);
      }
      onChangeEntry({ vmSshProfiles: { ...(entry.vmSshProfiles || {}), [selectedVmKey]: profile } });
      setVmSshDraft(profile);
    } catch (saveError) {
      setVmSshError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setVmSshSaving(false);
    }
  };
  const forgetVmSshPassword = async () => {
    if (!selectedVm) return;
    try {
      await invoke("ssh_forget_password", { entryId: vmSshProfileId(entry.id, entry.node, entry.vmid) });
      setVmSshPassword("");
      setVmSshPasswordSaved(false);
      setVmSshError("");
    } catch (forgetError) {
      setVmSshError(forgetError instanceof Error ? forgetError.message : String(forgetError));
    }
  };
  return <section className="vnc-picker-pane" aria-label={`Select a VM for ${entry.name}`}>
    <header className="vnc-picker-heading">
      <div><span className="eyebrow">Proxmox VNC</span><h1>{entry.name}</h1><small>{entry.baseUrl}</small></div>
      <span className="vnc-session-status">{loading ? (authenticated ? "Loading VMs…" : "Logging in…") : authenticated ? `${vms.length} VMs` : "Not logged in"}</span>
    </header>
    {error && <div className="notice rest-error" role="alert">{error}</div>}
    {!authenticated && <p className="field-help">{loading ? "Logging in to Proxmox and loading the VM list…" : "Select this Entry from Functions → VNC → Entries to log in."}</p>}
    {authenticated && <div className="vnc-picker-controls">
      <label>Node
        <select value={entry.node} onChange={(event) => onChangeEntry({ node: event.target.value, vmid: null })} disabled={loading || !nodes.length}>
          <option value="">Select node</option>
          {nodes.map((node) => <option key={node} value={node}>{node}</option>)}
        </select>
      </label>
      <label>VM
        <select value={selectedVm ? String(selectedVm.vmid) : ""} onChange={(event) => {
          const vm = nodeVms.find((item) => String(item.vmid) === event.target.value);
          if (vm) onChangeEntry({ node: vm.node, vmid: vm.vmid, guestType: vm.guestType as "qemu" | "lxc" });
        }} disabled={loading || !entry.node || !nodeVms.length}>
          <option value="">Select VM</option>
          {nodeVms.map((vm) => <option key={vm.vmid} value={vm.vmid}>{vm.name || `VM ${vm.vmid}`} ({vm.vmid}) · {vm.status || "unknown"}</option>)}
        </select>
      </label>
    </div>}
    {authenticated && selectedVm && <div className="vnc-picker-selected"><strong>{selectedVm.name || `VM ${selectedVm.vmid}`}</strong><span>{selectedVm.guestType.toUpperCase()} · VMID {selectedVm.vmid} · {selectedVm.node}</span><button type="button" onClick={() => setVmSshSettingsOpen(true)}>VM SFTP settings</button></div>}
    <div className="vnc-picker-actions">
      <button type="button" onClick={onEditEntry}>Edit Entry</button>
      {authenticated
        ? <><button type="button" onClick={onLogout} disabled={loading}>Logout</button><button type="button" className="confirm" onClick={() => selectedVm && onConnect(selectedVm)} disabled={loading || !selectedVm}>Connect</button></>
        : <button type="button" className="confirm" onClick={onRetry} disabled={loading}>Retry login</button>}
    </div>
    {vmSshSettingsOpen && selectedVm && <FloatingWindow
      ariaLabel={`VM SFTP settings for VMID ${selectedVm.vmid}`}
      className="vnc-vm-ssh-window"
      header={<strong>VM SFTP settings · {selectedVm.name || `VM ${selectedVm.vmid}`}</strong>}
      onClose={() => setVmSshSettingsOpen(false)}
      footer={<div className="modal-actions"><button type="button" onClick={() => setVmSshSettingsOpen(false)}>Close</button><button type="button" className="confirm" onClick={() => void saveVmSshProfile()} disabled={vmSshSaving || !vmSshDraft.username.trim()}>{vmSshSaving ? "Saving…" : "Save VM SFTP"}</button></div>}
    >
      <div className="vnc-vm-ssh-window-body">
        <div className="vnc-vm-ssh-window-status"><span>{storedVmSshProfile ? "Profile saved for this VM" : "Not configured for this VM"}</span><span>{vmSshPasswordSaved ? "Password saved" : "Password not saved"}</span></div>
        <div className="vnc-auth-grid vnc-auth-grid-compact">
          <label>Username<input value={vmSshDraft.username} onChange={(event) => setVmSshDraft((current) => ({ ...current, username: event.target.value }))} placeholder="root" /></label>
          <label>Port<input type="number" min="1" max="65535" value={vmSshDraft.port} onChange={(event) => setVmSshDraft((current) => ({ ...current, port: Number(event.target.value) || 22 }))} /></label>
          <label>Private key<input value={vmSshDraft.privateKeyPath} onChange={(event) => setVmSshDraft((current) => ({ ...current, privateKeyPath: event.target.value }))} placeholder="Optional" /></label>
          <label>Fallback IP<input value={vmSshDraft.fallbackIp} onChange={(event) => setVmSshDraft((current) => ({ ...current, fallbackIp: event.target.value }))} placeholder="Optional" /></label>
        </div>
        <label className="vnc-vm-ssh-password">Password<input type="password" value={vmSshPassword} onChange={(event) => setVmSshPassword(event.target.value)} placeholder={vmSshPasswordSaved ? "Saved - leave blank to keep it" : "Not saved"} autoComplete="new-password" /></label>
        {vmSshPasswordSaved && <button type="button" onClick={() => void forgetVmSshPassword()} disabled={vmSshSaving}>Forget VM password</button>}
        <small className="field-help">QEMU Guest Agent file access works without VM SSH credentials. Saving this profile enables direct or host-jump SFTP detection.</small>
        {vmSshError && <div className="notice rest-error" role="alert">{vmSshError}</div>}
      </div>
    </FloatingWindow>}
  </section>;
}

export type VncDirectSetupPaneProps = { onConnect: (host: string, port: number) => void };

export function VncDirectSetupPane({ onConnect }: VncDirectSetupPaneProps) {
  const [host, setHost] = useState(() => localStorage.getItem("fileapi-direct-vnc-host") || "");
  const [port, setPort] = useState(() => Number(localStorage.getItem("fileapi-direct-vnc-port")) || 5900);
  const valid = Boolean(host.trim()) && Number.isInteger(port) && port >= 1 && port <= 65535;
  const updateHost = (value: string) => {
    setHost(value);
    localStorage.setItem("fileapi-direct-vnc-host", value);
  };
  const updatePort = (value: string) => {
    const next = value === "" ? 0 : Number(value);
    setPort(next);
    localStorage.setItem("fileapi-direct-vnc-port", String(next));
  };
  return <section className="vnc-picker-pane direct-vnc-setup-pane" aria-label="Direct VNC setup">
    <header className="vnc-picker-heading"><div><span className="eyebrow">Direct mode</span><h1>Connect to a VNC host</h1><small>Direct VNC does not provide VM file transfer.</small></div></header>
    <div className="vnc-picker-controls direct-vnc-setup-controls">
      <label>Host<input value={host} onChange={(event) => updateHost(event.target.value)} placeholder="vnc-server.local" /></label>
      <label>Port<input type="number" min="1" max="65535" value={port || ""} onChange={(event) => updatePort(event.target.value)} /></label>
    </div>
    <p className="field-help">The VNC server will request any required viewer or account credentials after the connection starts.</p>
    <div className="vnc-picker-actions"><button type="button" className="confirm" onClick={() => onConnect(host.trim(), port)} disabled={!valid}>Connect</button></div>
  </section>;
}
