import React, { useEffect, useRef, useState } from "react";
import "./proxmox-vnc.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PaneResizeHandle } from "./resizable-pane";
import { MobileChoiceMenu } from "./ui/MobileChoiceMenu";
import { EntryActionsMenu } from "./ui/EntryActionsMenu";
import { ChevronLeftIcon, ChevronRightIcon } from "./ui/icons";
import { Dropdown } from "./ui/Dropdown";
import { formatQueueEta, formatQueueRate, QueueProgress, updateQueueProgress } from "./queue/progress";
import { classifyQueueError, retryDelayMs } from "./queue/recovery";

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
  // File-transfer credentials (VNC file transfer integration). Identity-only
  // fields: passwords are never stored here -- they live in the OS keyring
  // via ssh_save_password, keyed by vmSshProfileId(entry.id) /
  // hostSshProfileId(entry.id) below, reusing the same storage mechanism a
  // regular Terminal SSH entry uses so the Rust authenticate() routine needs
  // no changes to find them.
  vmSshUsername?: string;
  vmSshPort?: number;
  vmSshPrivateKeyPath?: string;
  hostSshUsername?: string;
  hostSshPort?: number;
  hostSshPrivateKeyPath?: string;
  // Manual fallback VM IP, used when the QEMU Guest Agent can't be reached
  // (LXC guests, or a qemu guest with the agent not installed/running) but
  // the VM is still known to have a reachable (direct- or jump-host) IP.
  fileTransferIpOverride?: string;
};
export type ProxmoxVncSecret = { password?: string };
type VmSummary = { vmid: number; name?: string; node: string; status?: string; guestType: string };
type Connection = { id: string; websocketUrl: string; password: string };

// --- File transfer -----------------------------------------------------
//
// Three transfer modes, tried in this order once a VNC session connects:
//   1. direct-sftp: this client machine can reach the VM's own IP on its
//      SSH port directly -- full, unrestricted SFTP via the existing
//      russh-based ssh_* commands (the same ones LOCATION mode's SSH
//      Remote uses).
//   2. jump-sftp: the VM isn't directly reachable, but the Proxmox host is;
//      SFTP is tunneled through the host via an SSH `direct-tcpip` channel
//      (see src-tauri/src/ssh/mod.rs::connect_transport). Still full SFTP.
//   3. guest-agent: neither is reachable (or no SSH credentials are
//      configured); falls back to the Proxmox QEMU Guest Agent REST API
//      (qemu-only, Linux/Unix guest commands only, chunked so large
//      uploads are rejected up front -- see src-tauri/src/proxmox.rs).
export type VmFileEntry = { name: string; path: string; isDirectory: boolean; size: number; modified: number };
type VncFolderNode = { path: string; name: string; expanded: boolean; loaded: boolean; children: VncFolderNode[] };
export type VncTransferMode = "unknown" | "detecting" | "direct-sftp" | "jump-sftp" | "guest-agent" | "unavailable";
type VncQueueStatus = "queued" | "running" | "retrying" | "completed" | "failed";
type VncQueueItem = {
  id: string;
  kind: "upload" | "download";
  label: string;
  detail: string;
  status: VncQueueStatus;
  progress?: QueueProgress;
};
type SshTransferProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
  jumpHost?: string;
  jumpPort?: number;
  jumpUsername?: string;
  jumpPrivateKeyPath?: string;
  jumpProfileId?: string;
};

/// Synthetic SSH profile ids used to store/lookup the VM's own SSH password
/// and the Proxmox host's own SSH password (for jump-host tunneling) in the
/// OS keyring via the existing ssh_save_password/ssh_forget_password/
/// ssh_has_password commands -- kept distinct from both the entry's own id
/// (used for the Proxmox *web* login password) and from any independent
/// Terminal SSH entry the user might separately manage, so none of the three
/// ever collide.
export const vmSshProfileId = (entryId: string) => `vncvm:${entryId}`;
export const hostSshProfileId = (entryId: string) => `vncjump:${entryId}`;

const REACHABILITY_TIMEOUT_MS = 1500;
const MAX_TRANSFER_RETRIES = 2;

export const proxmoxHostFromBaseUrl = (baseUrl: string): string => {
  try { return new URL(baseUrl).hostname; } catch { return ""; }
};

