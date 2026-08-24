import React, { useEffect, useRef, useState } from "react";
import "./proxmox-vnc.css";
import { invoke } from "@tauri-apps/api/core";
import { PaneResizeHandle } from "./resizable-pane";
import { MobileChoiceMenu } from "./ui/MobileChoiceMenu";
import { EntryActionsMenu } from "./ui/EntryActionsMenu";
import { ChevronLeftIcon, ChevronRightIcon } from "./ui/icons";
import { Dropdown } from "./ui/Dropdown";

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
  collapseMainPaneEnabled: boolean;
  onSelectEntry: (id: string) => void;
  onChangeEntries: (entries: ProxmoxVncEntry[]) => void;
  onChangeSecret: (entryId: string, secret: ProxmoxVncSecret) => void;
  onAddEntry: () => void;
  onEditEntry: (entry: ProxmoxVncEntry) => void;
  onRemoveEntry: (entry: ProxmoxVncEntry) => void;
};

type EntryAuthProps = {
  password: string;
  authenticated: boolean;
  loading: boolean;
  onPasswordChange: (value: string) => void;
  onLogin: () => void;
  onLogout: () => void;
};

// Entry management: adding a Workspace and its first entry, or bulk edits
// via onChangeEntries, is still driven from the Sessions/Workspace Manager,
// but the sidebar itself now owns Add/Edit/Remove for individual entries
// (see T-218) so switching entries no longer requires leaving VNC mode to
// reach the Workspace Manager. The currently-selected entry's Proxmox
// login/logout stays here too (an operational session action, not entry
// identity data).
function VncEntries({ entries, activeEntryId, onSelectEntry, onAddEntry, onEditEntry, onRemoveEntry, password, authenticated, loading, onPasswordChange, onLogin, onLogout }: Pick<Props, "entries" | "activeEntryId" | "onSelectEntry" | "onAddEntry" | "onEditEntry" | "onRemoveEntry"> & EntryAuthProps) {
  return <aside className="vnc-entry-pane">
    <div className="vnc-entry-heading">
      <span className="sidebar-label">PROXMOX VNC ENTRIES</span>
      <button type="button" className="vnc-entry-add" onClick={onAddEntry}>+ Add</button>
    </div>
    <MobileChoiceMenu className="vnc-entry-choice" label="VNC entry" currentId={activeEntryId} options={entries.map((entry) => ({ id: entry.id, label: entry.name }))} onSelect={onSelectEntry} />
    <div className="vnc-entry-list">
      {!entries.length && <div className="vnc-empty">No Proxmox VNC entries yet. Use the Add button above to create one.</div>}
      {entries.map((entry) => <div className="vnc-entry-row" key={entry.id}>
        <button type="button" className={`vnc-entry${entry.id === activeEntryId ? " active" : ""}`} onClick={() => onSelectEntry(entry.id)}>
          <span className="vnc-entry-dot" /><span className="vnc-entry-copy"><strong>{entry.name}</strong><small>{entry.baseUrl}</small><small>{entry.node || "No node"} / {entry.vmid || "No VMID"}</small></span>
        </button>
        <EntryActionsMenu entryName={entry.name} onEdit={() => onEditEntry(entry)} onRemove={() => onRemoveEntry(entry)} />
      </div>)}
    </div>
    <div className="vnc-entry-auth">
      <strong>{authenticated ? "Proxmox session active" : "Entry credentials"}</strong>
      {!authenticated && <input type="password" value={password} onChange={(event) => onPasswordChange(event.target.value)} placeholder="Proxmox password" autoComplete="new-password" />}
      {authenticated ? <button type="button" onClick={onLogout}>Logout</button> : <button type="button" className="confirm" onClick={onLogin} disabled={loading || !password}>{loading ? "Logging in..." : "Login"}</button>}
    </div>
  </aside>;
}

