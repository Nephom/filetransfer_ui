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

type EntryAuthProps = {
  password: string;
  authenticated: boolean;
  loading: boolean;
  onPasswordChange: (value: string) => void;
  onLogin: () => void;
  onLogout: () => void;
};

const emptyEntry = (): ProxmoxVncEntry => ({
  id: crypto.randomUUID(), name: "New Proxmox VNC", baseUrl: "https://:8006", username: "root@pam",
  node: "", vmid: null, guestType: "qemu", proxmoxVersion: "auto", ignoreTlsErrors: false,
});

const endpointParts = (baseUrl: string) => {
  try {
    const url = new URL(baseUrl);
    return { host: url.hostname, port: Number(url.port) || 8006 };
  } catch {
    const match = baseUrl.match(/^https:\/\/([^/:]+)(?::(\d+))?/i);
    return { host: match?.[1] || "", port: Number(match?.[2]) || 8006 };
  }
};

const usernameParts = (username: string) => {
  const [account = "root", realm = "pam"] = username.split("@", 2);
  return { account, realm: realm === "pve" ? "pve" : "pam" };
};

function VncEntries({ entries, activeEntryId, onSelectEntry, onChangeEntries, password, authenticated, loading, onPasswordChange, onLogin, onLogout }: Pick<Props, "entries" | "activeEntryId" | "onSelectEntry" | "onChangeEntries"> & EntryAuthProps) {
  const [editing, setEditing] = useState<ProxmoxVncEntry | null>(null);
  const save = () => {
    const endpoint = editing ? endpointParts(editing.baseUrl) : null;
    const username = editing ? usernameParts(editing.username) : null;
    if (!editing || !editing.name.trim() || !endpoint?.host || endpoint.port < 1 || endpoint.port > 65535 || !username?.account.trim()) return;
    const next = entries.some((item) => item.id === editing.id)
      ? entries.map((item) => item.id === editing.id ? editing : item)
      : [...entries, editing];
    onChangeEntries(next); onSelectEntry(editing.id); setEditing(null);
  };
  const endpoint = editing ? endpointParts(editing.baseUrl) : { host: "", port: 8006 };
  const proxmoxUsername = editing ? usernameParts(editing.username) : { account: "root", realm: "pam" };
  const updateEndpoint = (host: string, port: number) => editing && setEditing({ ...editing, baseUrl: `https://${host}:${port || 8006}` });
  const updateUsername = (account: string, realm: string) => editing && setEditing({ ...editing, username: `${account}@${realm}` });
  return <aside className="vnc-entry-pane">
    <div className="vnc-entry-heading"><span className="sidebar-label">PROXMOX VNC ENTRIES</span><button type="button" className="confirm vnc-add-button" onClick={() => setEditing(emptyEntry())}>+ Add entry</button></div>
    <div className="vnc-entry-list">
      {!entries.length && <div className="vnc-empty">No Proxmox VNC entries yet.</div>}
      {entries.map((entry) => <button type="button" key={entry.id} className={`vnc-entry${entry.id === activeEntryId ? " active" : ""}`} onClick={() => onSelectEntry(entry.id)}>
        <span className="vnc-entry-dot" /><span className="vnc-entry-copy"><strong>{entry.name}</strong><small>{entry.baseUrl}</small><small>{entry.node || "No node"} / {entry.vmid || "No VMID"}</small></span><span className="vnc-entry-edit" onClick={(event) => { event.stopPropagation(); setEditing(entry); }}>Edit</span>
      </button>)}
    </div>
    <div className="vnc-entry-auth">
      <strong>{authenticated ? "Proxmox session active" : "Entry credentials"}</strong>
      {authenticated ? <button type="button" onClick={onLogout}>Logout</button> : <button type="button" className="confirm" onClick={onLogin} disabled={loading || !password}>{loading ? "Logging in..." : "Login"}</button>}
    </div>
    {editing && <div className="vnc-entry-editor">
      <div className="vnc-editor-heading"><strong>{entries.some((item) => item.id === editing.id) ? "Edit VNC entry" : "Add VNC entry"}</strong><button type="button" onClick={() => setEditing(null)} aria-label="Close editor">×</button></div>
      <label>Name<input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
      <div className="vnc-form-grid"><label>Proxmox host<input value={endpoint.host} onChange={(event) => updateEndpoint(event.target.value, endpoint.port)} placeholder="proxmox.example.com" /></label><label>Port<input type="number" min="1" max="65535" value={endpoint.port} onChange={(event) => updateEndpoint(endpoint.host, Number(event.target.value))} /></label></div>
      <div className="vnc-username-field"><label>Username<input value={proxmoxUsername.account} onChange={(event) => updateUsername(event.target.value, proxmoxUsername.realm)} placeholder="root" /></label><span className="vnc-realm-at">@</span><div className="vnc-realm-options"><label><input type="radio" name={`realm-${editing.id}`} checked={proxmoxUsername.realm === "pam"} onChange={() => updateUsername(proxmoxUsername.account, "pam")} /> pam</label><label><input type="radio" name={`realm-${editing.id}`} checked={proxmoxUsername.realm === "pve"} onChange={() => updateUsername(proxmoxUsername.account, "pve")} /> pve</label></div></div>
      <label>Password<input type="password" value={password} onChange={(event) => onPasswordChange(event.target.value)} /></label>
      <div className="vnc-form-grid"><label>PVE version<select value={editing.proxmoxVersion} onChange={(event) => setEditing({ ...editing, proxmoxVersion: event.target.value as ProxmoxVersion })}><option value="auto">Auto detect</option><option value="6.4">6.4</option><option value="7.x">7.x</option><option value="8.x">8.x</option><option value="9.x">9.x</option></select></label><div className="vnc-entry-login">{authenticated ? <><span>Session active</span><button type="button" onClick={onLogout}>Logout</button></> : <button type="button" className="confirm" onClick={onLogin} disabled={loading || !password}>{loading ? "Logging in..." : "Login"}</button>}</div></div>
      <label className="tls-option"><input type="checkbox" checked={editing.ignoreTlsErrors} onChange={(event) => setEditing({ ...editing, ignoreTlsErrors: event.target.checked })} /> Ignore TLS certificate errors</label>
      <div className="modal-actions">{entries.some((item) => item.id === editing.id) && <button type="button" className="danger" onClick={() => { onChangeEntries(entries.filter((item) => item.id !== editing.id)); setEditing(null); }}>Remove</button>}<button type="button" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="confirm" onClick={save}>Save entry</button></div>
    </div>}
  </aside>;
}