const formatFileSize = (bytes: number): string => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const formatModifiedDate = (millis: number): string => {
  if (!millis) return "--";
  try { return new Date(millis).toLocaleString(); } catch { return "--"; }
};

const transferModeLabel = (mode: VncTransferMode): string => {
  switch (mode) {
    case "direct-sftp": return "SFTP (direct)";
    case "jump-sftp": return "SFTP (via host jump)";
    case "guest-agent": return "Guest Agent (limited)";
    case "detecting": return "Detecting…";
    case "unavailable": return "Unavailable";
    default: return "Not connected";
  }
};

const formatQueueDetailProgress = (progress: QueueProgress | undefined) => {
  if (!progress) return "";
  const percentage = progress.percentage === null ? "" : ` (${Math.round(progress.percentage)}%)`;
  const rate = progress.bytesPerSecond === null ? "" : ` · ${formatQueueRate(progress.bytesPerSecond)}`;
  const eta = progress.etaSeconds === null ? "" : ` · ETA ${formatQueueEta(progress.etaSeconds)}`;
  return `${percentage}${rate}${eta}`;
};

const emptyRemoteTree = (): VncFolderNode => ({ path: "/", name: "/", expanded: true, loaded: false, children: [] });

const updateTreeNode = (node: VncFolderNode, targetPath: string, updater: (node: VncFolderNode) => VncFolderNode): VncFolderNode =>
  node.path === targetPath ? updater(node) : { ...node, children: node.children.map((child) => updateTreeNode(child, targetPath, updater)) };

function VncTreeNode({ node, activePath, onToggle, onSelect }: { node: VncFolderNode; activePath: string; onToggle: (node: VncFolderNode) => void; onSelect: (path: string) => void }) {
  return (
    <div className="folder-tree">
      <div className={`tree-node${node.path === activePath ? " active" : ""}`}>
        <button type="button" className="tree-toggle" aria-label={`${node.expanded ? "Collapse" : "Expand"} ${node.name}`} onClick={() => onToggle(node)}>{node.expanded ? "\u2212" : "+"}</button>
        <button type="button" className="tree-folder" onClick={() => onSelect(node.path)}><span className="folder-mini" />{node.name}</button>
      </div>
      {node.expanded && (
        <div className="tree-children">
          {node.loaded
            ? node.children.map((child) => <VncTreeNode key={child.path} node={child} activePath={activePath} onToggle={onToggle} onSelect={onSelect} />)
            : <span className="tree-loading">Loading folders...</span>}
        </div>
      )}
    </div>
  );
}

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

type FileBrowserProps = {
  visible: boolean;
  loading: boolean;
  error: string;
  modeLabel: string;
  mode: VncTransferMode;
  root: VncFolderNode;
  activePath: string;
  onToggle: (node: VncFolderNode) => void;
  onSelect: (path: string) => void;
  onBack: () => void;
};

