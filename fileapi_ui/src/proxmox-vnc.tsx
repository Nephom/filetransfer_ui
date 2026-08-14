import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type ProxmoxVersion = "auto" | "6.4" | "7.x" | "8.x" | "9.x";
export type ProxmoxVncEntry = {
  id: string;
  name: string;
  baseUrl: string;
  username: string;
  node: string;
  vmid: number | null;
  guestType: "qemu" | "lxc";
  proxmoxVersion: ProxmoxVersion;
  ignoreTlsErrors: boolean;
};
export type ProxmoxVncSecret = { password?: string };
type VmSummary = { vmid: number; name?: string; node: string; status?: string; guestType: string };
type Connection = { id: string; websocketUrl: string; password: string };

type Props = {
  workspaceName: string;
  entries: ProxmoxVncEntry[];
  activeEntryId: string;
  secrets: Record<string, ProxmoxVncSecret>;
  onSelectEntry: (id: string) => void;
  onChangeEntries: (entries: ProxmoxVncEntry[]) => void;
  onChangeSecret: (entryId: string, secret: ProxmoxVncSecret) => void;
};

const emptyEntry = (): ProxmoxVncEntry => ({
  id: crypto.randomUUID(), name: "New Proxmox VNC", baseUrl: "https://", username: "",
  node: "", vmid: null, guestType: "qemu", proxmoxVersion: "auto", ignoreTlsErrors: false,
});

function VncEntries({ entries, activeEntryId, onSelectEntry, onChangeEntries }: Pick<Props, "entries" | "activeEntryId" | "onSelectEntry" | "onChangeEntries">) {
  const [editing, setEditing] = useState<ProxmoxVncEntry | null>(null);
  const save = () => {
    if (!editing || !editing.name.trim() || !/^https:\/\//i.test(editing.baseUrl.trim())) return;
    const next = entries.some((item) => item.id === editing.id)
      ? entries.map((item) => item.id === editing.id ? editing : item)
      : [...entries, editing];
    onChangeEntries(next); onSelectEntry(editing.id); setEditing(null);
  };
  return <aside className="vnc-entry-pane">
    <div className="vnc-entry-heading"><span className="sidebar-label">PROXMOX VNC ENTRIES</span><button type="button" className="confirm vnc-add-button" onClick={() => setEditing(emptyEntry())}>+ Add entry</button></div>
    <div className="vnc-entry-list">
      {!entries.length && <div className="vnc-empty">No Proxmox VNC entries yet.</div>}
      {entries.map((entry) => <button type="button" key={entry.id} className={`vnc-entry${entry.id === activeEntryId ? " active" : ""}`} onClick={() => onSelectEntry(entry.id)}>
        <span className="vnc-entry-dot" /><span className="vnc-entry-copy"><strong>{entry.name}</strong><small>{entry.baseUrl}</small><small>{entry.node || "No node"} / {entry.vmid || "No VMID"}</small></span><span className="vnc-entry-edit" onClick={(event) => { event.stopPropagation(); setEditing(entry); }}>Edit</span>
      </button>)}
    </div>
    {editing && <div className="vnc-entry-editor">
      <div className="vnc-editor-heading"><strong>{entries.some((item) => item.id === editing.id) ? "Edit VNC entry" : "Add VNC entry"}</strong><button type="button" onClick={() => setEditing(null)} aria-label="Close editor">×</button></div>
      <label>Name<input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
      <label>Proxmox base URL<input value={editing.baseUrl} onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value })} placeholder="https://proxmox.example.com:8006" /></label>
      <label>Username<input value={editing.username} onChange={(event) => setEditing({ ...editing, username: event.target.value })} placeholder="root@pam" /></label>
      <div className="vnc-form-grid"><label>Node<input value={editing.node} onChange={(event) => setEditing({ ...editing, node: event.target.value })} /></label><label>VMID<input type="number" min="1" value={editing.vmid || ""} onChange={(event) => setEditing({ ...editing, vmid: event.target.value ? Number(event.target.value) : null })} /></label></div>
      <div className="vnc-form-grid"><label>Guest type<select value={editing.guestType} onChange={(event) => setEditing({ ...editing, guestType: event.target.value as "qemu" | "lxc" })}><option value="qemu">QEMU VM</option><option value="lxc">LXC container</option></select></label><label>PVE version<select value={editing.proxmoxVersion} onChange={(event) => setEditing({ ...editing, proxmoxVersion: event.target.value as ProxmoxVersion })}><option value="auto">Auto detect</option><option value="6.4">6.4</option><option value="7.x">7.x</option><option value="8.x">8.x</option><option value="9.x">9.x</option></select></label></div>
      <label className="tls-option"><input type="checkbox" checked={editing.ignoreTlsErrors} onChange={(event) => setEditing({ ...editing, ignoreTlsErrors: event.target.checked })} /> Ignore TLS certificate errors</label>
      <div className="modal-actions">{entries.some((item) => item.id === editing.id) && <button type="button" className="danger" onClick={() => { onChangeEntries(entries.filter((item) => item.id !== editing.id)); setEditing(null); }}>Remove</button>}<button type="button" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="confirm" onClick={save}>Save entry</button></div>
    </div>}
  </aside>;
}