export function ProxmoxVncWorkspace({ workspaceName, entries, activeEntryId, secrets, onSelectEntry, onChangeEntries, onChangeSecret }: Props) {
  const entry = entries.find((item) => item.id === activeEntryId) || entries[0];
  const secret = entry ? secrets[entry.id] || {} : {};
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<{ disconnect: () => void; sendCredentials: (credentials: { password: string }) => void; sendCtrlAltDel: () => void; focus: () => void; viewOnly: boolean; scaleViewport: boolean; resizeSession: boolean } | null>(null);
  const sessionGenerationRef = useRef(0);
  const previousEntryIdRef = useRef(activeEntryId);
  const [password, setPassword] = useState(secret.password || "");
  const [status, setStatus] = useState("Not connected");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [vms, setVms] = useState<VmSummary[]>([]);
  const [controlsOpen, setControlsOpen] = useState(true);
  const [screenHeight, setScreenHeight] = useState(560);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [viewOnly, setViewOnly] = useState(false);
  const screenShellRef = useRef<HTMLDivElement>(null);
  const [authSessions, setAuthSessions] = useState<Record<string, string>>({});

  const stopConnection = (updateStatus = true) => {
    sessionGenerationRef.current += 1;
    rfbRef.current?.disconnect();
    rfbRef.current = null;
    setVms([]);
    setViewOnly(false);
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

  useEffect(() => {
    const updateFullscreen = () => setIsFullscreen(document.fullscreenElement === screenShellRef.current);
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  const resizeScreen = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = screenHeight;
    const move = (moveEvent: PointerEvent) => {
      setScreenHeight(Math.max(280, Math.min(window.innerHeight * 0.85, startHeight + moveEvent.clientY - startY)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

  const toggleFullscreen = async () => {
    if (!screenShellRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await screenShellRef.current.requestFullscreen();
  };

  const updatePassword = (value: string) => { setPassword(value); if (entry) onChangeSecret(entry.id, { password: value }); };
  const nativeEntry = entry ? { ...entry, guestType: entry.guestType, ignoreTlsErrors: entry.ignoreTlsErrors } : null;
  const authenticated = Boolean(entry && authSessions[entry.id]);
  const loginEntry = async () => {
    if (!nativeEntry || !password) return;
    setLoading(true); setError("");
    try {
      const sessionId = await invoke<string>("proxmox_login", { entry: nativeEntry, password });
      setAuthSessions((current) => ({ ...current, [nativeEntry.id]: sessionId }));
      await loadVms(sessionId, nativeEntry);
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setLoading(false); }
  };
  const logoutEntry = async () => {
    if (!entry) return;
    stopConnection();
    const sessionId = authSessions[entry.id];
    if (sessionId) await invoke("proxmox_logout", { sessionId }).catch(() => undefined);
    setAuthSessions((current) => { const next = { ...current }; delete next[entry.id]; return next; });
  };
  const loadVms = async (sessionId = nativeEntry ? authSessions[nativeEntry.id] : undefined, targetEntry = nativeEntry) => {
    if (!targetEntry || !sessionId) { setError("Log in to this Proxmox entry first."); return; }
    setLoading(true); setError("");
    try { setVms(await invoke<VmSummary[]>("proxmox_list_vms_session", { entry: targetEntry, sessionId })); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setLoading(false); }
  };
  const connect = async () => {
    if (!nativeEntry || !authenticated) { setError("Log in to this Proxmox entry first."); return; }
    stopConnection(false);
    const sessionGeneration = sessionGenerationRef.current;
    const sessionEntryId = nativeEntry.id;
    setLoading(true); setError(""); setStatus("Connecting...");
    try {
      // noVNC is a public runtime asset, so keep its URL out of Vite's module graph.
      const noVncUrl = new URL("noVNC/core/rfb.js", window.location.href).href;
      const { default: RFB } = await import(/* @vite-ignore */ noVncUrl);
      const connection = await invoke<Connection>("proxmox_vnc_start_session", { entry: nativeEntry, sessionId: authSessions[nativeEntry.id] });
      if (sessionGeneration !== sessionGenerationRef.current || sessionEntryId !== entry?.id) {
        await invoke("proxmox_vnc_cancel", { connectionId: connection.id });
        return;
      }
      if (!screenRef.current) throw new Error("VNC screen is unavailable");
      const rfb = new RFB(screenRef.current, connection.websocketUrl);
      rfb.scaleViewport = true; rfb.resizeSession = false; rfb.viewOnly = viewOnly;
      rfb.addEventListener("connect", () => { if (sessionGeneration === sessionGenerationRef.current) { setStatus("Connected"); setControlsOpen(false); } });
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
  const nodes = [...new Set(vms.map((vm) => vm.node))].sort();
  const selectedNode = entry?.node || "";
  const nodeVms = vms.filter((vm) => vm.node === selectedNode);
  const selectedVm = vms.find((vm) => vm.node === entry?.node && vm.vmid === entry?.vmid);
  const updateEntry = (updates: Partial<ProxmoxVncEntry>) => entry && onChangeEntries(entries.map((item) => item.id === entry.id ? { ...item, ...updates } : item));
  const chooseNode = (node: string) => updateEntry({ node, vmid: null });
  const chooseVm = (vmid: string) => {
    const vm = nodeVms.find((item) => String(item.vmid) === vmid);
    if (vm) updateEntry({ node: vm.node, vmid: vm.vmid, guestType: vm.guestType as "qemu" | "lxc" });
  };
  const toggleViewOnly = () => {
    const next = !viewOnly;
    setViewOnly(next);
    if (rfbRef.current) rfbRef.current.viewOnly = next;
  };

  return <div className="vnc-workspace"><VncEntries entries={entries} activeEntryId={activeEntryId} onSelectEntry={selectEntry} onChangeEntries={onChangeEntries} password={password} authenticated={authenticated} loading={loading} onPasswordChange={updatePassword} onLogin={() => void loginEntry()} onLogout={() => void logoutEntry()} />
    <section className="vnc-reader" aria-label="Proxmox VNC workspace">
      <div className="vnc-reader-heading"><div><span className="eyebrow">VNC mode · {workspaceName}</span><h1>{entry?.name || "Proxmox VNC"}</h1></div><span className="vnc-session-status">{status}</span></div>
      <div className={`vnc-auth-panel${controlsOpen ? " open" : " collapsed"}`}><div className="vnc-auth-heading"><strong>Connection controls</strong><button type="button" onClick={() => setControlsOpen((value) => !value)}>{controlsOpen ? "Collapse" : "Expand"}</button></div>{controlsOpen && <><div className="vnc-auth-grid"><label>Node<select value={selectedNode} onChange={(event) => chooseNode(event.target.value)} disabled={!authenticated || !nodes.length}><option value="">{authenticated ? "Select node" : "Login first"}</option>{nodes.map((node) => <option key={node} value={node}>{node}</option>)}</select></label><label>VM<select value={selectedVm ? String(selectedVm.vmid) : ""} onChange={(event) => chooseVm(event.target.value)} disabled={!authenticated || !selectedNode || !nodeVms.length}><option value="">{selectedNode ? "Select VM" : "Select node first"}</option>{nodeVms.map((vm) => <option key={`${vm.guestType}-${vm.vmid}`} value={vm.vmid}>{vm.name || `VM ${vm.vmid}`} ({vm.vmid})</option>)}</select></label></div><div className="vnc-actions"><button type="button" className="confirm" onClick={() => void connect()} disabled={loading || !entry || !authenticated || !selectedVm}>{loading ? "Connecting..." : "Connect"}</button><button type="button" onClick={() => stopConnection()} disabled={!rfbRef.current}>Disconnect</button><button type="button" onClick={() => void logoutEntry()} disabled={!authenticated}>Logout</button></div>{entry?.ignoreTlsErrors && <div className="notice vnc-warning">TLS certificate verification is disabled for this entry.</div>}{error && <div className="notice rest-error">{error}</div>}</>}</div>
       <div className="vnc-screen-resize" role="separator" aria-label="Resize VNC display" onPointerDown={resizeScreen} /><div ref={screenShellRef} className={`vnc-screen-shell${isFullscreen ? " fullscreen" : ""}`} style={{ "--vnc-screen-height": `${screenHeight}px` } as React.CSSProperties}><div className="vnc-display-toolbar"><button type="button" onClick={() => rfbRef.current?.sendCtrlAltDel()} disabled={!rfbRef.current}>Ctrl+Alt+Del</button><button type="button" onClick={() => rfbRef.current?.focus()} disabled={!rfbRef.current}>Focus</button><button type="button" onClick={toggleViewOnly} disabled={!rfbRef.current}>{viewOnly ? "Enable input" : "View only"}</button><button type="button" onClick={() => void toggleFullscreen()}>{isFullscreen ? "Exit fullscreen" : "Fullscreen"}</button></div><div ref={screenRef} className="vnc-screen" /></div>
    </section>
  </div>;
}