// Entry management: adding a Workspace and its first entry, or bulk edits
// via onChangeEntries, is still driven from the Sessions/Workspace Manager,
// but the sidebar itself now owns Add/Edit/Remove for individual entries
// (see T-218) so switching entries no longer requires leaving VNC mode to
// reach the Workspace Manager. The currently-selected entry's Proxmox
// login/logout stays here too (an operational session action, not entry
// identity data). Once a file-transfer route to the connected VM is found,
// this same pane switches from the entries list to a lazily-loaded remote
// directory tree (fileBrowser.visible) so the user can browse the VM's
// filesystem to pick an upload/download target, exactly like LOCATION
// mode's folder tree -- with a "Entries" back button to return.
function VncEntries({ entries, activeEntryId, onSelectEntry, onAddEntry, onEditEntry, onRemoveEntry, password, authenticated, loading, onPasswordChange, onLogin, onLogout, fileBrowser }: Pick<Props, "entries" | "activeEntryId" | "onSelectEntry" | "onAddEntry" | "onEditEntry" | "onRemoveEntry"> & EntryAuthProps & { fileBrowser: FileBrowserProps }) {
  if (fileBrowser.visible) {
    return <aside className="vnc-entry-pane vnc-entry-pane-files">
      <div className="vnc-entry-heading">
        <button type="button" className="vnc-entry-back" onClick={fileBrowser.onBack}>&larr; Entries</button>
        <span className="vnc-reachability-status" data-mode={fileBrowser.mode}>{fileBrowser.modeLabel}</span>
      </div>
      <div className="vnc-tree-scroll">
        {fileBrowser.loading && <div className="vnc-empty">Detecting how to reach this VM for file transfer...</div>}
        {!fileBrowser.loading && fileBrowser.error && <div className="notice rest-error">{fileBrowser.error}</div>}
        {!fileBrowser.loading && !fileBrowser.error && <VncTreeNode node={fileBrowser.root} activePath={fileBrowser.activePath} onToggle={fileBrowser.onToggle} onSelect={fileBrowser.onSelect} />}
      </div>
    </aside>;
  }
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

  // --- File transfer state --------------------------------------------
  const [activeView, setActiveView] = useState<"screen" | "files">("screen");
  const [transferMode, setTransferMode] = useState<VncTransferMode>("unknown");
  const [transferError, setTransferError] = useState("");
  const [guestIp, setGuestIp] = useState("");
  const [remotePath, setRemotePath] = useState("/");
  const [remoteFiles, setRemoteFiles] = useState<VmFileEntry[]>([]);
  const [remoteFilesLoading, setRemoteFilesLoading] = useState(false);
  const [remoteFilesError, setRemoteFilesError] = useState("");
  const [selectedRemotePaths, setSelectedRemotePaths] = useState<Set<string>>(new Set());
  const [remoteTree, setRemoteTree] = useState<VncFolderNode>(emptyRemoteTree());
  const [vncQueue, setVncQueue] = useState<VncQueueItem[]>([]);
  const progressSamplesRef = useRef<Record<string, { bytes: number; at: number }[]>>({});

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

  const resetTransferState = () => {
    setActiveView("screen");
    setTransferMode("unknown");
    setTransferError("");
    setGuestIp("");
    setRemotePath("/");
    setRemoteFiles([]);
    setRemoteFilesError("");
    setSelectedRemotePaths(new Set());
    setRemoteTree(emptyRemoteTree());
    setVncQueue([]);
    progressSamplesRef.current = {};
  };

  const stopConnection = (updateStatus = true) => {
    sessionGenerationRef.current += 1;
    rfbRef.current?.disconnect();
    rfbRef.current = null;
    const pendingConnectionId = pendingConnectionIdRef.current;
    pendingConnectionIdRef.current = null;
    if (pendingConnectionId) void invoke("proxmox_vnc_cancel", { connectionId: pendingConnectionId });
    setVms([]);
    setViewOnly(false);
    resetTransferState();
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

  // --- File transfer mode detection -----------------------------------
  //
  // Runs once the VNC session itself is connected (see the RFB "connect"
  // listener in connect() below). Priority: a directly-reachable VM IP
  // (full SFTP) > a VM IP reachable only via an SSH jump through the
  // Proxmox host (still full SFTP) > the QEMU Guest Agent REST API
  // fallback (qemu guests only, size-limited). All three checks run
  // entirely from this desktop client -- via pure-Rust `tokio::net`
  // TCP probes and the pure-Rust `russh`/`russh-sftp` stack, never a
  // system ssh/ping/telnet binary -- so behavior is identical whether the
  // client machine is Windows, macOS, or Linux.
  const detectTransferMode = async () => {
    if (!entry || !nativeEntry) return;
    setTransferMode("detecting");
    setTransferError("");
    setGuestIp("");
    const sessionId = authSessions[entry.id];
    const vmSshPort = entry.vmSshPort || 22;
    const hostSshPort = entry.hostSshPort || 22;
    const proxmoxHost = proxmoxHostFromBaseUrl(entry.baseUrl);

    let agentAlive = false;
    let candidates: string[] = [];
    if (entry.guestType === "qemu" && sessionId) {
      try {
        await invoke("proxmox_agent_ping", { entry: nativeEntry, sessionId });
        agentAlive = true;
        candidates = await invoke<string[]>("proxmox_agent_network_interfaces", { entry: nativeEntry, sessionId });
      } catch {
        agentAlive = false;
      }
    }
    if (entry.fileTransferIpOverride?.trim()) candidates = [entry.fileTransferIpOverride.trim(), ...candidates];

    for (const ip of candidates) {
      const reachable = await invoke<boolean>("tcp_check_reachable", { host: ip, port: vmSshPort, timeoutMs: REACHABILITY_TIMEOUT_MS }).catch(() => false);
      if (reachable) {
        setGuestIp(ip);
        setTransferMode("direct-sftp");
        return;
      }
    }

    const jumpCandidate = candidates[0];
    if (jumpCandidate && proxmoxHost && entry.hostSshUsername?.trim()) {
      const hostReachable = await invoke<boolean>("tcp_check_reachable", { host: proxmoxHost, port: hostSshPort, timeoutMs: REACHABILITY_TIMEOUT_MS }).catch(() => false);
      if (hostReachable) {
        setGuestIp(jumpCandidate);
        setTransferMode("jump-sftp");
        return;
      }
    }

    if (agentAlive) {
      setTransferMode("guest-agent");
      return;
    }

    setTransferMode("unavailable");
    setTransferError(
      entry.guestType === "qemu"
        ? "The QEMU Guest Agent isn't responding and no reachable IP was found for direct or jump-host SFTP. Check the VM's network/Guest Agent status, or set VM SSH / Host SSH credentials and a fallback IP in this entry."
        : "This LXC guest has no Guest Agent API. Provide a reachable VM IP (Host SSH / override) with SSH credentials in this entry to enable file transfer.",
    );
  };

  // Once a transfer route is found, load the root of the remote directory
  // tree and the file list for "/" -- this is what makes the sidebar
  // automatically switch to the VM's filesystem once VNC connects. Depends
  // on transferMode/guestIp directly (not called inline from
  // detectTransferMode) so it always sees the just-committed state instead
  // of a stale closure captured before those setters ran.
  useEffect(() => {
    if (transferMode === "direct-sftp" || transferMode === "jump-sftp" || transferMode === "guest-agent") {
      setRemotePath("/");
      setRemoteTree(emptyRemoteTree());
      void loadRemoteFiles("/");
      void loadTreeChildren("/");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferMode, guestIp]);

  const buildSshProfile = (): SshTransferProfile => {
    const base: SshTransferProfile = {
      id: vmSshProfileId(entry?.id || "unknown"),
      name: `${entry?.name || "VM"} (VM)`,
      host: guestIp,
      port: entry?.vmSshPort || 22,
      username: entry?.vmSshUsername || "root",
      privateKeyPath: entry?.vmSshPrivateKeyPath || "",
    };
    if (transferMode !== "jump-sftp" || !entry) return base;
    return {
      ...base,
      jumpHost: proxmoxHostFromBaseUrl(entry.baseUrl),
      jumpPort: entry.hostSshPort || 22,
      jumpUsername: entry.hostSshUsername || "root",
      jumpPrivateKeyPath: entry.hostSshPrivateKeyPath || "",
      jumpProfileId: hostSshProfileId(entry.id),
    };
  };

  const loadRemoteFiles = async (path: string) => {
    if (!nativeEntry) return;
    setRemoteFilesLoading(true);
    setRemoteFilesError("");
    try {
      const result = transferMode === "guest-agent"
        ? await invoke<{ path: string; files: VmFileEntry[] }>("proxmox_agent_list_directory", { entry: nativeEntry, sessionId: authSessions[nativeEntry.id], path })
        : await invoke<{ path: string; files: VmFileEntry[] }>("ssh_list_directory", { profile: buildSshProfile(), path });
      const sorted = result.files.slice().sort((left, right) => Number(right.isDirectory) - Number(left.isDirectory) || left.name.localeCompare(right.name));
      setRemoteFiles(sorted);
      setRemotePath(result.path);
      setSelectedRemotePaths(new Set());
    } catch (listError) {
      setRemoteFilesError(listError instanceof Error ? listError.message : String(listError));
      setRemoteFiles([]);
    } finally {
      setRemoteFilesLoading(false);
    }
  };

  const loadTreeChildren = async (path: string) => {
    if (!nativeEntry) return;
    try {
      const result = transferMode === "guest-agent"
        ? await invoke<{ path: string; files: VmFileEntry[] }>("proxmox_agent_list_directory", { entry: nativeEntry, sessionId: authSessions[nativeEntry.id], path })
        : await invoke<{ path: string; files: VmFileEntry[] }>("ssh_list_directory", { profile: buildSshProfile(), path });
      const children: VncFolderNode[] = result.files
        .filter((file) => file.isDirectory)
        .map((file) => ({ path: file.path, name: file.name, expanded: false, loaded: false, children: [] }))
        .sort((left, right) => left.name.localeCompare(right.name));
      setRemoteTree((current) => updateTreeNode(current, path, (node) => ({ ...node, loaded: true, children })));
    } catch {
      setRemoteTree((current) => updateTreeNode(current, path, (node) => ({ ...node, loaded: true, children: [] })));
    }
  };

  const toggleTreeNode = (node: VncFolderNode) => {
    const willExpand = !node.expanded;
    setRemoteTree((current) => updateTreeNode(current, node.path, (item) => ({ ...item, expanded: willExpand })));
    if (willExpand && !node.loaded) void loadTreeChildren(node.path);
  };

  const selectRemotePath = (path: string) => {
    setRemotePath(path);
    void loadRemoteFiles(path);
  };

  const toggleRemoteSelection = (path: string) => {
    setSelectedRemotePaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  // --- Transfer queue ----------------------------------------------------
  const addQueueItem = (item: VncQueueItem) => setVncQueue((current) => [item, ...current]);
  const patchQueueItem = (id: string, patch: Partial<VncQueueItem>) => setVncQueue((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  const removeQueueItem = (id: string) => {
    delete progressSamplesRef.current[id];
    setVncQueue((current) => current.filter((item) => item.id !== id));
  };
  const updateQueueItemProgress = (id: string, completedBytes: number, totalBytes: number | null) => {
    setVncQueue((current) => current.map((item) => {
      if (item.id !== id) return item;
      const samples = [...(progressSamplesRef.current[id] || []), { bytes: completedBytes, at: Date.now() }].slice(-8);
      progressSamplesRef.current[id] = samples;
      const progress = updateQueueProgress(item.progress, completedBytes, totalBytes ?? item.progress?.totalBytes ?? null, item.progress?.completedItems ?? 0, item.progress?.totalItems ?? 1, samples);
      return { ...item, progress, detail: `Transferring...${formatQueueDetailProgress(progress)}` };
    }));
  };

  useEffect(() => {
    const uploadListener = listen<{ transferId: string; bytesCompleted: number; bytesTotal: number }>("proxmox-agent-upload-progress", (event) => {
      updateQueueItemProgress(event.payload.transferId, event.payload.bytesCompleted, event.payload.bytesTotal ?? null);
    });
    const downloadListener = listen<{ transferId: string; bytesCompleted: number; bytesTotal: number | null }>("proxmox-agent-download-progress", (event) => {
      updateQueueItemProgress(event.payload.transferId, event.payload.bytesCompleted, event.payload.bytesTotal ?? null);
    });
    return () => {
      void uploadListener.then((unlisten) => unlisten());
      void downloadListener.then((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const executeUpload = async (id: string, localPath: string, fileName: string, mode: VncTransferMode, profile: SshTransferProfile, destinationPath: string, attempt: number) => {
    patchQueueItem(id, { status: attempt > 1 ? "retrying" : "running", detail: attempt > 1 ? `Retrying (attempt ${attempt})...` : "Uploading..." });
    try {
      if (mode === "guest-agent") {
        if (!nativeEntry) throw new Error("Proxmox entry is unavailable");
        await invoke("proxmox_agent_upload_file", {
          entry: nativeEntry,
          sessionId: authSessions[nativeEntry.id],
          transferId: id,
          localPath,
          remotePath: `${destinationPath.replace(/\/$/, "")}/${fileName}`,
          sizeLimitBytes: 0,
        });
      } else {
        await invoke("ssh_upload_path", { profile, localPath, remoteDestinationFolder: destinationPath });
      }
      patchQueueItem(id, { status: "completed", detail: "Upload complete." });
      if (destinationPath === remotePath) void loadRemoteFiles(remotePath);
    } catch (uploadError) {
      const decision = classifyQueueError(uploadError);
      if (decision.retryable && attempt <= MAX_TRANSFER_RETRIES) {
        patchQueueItem(id, { status: "retrying", detail: `${decision.message} - retrying...` });
        window.setTimeout(() => { void executeUpload(id, localPath, fileName, mode, profile, destinationPath, attempt + 1); }, retryDelayMs(attempt));
      } else {
        patchQueueItem(id, { status: "failed", detail: decision.message });
      }
    }
  };

  const runUpload = (localPath: string) => {
    const fileName = localPath.split(/[\\/]/).pop() || localPath;
    const id = crypto.randomUUID();
    addQueueItem({ id, kind: "upload", label: fileName, detail: "Queued...", status: "queued" });
    void executeUpload(id, localPath, fileName, transferMode, buildSshProfile(), remotePath, 1);
  };

  const pickAndUpload = async () => {
    if (!entry || transferMode === "unavailable" || transferMode === "unknown" || transferMode === "detecting") return;
    try {
      const paths = await invoke<string[]>("pick_upload_files");
      paths.forEach((path) => runUpload(path));
    } catch (pickError) {
      setTransferError(pickError instanceof Error ? pickError.message : String(pickError));
    }
  };

  const executeDownload = async (id: string, item: VmFileEntry, mode: VncTransferMode, profile: SshTransferProfile, destination: string, attempt: number) => {
    patchQueueItem(id, { status: attempt > 1 ? "retrying" : "running", detail: attempt > 1 ? `Retrying (attempt ${attempt})...` : "Downloading..." });
    try {
      if (mode === "guest-agent") {
        if (!nativeEntry) throw new Error("Proxmox entry is unavailable");
        await invoke("proxmox_agent_download_file", {
          entry: nativeEntry,
          sessionId: authSessions[nativeEntry.id],
          transferId: id,
          remotePath: item.path,
          destinationFolder: destination,
        });
      } else {
        await invoke("ssh_download_path", { profile, remotePath: item.path, isDirectory: item.isDirectory, localDestinationFolder: destination });
      }
      patchQueueItem(id, { status: "completed", detail: "Download complete." });
    } catch (downloadError) {
      const decision = classifyQueueError(downloadError);
      if (decision.retryable && attempt <= MAX_TRANSFER_RETRIES) {
        patchQueueItem(id, { status: "retrying", detail: `${decision.message} - retrying...` });
        window.setTimeout(() => { void executeDownload(id, item, mode, profile, destination, attempt + 1); }, retryDelayMs(attempt));
      } else {
        patchQueueItem(id, { status: "failed", detail: decision.message });
      }
    }
  };

  const runDownload = (item: VmFileEntry, destination: string) => {
    const id = crypto.randomUUID();
    addQueueItem({ id, kind: "download", label: item.name, detail: "Queued...", status: "queued" });
    void executeDownload(id, item, transferMode, buildSshProfile(), destination, 1);
  };

  const pickAndDownload = async () => {
    if (!entry) return;
    const items = remoteFiles.filter((file) => selectedRemotePaths.has(file.path));
    if (!items.length) { setTransferError("Select at least one file to download first."); return; }
    if (transferMode === "guest-agent" && items.some((item) => item.isDirectory)) {
      setTransferError("Folders can't be downloaded over the Guest Agent fallback (no directory API). Open the folder and download files individually, or use a reachable direct/jump SFTP connection.");
      return;
    }
    try {
      const destination = await invoke<string | null>("pick_local_directory", { path: "" });
      if (!destination) return;
      items.forEach((item) => runDownload(item, destination));
    } catch (pickError) {
      setTransferError(pickError instanceof Error ? pickError.message : String(pickError));
    }
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
      rfb.addEventListener("connect", () => { if (sessionGeneration === sessionGenerationRef.current) { setStatus("Connected"); setControlsOpen(false); void detectTransferMode(); } });
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

  const fileBrowserVisible = transferMode !== "unknown";
  const filesReady = transferMode === "direct-sftp" || transferMode === "jump-sftp" || transferMode === "guest-agent";

  return <div className={`vnc-workspace${entryPaneCollapsed ? " vnc-entry-pane-collapsed" : ""}`}><div className="vnc-entry-pane-shell" style={{ flexBasis: `${entryPaneWidth}px` }}><VncEntries entries={entries} activeEntryId={activeEntryId} onSelectEntry={selectEntry} onAddEntry={onAddEntry} onEditEntry={onEditEntry} onRemoveEntry={onRemoveEntry} password={password} authenticated={authenticated} loading={loading} onPasswordChange={updatePassword} onLogin={() => void loginEntry()} onLogout={() => void logoutEntry()} fileBrowser={{ visible: fileBrowserVisible, loading: transferMode === "detecting", error: transferMode === "unavailable" ? transferError : "", modeLabel: transferModeLabel(transferMode), mode: transferMode, root: remoteTree, activePath: remotePath, onToggle: toggleTreeNode, onSelect: selectRemotePath, onBack: () => setTransferMode("unknown") }} /></div>{collapseMainPaneEnabled ? <div className="vnc-main-pane-collapse-controls" role="group" aria-label="VNC pane visibility"><button type="button" onClick={() => setEntryPaneCollapsed(true)} disabled={entryPaneCollapsed} aria-label="Collapse VNC entry pane" title="Collapse VNC entry pane"><ChevronLeftIcon /></button><button type="button" onClick={() => setEntryPaneCollapsed(false)} disabled={!entryPaneCollapsed} aria-label="Restore VNC entry pane" title="Restore VNC entry pane"><ChevronRightIcon /></button></div> : <PaneResizeHandle ariaLabel="Resize Proxmox VNC entries pane" onStart={beginEntryPaneResize} onMove={(event) => resizeEntryPane(event.nativeEvent)} onEnd={stopEntryPaneResize} />}
    <section ref={vncReaderRef} className="vnc-reader" aria-label="Proxmox VNC workspace">
      <div className="vnc-reader-heading"><div><span className="eyebrow">VNC mode · {workspaceName}</span><h1>{entry?.name || "Proxmox VNC"}</h1></div><span className="vnc-session-status">{status}</span></div>
      <div className="vnc-view-tabs" role="tablist" aria-label="VNC view">
        <button type="button" role="tab" aria-selected={activeView === "screen"} className={`vnc-view-tab${activeView === "screen" ? " active" : ""}`} onClick={() => setActiveView("screen")}>Screen</button>
        <button type="button" role="tab" aria-selected={activeView === "files"} className={`vnc-view-tab${activeView === "files" ? " active" : ""}`} onClick={() => setActiveView("files")} disabled={!filesReady}>Files</button>
      </div>
      {activeView === "screen" && <div className="vnc-display-split" style={{ "--controls-row": controlsRatio === null ? "auto" : `${controlsRatio}fr`, "--screen-row": controlsRatio === null ? "1fr" : `${1 - controlsRatio}fr` } as React.CSSProperties}><div className={`vnc-auth-panel${controlsOpen ? " open" : " collapsed"}`}><div className="vnc-auth-heading"><strong>Connection controls</strong><button type="button" onClick={() => { setControlsOpen((value) => !value); setControlsRatio(null); }}>{controlsOpen ? "Collapse" : "Expand"}</button></div>{controlsOpen && <><div className="vnc-auth-grid"><label>Node<Dropdown label="Node" value={selectedNode} onChange={chooseNode} disabled={!authenticated || !nodes.length} placeholder={authenticated ? "Select node" : "Login first"} options={nodes.map((node) => ({ value: node, label: node }))} /></label><label>VM<Dropdown label="VM" value={selectedVm ? String(selectedVm.vmid) : ""} onChange={chooseVm} disabled={!authenticated || !selectedNode || !nodeVms.length} placeholder={selectedNode ? "Select VM" : "Select node first"} options={nodeVms.map((vm) => ({ value: String(vm.vmid), label: `${vm.name || `VM ${vm.vmid}`} (${vm.vmid})` }))} /></label></div><div className="vnc-actions"><button type="button" className="confirm" onClick={() => void connect()} disabled={loading || !entry || !authenticated || !selectedVm}>{loading ? "Connecting..." : "Connect"}</button><button type="button" onClick={() => stopConnection()} disabled={!rfbRef.current}>Disconnect</button><button type="button" onClick={() => void logoutEntry()} disabled={!authenticated}>Logout</button></div>{entry?.ignoreTlsErrors && <div className="notice vnc-warning">TLS certificate verification is disabled for this entry.</div>}{error && <div className="notice rest-error">{error}</div>}</>}</div><div className="vnc-screen-resize" role="separator" aria-label="Resize Connection controls" title="Drag downward to enlarge Connection controls" onPointerDown={resizeControls} /><div ref={screenShellRef} className={`vnc-screen-shell${isFullscreen ? " fullscreen" : ""}`}><div className="vnc-display-toolbar"><button type="button" onClick={() => rfbRef.current?.sendCtrlAltDel()} disabled={!rfbRef.current}>Ctrl+Alt+Del</button><button type="button" onClick={() => rfbRef.current?.focus()} disabled={!rfbRef.current}>Focus</button><button type="button" onClick={toggleViewOnly} disabled={!rfbRef.current}>{viewOnly ? "Enable input" : "View only"}</button><button type="button" onClick={() => void toggleFullscreen()}>{isFullscreen ? "Exit fullscreen" : "Fullscreen"}</button></div><div ref={screenRef} className="vnc-screen" /></div></div>}
      {activeView === "files" && <div className="vnc-files-pane">
        <div className="vnc-files-toolbar">
          <button type="button" className="confirm" onClick={() => void pickAndUpload()} disabled={!filesReady}>Upload</button>
          <button type="button" onClick={() => void pickAndDownload()} disabled={!filesReady || !selectedRemotePaths.size}>Download{selectedRemotePaths.size ? ` (${selectedRemotePaths.size})` : ""}</button>
          <button type="button" onClick={() => void loadRemoteFiles(remotePath)} disabled={!filesReady || remoteFilesLoading}>Refresh</button>
          <span className="vnc-files-breadcrumb" title={remotePath}>{remotePath}</span>
          <span className="vnc-reachability-status" data-mode={transferMode}>{transferModeLabel(transferMode)}{guestIp ? ` · ${guestIp}` : ""}</span>
        </div>
        {transferError && <div className="notice rest-error">{transferError}</div>}
        {remoteFilesError && <div className="notice rest-error">{remoteFilesError}</div>}
        <div className="vnc-files-table-wrap">
          <table className="file-table">
            <thead>
              <tr>
                <th className="selection-column" aria-label="Select" />
                <th>Name</th>
                <th>Size</th>
                <th>Modified</th>
              </tr>
            </thead>
            <tbody>
              {remotePath !== "/" && <tr className="file-row">
                <td className="selection-column" />
                <td><button type="button" className="tree-folder" onClick={() => selectRemotePath(remotePath.split("/").slice(0, -1).join("/") || "/")}>.. (up)</button></td>
                <td />
                <td />
              </tr>}
              {!remoteFilesLoading && !remoteFiles.length && <tr className="file-row"><td colSpan={4} className="vnc-files-empty">This folder is empty.</td></tr>}
              {remoteFiles.map((file) => <tr className="file-row" key={file.path}>
                <td className="selection-column">
                  {!file.isDirectory && <input type="checkbox" checked={selectedRemotePaths.has(file.path)} onChange={() => toggleRemoteSelection(file.path)} aria-label={`Select ${file.name}`} />}
                  {file.isDirectory && transferMode !== "guest-agent" && <input type="checkbox" checked={selectedRemotePaths.has(file.path)} onChange={() => toggleRemoteSelection(file.path)} aria-label={`Select ${file.name}`} />}
                </td>
                <td>{file.isDirectory
                  ? <button type="button" className="tree-folder" onClick={() => selectRemotePath(file.path)}><span className="folder-mini" />{file.name}</button>
                  : <span className="vnc-file-name-cell">{file.name}</span>}</td>
                <td>{file.isDirectory ? "--" : formatFileSize(file.size)}</td>
                <td>{formatModifiedDate(file.modified)}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        {vncQueue.length > 0 && <div className="vnc-transfer-queue">
          {vncQueue.map((item) => <div className="queue-item" key={item.id}>
            <div className="queue-item-header"><span className="queue-item-label">{item.kind === "upload" ? "Upload" : "Download"}: {item.label}</span><span className={`queue-status ${item.status}`}>{item.status}</span></div>
            <div className="queue-item-detail">{item.detail}</div>
            {(item.status === "completed" || item.status === "failed") && <div className="queue-item-actions"><button type="button" onClick={() => removeQueueItem(item.id)}>Remove</button></div>}
          </div>)}
        </div>}
      </div>}
    </section>
  </div>;
}