export function ProxmoxVncWorkspace({ workspaceName, entries, activeEntryId, secrets, collapseMainPaneEnabled, onSelectEntry, onChangeEntries, onChangeSecret, onAddEntry, onEditEntry, onRemoveEntry }: Props) {
  const entry = entries.find((item) => item.id === activeEntryId) || entries[0];
  const secret = entry ? secrets[entry.id] || {} : {};
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<{ disconnect: () => void; sendCredentials: (credentials: { password: string }) => void; sendCtrlAltDel: () => void; focus: () => void; viewOnly: boolean; scaleViewport: boolean; resizeSession: boolean } | null>(null);
  const pendingConnectionIdRef = useRef<string | null>(null);
  const sessionGenerationRef = useRef(0);
  const previousEntryIdRef = useRef(activeEntryId);
  const [password, setPassword] = useState(secret.password || "");
  const [status, setStatus] = useState("Not connected");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [vms, setVms] = useState<VmSummary[]>([]);
  const [controlsOpen, setControlsOpen] = useState(true);
  const [controlsRatio, setControlsRatio] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [viewOnly, setViewOnly] = useState(false);
  const screenShellRef = useRef<HTMLDivElement>(null);
  const vncReaderRef = useRef<HTMLElement>(null);
  const [authSessions, setAuthSessions] = useState<Record<string, string>>({});
  const [entryPaneWidth, setEntryPaneWidth] = useState(() => Number(localStorage.getItem("fileapi-vnc-entry-pane-width")) || 380);
  const [entryPaneCollapsed, setEntryPaneCollapsed] = useState(false);
  const entryPaneResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const stopEntryPaneResize = () => {
    entryPaneResizeRef.current = null;
    window.removeEventListener("pointermove", resizeEntryPane);
    window.removeEventListener("pointerup", stopEntryPaneResize);
  };
  const resizeEntryPane = (event: PointerEvent) => {
    const start = entryPaneResizeRef.current;
    if (!start) return;
    const maxWidth = Math.max(220, Math.min(720, window.innerWidth - 300));
    setEntryPaneWidth(Math.max(220, Math.min(maxWidth, start.startWidth + event.clientX - start.startX)));
  };
  const beginEntryPaneResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    entryPaneResizeRef.current = { startX: event.clientX, startWidth: entryPaneWidth };
    window.addEventListener("pointermove", resizeEntryPane);
    window.addEventListener("pointerup", stopEntryPaneResize);
  };
  useEffect(() => {
    localStorage.setItem("fileapi-vnc-entry-pane-width", String(entryPaneWidth));
  }, [entryPaneWidth]);
  useEffect(() => () => stopEntryPaneResize(), []);

  const stopConnection = (updateStatus = true) => {
    sessionGenerationRef.current += 1;
    rfbRef.current?.disconnect();
    rfbRef.current = null;
    const pendingConnectionId = pendingConnectionIdRef.current;
    pendingConnectionIdRef.current = null;
    if (pendingConnectionId) void invoke("proxmox_vnc_cancel", { connectionId: pendingConnectionId });
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
    if (pendingConnectionIdRef.current) {
      void invoke("proxmox_vnc_cancel", { connectionId: pendingConnectionIdRef.current });
      pendingConnectionIdRef.current = null;
    }
  }, []);

  useEffect(() => {
    const updateFullscreen = () => setIsFullscreen(document.fullscreenElement === screenShellRef.current);
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  const resizeControls = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const reader = vncReaderRef.current;
    if (!reader) return;
    const startRatio = controlsRatio ?? 0.25;
    const availableHeight = Math.max(1, reader.clientHeight - 12);
    const move = (moveEvent: PointerEvent) => {
      const deltaRatio = (moveEvent.clientY - startY) / availableHeight;
      setControlsRatio(Math.max(0.2, Math.min(0.8, startRatio + deltaRatio)));
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
      pendingConnectionIdRef.current = connection.id;
      if (sessionGeneration !== sessionGenerationRef.current || sessionEntryId !== entry?.id) {
        await invoke("proxmox_vnc_cancel", { connectionId: connection.id });
        pendingConnectionIdRef.current = null;
        return;
      }
      if (!screenRef.current) throw new Error("VNC screen is unavailable");
      const rfb = new RFB(screenRef.current, connection.websocketUrl);
      pendingConnectionIdRef.current = null;
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

  return <div className={`vnc-workspace${entryPaneCollapsed ? " vnc-entry-pane-collapsed" : ""}`}><div className="vnc-entry-pane-shell" style={{ flexBasis: `${entryPaneWidth}px` }}><VncEntries entries={entries} activeEntryId={activeEntryId} onSelectEntry={selectEntry} onAddEntry={onAddEntry} onEditEntry={onEditEntry} onRemoveEntry={onRemoveEntry} password={password} authenticated={authenticated} loading={loading} onPasswordChange={updatePassword} onLogin={() => void loginEntry()} onLogout={() => void logoutEntry()} /></div>{collapseMainPaneEnabled ? <div className="vnc-main-pane-collapse-controls" role="group" aria-label="VNC pane visibility"><button type="button" onClick={() => setEntryPaneCollapsed(true)} disabled={entryPaneCollapsed} aria-label="Collapse VNC entry pane" title="Collapse VNC entry pane"><ChevronLeftIcon /></button><button type="button" onClick={() => setEntryPaneCollapsed(false)} disabled={!entryPaneCollapsed} aria-label="Restore VNC entry pane" title="Restore VNC entry pane"><ChevronRightIcon /></button></div> : <PaneResizeHandle ariaLabel="Resize Proxmox VNC entries pane" onStart={beginEntryPaneResize} onMove={(event) => resizeEntryPane(event.nativeEvent)} onEnd={stopEntryPaneResize} />}
    <section ref={vncReaderRef} className="vnc-reader" aria-label="Proxmox VNC workspace">
      <div className="vnc-reader-heading"><div><span className="eyebrow">VNC mode · {workspaceName}</span><h1>{entry?.name || "Proxmox VNC"}</h1></div><span className="vnc-session-status">{status}</span></div>
      <div className="vnc-display-split" style={{ "--controls-row": controlsRatio === null ? "auto" : `${controlsRatio}fr`, "--screen-row": controlsRatio === null ? "1fr" : `${1 - controlsRatio}fr` } as React.CSSProperties}><div className={`vnc-auth-panel${controlsOpen ? " open" : " collapsed"}`}><div className="vnc-auth-heading"><strong>Connection controls</strong><button type="button" onClick={() => { setControlsOpen((value) => !value); setControlsRatio(null); }}>{controlsOpen ? "Collapse" : "Expand"}</button></div>{controlsOpen && <><div className="vnc-auth-grid"><label>Node<Dropdown label="Node" value={selectedNode} onChange={chooseNode} disabled={!authenticated || !nodes.length} placeholder={authenticated ? "Select node" : "Login first"} options={nodes.map((node) => ({ value: node, label: node }))} /></label><label>VM<Dropdown label="VM" value={selectedVm ? String(selectedVm.vmid) : ""} onChange={chooseVm} disabled={!authenticated || !selectedNode || !nodeVms.length} placeholder={selectedNode ? "Select VM" : "Select node first"} options={nodeVms.map((vm) => ({ value: String(vm.vmid), label: `${vm.name || `VM ${vm.vmid}`} (${vm.vmid})` }))} /></label></div><div className="vnc-actions"><button type="button" className="confirm" onClick={() => void connect()} disabled={loading || !entry || !authenticated || !selectedVm}>{loading ? "Connecting..." : "Connect"}</button><button type="button" onClick={() => stopConnection()} disabled={!rfbRef.current}>Disconnect</button><button type="button" onClick={() => void logoutEntry()} disabled={!authenticated}>Logout</button></div>{entry?.ignoreTlsErrors && <div className="notice vnc-warning">TLS certificate verification is disabled for this entry.</div>}{error && <div className="notice rest-error">{error}</div>}</>}</div><div className="vnc-screen-resize" role="separator" aria-label="Resize Connection controls" title="Drag downward to enlarge Connection controls" onPointerDown={resizeControls} /><div ref={screenShellRef} className={`vnc-screen-shell${isFullscreen ? " fullscreen" : ""}`}><div className="vnc-display-toolbar"><button type="button" onClick={() => rfbRef.current?.sendCtrlAltDel()} disabled={!rfbRef.current}>Ctrl+Alt+Del</button><button type="button" onClick={() => rfbRef.current?.focus()} disabled={!rfbRef.current}>Focus</button><button type="button" onClick={toggleViewOnly} disabled={!rfbRef.current}>{viewOnly ? "Enable input" : "View only"}</button><button type="button" onClick={() => void toggleFullscreen()}>{isFullscreen ? "Exit fullscreen" : "Fullscreen"}</button></div><div ref={screenRef} className="vnc-screen" /></div></div>
    </section>
  </div>;
}