export function ProxmoxVncWorkspace({ workspaceName, entries, activeEntryId, secrets, onSelectEntry, onChangeEntries, onChangeSecret }: Props) {
  const entry = entries.find((item) => item.id === activeEntryId) || entries[0];
  const secret = entry ? secrets[entry.id] || {} : {};
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<{ disconnect: () => void; sendCredentials: (credentials: { password: string }) => void; scaleViewport: boolean; resizeSession: boolean } | null>(null);
  const sessionGenerationRef = useRef(0);
  const previousEntryIdRef = useRef(activeEntryId);
  const [password, setPassword] = useState(secret.password || "");
  const [status, setStatus] = useState("Not connected");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [vms, setVms] = useState<VmSummary[]>([]);

  const stopConnection = (updateStatus = true) => {
    sessionGenerationRef.current += 1;
    rfbRef.current?.disconnect();
    rfbRef.current = null;
    setVms([]);
    if (updateStatus) setStatus("Disconnected");
  };

  useEffect(() => {
    if (previousEntryIdRef.current !== activeEntryId) {
      stopConnection();
      previousEntryIdRef.current = activeEntryId;
    }
    setPassword(entry ? secrets[entry.id]?.password || "" : "");
    setError("");
    if (previousEntryIdRef.current === activeEntryId && !rfbRef.current) setStatus("Not connected");
  }, [activeEntryId, entry?.id, secrets]);
  useEffect(() => () => {
    sessionGenerationRef.current += 1;
    rfbRef.current?.disconnect();
    rfbRef.current = null;
  }, []);

  const updatePassword = (value: string) => { setPassword(value); if (entry) onChangeSecret(entry.id, { password: value }); };
  const nativeEntry = entry ? { ...entry, guestType: entry.guestType, ignoreTlsErrors: entry.ignoreTlsErrors } : null;
  const loadVms = async () => {
    if (!nativeEntry || !password) return;
    setLoading(true); setError("");
    try { setVms(await invoke<VmSummary[]>("proxmox_list_vms", { entry: nativeEntry, password })); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setLoading(false); }
  };
  const connect = async () => {
    if (!nativeEntry || !password) { setError("Select an entry and enter the Proxmox password first."); return; }
    stopConnection(false);
    const sessionGeneration = sessionGenerationRef.current;
    const sessionEntryId = nativeEntry.id;
    setLoading(true); setError(""); setStatus("Connecting...");
    try {
      // noVNC is a public runtime asset, so keep its URL out of Vite's module graph.
      const noVncUrl = new URL("noVNC/core/rfb.js", window.location.href).href;
      const { default: RFB } = await import(/* @vite-ignore */ noVncUrl);
      const connection = await invoke<Connection>("proxmox_vnc_start", { entry: nativeEntry, password });
      if (sessionGeneration !== sessionGenerationRef.current || sessionEntryId !== entry?.id) {
        await invoke("proxmox_vnc_cancel", { connectionId: connection.id });
        return;
      }
      if (!screenRef.current) throw new Error("VNC screen is unavailable");
      const rfb = new RFB(screenRef.current, connection.websocketUrl);
      rfb.scaleViewport = true; rfb.resizeSession = false;
      rfb.addEventListener("connect", () => { if (sessionGeneration === sessionGenerationRef.current) setStatus("Connected"); });
      rfb.addEventListener("disconnect", () => { if (sessionGeneration === sessionGenerationRef.current) setStatus("Disconnected"); });
      rfb.addEventListener("securityfailure", (event: Event) => { if (sessionGeneration === sessionGenerationRef.current) setError(String((event as CustomEvent).detail || "VNC security failure")); });
      rfb.addEventListener("credentialsrequired", () => rfb.sendCredentials({ password: connection.password }));
      rfbRef.current = rfb;
    } catch (value) {
      if (sessionGeneration === sessionGenerationRef.current) {
        setStatus("Connection failed");
        setError(value instanceof Error ? value.message : String(value));
      }
    } finally {
      if (sessionGeneration === sessionGenerationRef.current) setLoading(false);
    }
  };
  const selectEntry = (id: string) => {
    if (id !== activeEntryId) stopConnection();
    onSelectEntry(id);
  };
  const chooseVm = (vm: VmSummary) => entry && onChangeEntries(entries.map((item) => item.id === entry.id ? { ...item, node: vm.node, vmid: vm.vmid, guestType: vm.guestType as "qemu" | "lxc" } : item));

  return <div className="vnc-workspace"><VncEntries entries={entries} activeEntryId={activeEntryId} onSelectEntry={selectEntry} onChangeEntries={onChangeEntries} />
    <section className="vnc-reader" aria-label="Proxmox VNC workspace">
      <div className="vnc-reader-heading"><div><span className="eyebrow">VNC mode · {workspaceName}</span><h1>{entry?.name || "Proxmox VNC"}</h1></div><span className="vnc-session-status">{status}</span></div>
      <div className="vnc-auth-panel"><div className="vnc-auth-grid"><label>Password<input type="password" value={password} onChange={(event) => updatePassword(event.target.value)} /></label><label>Node<input value={entry?.node || ""} onChange={(event) => entry && onChangeEntries(entries.map((item) => item.id === entry.id ? { ...item, node: event.target.value } : item))} /></label><label>VMID<input type="number" min="1" value={entry?.vmid || ""} onChange={(event) => entry && onChangeEntries(entries.map((item) => item.id === entry.id ? { ...item, vmid: event.target.value ? Number(event.target.value) : null } : item))} /></label></div><div className="vnc-actions"><button type="button" onClick={() => void loadVms()} disabled={loading || !entry}>{loading ? "Loading..." : "Load VMs"}</button><button type="button" className="confirm" onClick={() => void connect()} disabled={loading || !entry}>{loading ? "Connecting..." : "Connect"}</button><button type="button" onClick={() => stopConnection()} disabled={!rfbRef.current}>Disconnect</button></div>{entry?.ignoreTlsErrors && <div className="notice vnc-warning">TLS certificate verification is disabled for this entry.</div>}{error && <div className="notice rest-error">{error}</div>}</div>
      {!!vms.length && <div className="vnc-vm-list">{vms.map((vm) => <button type="button" key={`${vm.guestType}-${vm.vmid}`} onClick={() => chooseVm(vm)}><strong>{vm.name || `VM ${vm.vmid}`}</strong><span>{vm.guestType} · {vm.node} · {vm.status || "unknown"}</span></button>)}</div>}
      <div className="vnc-screen-shell"><div ref={screenRef} className="vnc-screen" /></div>
    </section>
  </div>;
}
