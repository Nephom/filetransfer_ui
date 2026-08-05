import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "./styles.css";
import "./login.css";
import "./location-control.css";
import "./tls.css";
import "./webui-shell.css";
import "./explorer-parity.css";
import "@xterm/xterm/css/xterm.css";

type FileItem = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: number;
};
type Location = {
  id: string;
  displayName: string;
  status?: string;
  readOnly?: boolean;
  capabilities?: string[];
};
type Session = {
  host: string;
  port: string;
  token: string;
  username: string;
  userId: number | null;
  role: string;
  permissions: string[];
  locationId: string;
  ignoreTlsErrors: boolean;
};
type ShareResponse = { data?: { fullUrl?: string; shareUrl?: string } };
type NativeApiResponse = { status: number; body: number[] };
type UploadSummary = { files: number; directories: number };
type FolderNode = {
  path: string;
  name: string;
  expanded: boolean;
  loaded: boolean;
  children: FolderNode[];
};
type LocalDirectory = {
  path: string;
  files: FileItem[];
};
type SessionEntry = {
  id: string;
  alias: string;
  kind: "LOCAL" | "REMOTE" | "SSH";
  path: string;
  locationId?: string;
  locationName?: string;
  profileId?: string;
  profileName?: string;
  sshProfile?: SshProfile;
};
type SxpEntry = {
  id: string;
  name: string;
  localAlias: string;
  localPath: string;
  remoteAlias: string;
  remotePath: string;
  locationId: string;
  locationName: string;
};
type ManagedSession = {
  id: string;
  name: string;
  sxpEntries: SxpEntry[];
  sshEntries: SshProfile[];
};
type ColumnKey = "name" | "modified" | "size";
type SshProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
};
type SshEvent = { sessionId: string; data: string };
type TransferQueueItem = {
  id: string;
  label: string;
  paths: string[];
  destinationPath: string;
  locationId: string;
  locationName: string;
  status: "queued" | "running" | "completed" | "failed";
  detail: string;
};

const sxpHelp = `sxp <Session name> upload <source folder> <destination folder>
sxp <Session name> mv <source folder> <destination folder>

REMOTE (Location name) is the API Remote selected by the top LOCATION control.
Source and destination folders must be named folders in the selected Session.`;

const sessionEntries = (session: ManagedSession): SessionEntry[] => session.sxpEntries.flatMap((entry) => [
  { id: `${entry.id}-local`, alias: entry.localAlias, kind: "LOCAL", path: entry.localPath },
  { id: `${entry.id}-remote`, alias: entry.remoteAlias, kind: "REMOTE", path: entry.remotePath, locationId: entry.locationId, locationName: entry.locationName },
]);

const normalizeManagedSessions = (value: unknown): ManagedSession[] => {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const item = raw as Partial<ManagedSession> & { entries?: SessionEntry[] };
    if (Array.isArray(item.sxpEntries) && Array.isArray(item.sshEntries)) return item as ManagedSession;
    const entries = Array.isArray(item.entries) ? item.entries : [];
    const local = entries.find((entry) => entry.kind === "LOCAL");
    const remote = entries.find((entry) => entry.kind === "REMOTE");
    const ssh = entries.filter((entry) => entry.kind === "SSH").map((entry) => entry.sshProfile).filter(Boolean) as SshProfile[];
    return {
      id: item.id || crypto.randomUUID(),
      name: item.name || "Default",
      sxpEntries: local && remote ? [{ id: crypto.randomUUID(), name: "Default Transfer", localAlias: local.alias, localPath: local.path, remoteAlias: remote.alias, remotePath: remote.path, locationId: remote.locationId || "", locationName: remote.locationName || remote.locationId || "" }] : [],
      sshEntries: ssh,
    };
  });
};

const parseSxpCommand = (input: string, sessions: ManagedSession[]) => {
  const args = input.trim().split(/\s+/).filter(Boolean);
  if (args[0] !== "sxp") return "Only the embedded SXP command is available here.";
  if (!sessions.length) return "Please create a Session before using SXP.";
  if (args[1] === "help") return sxpHelp;
  if (args.length !== 5 || !["upload", "mv"].includes(args[2])) {
    return `Usage: sxp <Session name> ${args[2] === "mv" ? "mv" : "upload"} <source folder> <destination folder>`;
  }
  const session = sessions.find(
    (item) => item.id === args[1] || item.name === args[1],
  );
  if (!session) return `Session not found: ${args[1]}`;
  const entries = sessionEntries(session);
  const source = entries.find((entry) => entry.alias === args[3]);
  const destination = entries.find((entry) => entry.alias === args[4]);
  if (!source || !destination) {
    return "Source and destination folders must be named folders in the selected Session.";
  }
  return `Parsed ${args[2]}: ${source.alias} -> ${destination.alias}\n` +
    "Transfer execution will be submitted to the shared queue.";
};
const stripAnsi = (value: string) =>
  value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:][\d;]*)*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");

type ScrollMetrics = {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
};

function PersistentScrollbar({
  targetRef,
  label,
}: {
  targetRef: React.RefObject<HTMLElement | null>;
  label: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ pointerY: number; scrollTop: number } | null>(null);
  const [metrics, setMetrics] = useState<ScrollMetrics>({
    scrollTop: 0,
    clientHeight: 0,
    scrollHeight: 0,
  });

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;

    const update = () =>
      setMetrics({
        scrollTop: target.scrollTop,
        clientHeight: target.clientHeight,
        scrollHeight: target.scrollHeight,
      });
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(target);
    resizeObserver.observe(trackRef.current || target);
    target.addEventListener("scroll", update, { passive: true });
    update();

    return () => {
      target.removeEventListener("scroll", update);
      resizeObserver.disconnect();
    };
  }, [targetRef]);

  const trackHeight = trackRef.current?.clientHeight || 0;
  const hasOverflow = metrics.scrollHeight > metrics.clientHeight;
  const thumbHeight = hasOverflow
    ? Math.max(32, trackHeight * (metrics.clientHeight / metrics.scrollHeight))
    : trackHeight;
  const availableTravel = Math.max(0, trackHeight - thumbHeight);
  const maxScroll = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const thumbTop = maxScroll > 0
    ? availableTravel * (metrics.scrollTop / maxScroll)
    : 0;

  const stopDragging = () => {
    dragStart.current = null;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", stopDragging);
  };
  const handlePointerMove = (event: PointerEvent) => {
    const start = dragStart.current;
    const target = targetRef.current;
    if (!start || !target || availableTravel <= 0) return;
    const nextTop = Math.max(
      0,
      Math.min(availableTravel, thumbTop + event.clientY - start.pointerY),
    );
    target.scrollTop = maxScroll * (nextTop / availableTravel);
  };
  const startDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!hasOverflow || availableTravel <= 0) return;
    event.preventDefault();
    dragStart.current = { pointerY: event.clientY, scrollTop: metrics.scrollTop };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
  };

  return (
    <div
      ref={trackRef}
      className="persistent-scrollbar"
      role="scrollbar"
      aria-label={label}
      aria-controls={label === "Folders" ? "folders" : "files"}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={maxScroll}
      aria-valuenow={metrics.scrollTop}
      onWheel={(event) => {
        const target = targetRef.current;
        if (!target) return;
        event.preventDefault();
        target.scrollTop += event.deltaY;
      }}
    >
      <div
        className="persistent-scrollbar-thumb"
        style={{ height: `${thumbHeight}px`, transform: `translateY(${thumbTop}px)` }}
        onPointerDown={startDragging}
      />
    </div>
  );
}

function PaletteSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const controlRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (!controlRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  return (
    <div ref={controlRef} className="palette-select-control">
      <button
        type="button"
        className="location-select palette-select"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.label || label}</span>
        <span className="location-chevron">⌄</span>
      </button>
      {open && (
        <div className="location-menu palette-select-menu" role="listbox" aria-label={label}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? "selected" : ""}
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const defaultHost = import.meta.env.VITE_DEFAULT_SERVER_HOST || "";
const defaultPort = import.meta.env.VITE_DEFAULT_SERVER_PORT || "9443";
const appVersion =
  import.meta.env.VITE_APP_VERSION_DISPLAY ||
  import.meta.env.VITE_APP_VERSION ||
  "";
const initialSession: Session = {
  host: defaultHost,
  port: defaultPort,
  token: "",
  username: "",
  userId: null,
  role: "",
  permissions: [],
  locationId: "",
  ignoreTlsErrors: false,
};
const sessionRegistryKey = "fileapi-session-registry";

const readError = async (response: {
  status: number;
  text: () => Promise<string>;
}) => {
  const body = await response.text();
  try {
    const data = JSON.parse(body);
    return (
      data.error?.message ||
      data.error ||
      data.message ||
      `HTTP ${response.status}`
    );
  } catch {
    return body || `HTTP ${response.status}`;
  }
};

const parentPath = (path: string) =>
  path.split("/").filter(Boolean).slice(0, -1).join("/");
const downloadPath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");
const formatSize = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 ** 2
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 ** 2).toFixed(1)} MB`;
const serverUrl = (session: Session) =>
  `https://${session.host.trim()}:${session.port.trim()}`;

class ApiResponse {
  readonly ok: boolean;
  private readonly bytes: Uint8Array;

  constructor(
    readonly status: number,
    body: number[],
  ) {
    this.ok = status >= 200 && status < 300;
    this.bytes = new Uint8Array(body);
  }

  text = async () => new TextDecoder().decode(this.bytes);
  json = async () => JSON.parse(await this.text());
  arrayBuffer = async () => this.bytes.slice().buffer;
}

const validateServer = (session: Session) => {
  if (!/^[a-zA-Z0-9.-]+$/.test(session.host.trim()))
    throw new Error(
      "Enter a server address without a protocol, path, or port.",
    );
  const port = Number(session.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Enter an HTTPS port between 1 and 65535.");
};

function App() {
  const [session, setSession] = useState<Session>(initialSession);
  const [password, setPassword] = useState("");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [localFiles, setLocalFiles] = useState<FileItem[]>([]);
  const [localPath, setLocalPath] = useState("");
  const [localSelected, setLocalSelected] = useState<string[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationsLoading, setLocationsLoading] = useState(false);
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [locationMenuOpen, setLocationMenuOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [pathBeforeSearch, setPathBeforeSearch] = useState("");
  const [viewMode, setViewMode] = useState<"details" | "grid">(() =>
    localStorage.getItem("file-view-mode") === "grid" ? "grid" : "details",
  );
  const [splitMode, setSplitMode] = useState(() =>
    localStorage.getItem("file-layout-mode") === "split",
  );
  const [managedSessions, setManagedSessions] = useState<ManagedSession[]>(() => {
    try {
      const saved = localStorage.getItem(sessionRegistryKey);
      const parsed = saved ? JSON.parse(saved) : [];
      return normalizeManagedSessions(parsed);
    } catch {
      return [];
    }
  });
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionFormError, setSessionFormError] = useState("");
  const [lastSavedSessionId, setLastSavedSessionId] = useState("");
  const [sxpHelpOpen, setSxpHelpOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalTab, setTerminalTab] = useState<"sxp" | "ssh">("sxp");
  const [terminalHeight, setTerminalHeight] = useState(() =>
    Number(localStorage.getItem("fileapi-terminal-height")) || 260,
  );
  const [columnWidths, setColumnWidths] = useState<Record<ColumnKey, number>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("fileapi-column-widths") || "{}");
      return {
        name: Number(saved.name) || 50,
        modified: Number(saved.modified) || 30,
        size: Number(saved.size) || 20,
      };
    } catch {
      return { name: 50, modified: 30, size: 20 };
    }
  });
  const [sshProfiles, setSshProfiles] = useState<SshProfile[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("fileapi-ssh-profiles") || "[]");
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });
  const [sshProfileId, setSshProfileId] = useState(() => sshProfiles[0]?.id || "");
  const [workspaceSessionId, setWorkspaceSessionId] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(sessionRegistryKey) || "[]");
      const sessions = normalizeManagedSessions(saved);
      return sessions.find((item) => item.sshEntries.length)?.id || "";
    } catch {
      return "";
    }
  });
  const [sxpWorkspaceId, setSxpWorkspaceId] = useState("");
  const [sshConnected, setSshConnected] = useState(false);
  const [sshSessionId, setSshSessionId] = useState("");
  const [sshOutput, setSshOutput] = useState("");
  const sshOutputRef = useRef("");
  const [sshProfileDraft, setSshProfileDraft] = useState({
    id: "",
    name: "",
    host: "",
    port: "22",
    username: "",
    privateKeyPath: "",
    password: "",
  });
  const [sshEntryDraftId, setSshEntryDraftId] = useState("");
  const [recording, setRecording] = useState(false);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [savedLogPaths, setSavedLogPaths] = useState<string[]>([]);
  const [uploadSessionId, setUploadSessionId] = useState("");
  const [transferQueue, setTransferQueue] = useState<TransferQueueItem[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const rawLogRef = useRef("");
  const plainLogRef = useRef("");
  const commandLogRef = useRef("");
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const sshSessionIdRef = useRef("");
  const sshPasswordKeyRef = useRef("");
  const recordingRef = useRef(false);
  const sshSecretPromptRef = useRef(false);
  const shellInputRef = useRef("");
  const [sessionNameDraft, setSessionNameDraft] = useState("");
  const [localAliasDraft, setLocalAliasDraft] = useState("LocalHome");
  const [remoteAliasDraft, setRemoteAliasDraft] = useState("RemoteRoot");
  const [sxpEntryDraftId, setSxpEntryDraftId] = useState("");
  const [sxpEntryNameDraft, setSxpEntryNameDraft] = useState("Default Transfer");
  const [pendingRemotePath, setPendingRemotePath] = useState<string | null>(null);
  const [folderTree, setFolderTree] = useState<FolderNode>({
    path: "",
    name: "/",
    expanded: true,
    loaded: false,
    children: [],
  });
  const [dragItems, setDragItems] = useState<FileItem[]>([]);
  const [dropTarget, setDropTarget] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const accountControl = useRef<HTMLDivElement>(null);
  const locationControl = useRef<HTMLDivElement>(null);
  const folderTreeRef = useRef<HTMLDivElement>(null);
  const fileAreaRef = useRef<HTMLDivElement>(null);
  const noticeTimer = useRef<number | undefined>();
  const locationsLoaded = useRef(false);
  const locationRefreshInProgress = useRef(false);
  const terminalResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const columnResizeRef = useRef<{
    key: ColumnKey;
    startX: number;
    startWidth: number;
  } | null>(null);

  useEffect(() => {
    sshSessionIdRef.current = sshSessionId;
  }, [sshSessionId]);

  useEffect(() => {
    sshPasswordKeyRef.current = sshProfileId;
  }, [sshProfileId]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("fileapi-desktop-session");
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<Session>;
        setSession((current) => ({
          ...current,
          ...parsed,
          host: parsed.host || defaultHost,
          port: parsed.port || defaultPort,
        }));
      }
    } catch {
      setNotice("Unable to restore the saved desktop session.");
    }
  }, []);

  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  useEffect(() => {
    localStorage.setItem("fileapi-desktop-session", JSON.stringify(session));
  }, [session]);

  useEffect(() => {
    localStorage.setItem("file-view-mode", viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem("file-layout-mode", splitMode ? "split" : "single");
  }, [splitMode]);

  useEffect(() => {
    localStorage.setItem("fileapi-terminal-height", String(terminalHeight));
  }, [terminalHeight]);

  useEffect(() => {
    localStorage.setItem("fileapi-column-widths", JSON.stringify(columnWidths));
  }, [columnWidths]);

  useEffect(() => {
    localStorage.setItem(sessionRegistryKey, JSON.stringify(managedSessions));
  }, [managedSessions]);

  useEffect(() => {
    localStorage.setItem("fileapi-ssh-profiles", JSON.stringify(sshProfiles));
  }, [sshProfiles]);

  useEffect(() => {
    if (managedSessions.length || !sshProfiles.length) return;
    const makeId = () => typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const migrated = sshProfiles.map((profile) => ({
      id: makeId(),
      name: profile.name,
      sxpEntries: [{ id: makeId(), name: "Default Transfer", localAlias: "Desktop", localPath: "Desktop", remoteAlias: "Personal", remotePath: "", locationId: session.locationId, locationName: session.locationId }],
      sshEntries: [profile],
    }));
    setManagedSessions(migrated);
    setWorkspaceSessionId(migrated[0]?.id || "");
  }, [managedSessions.length, sshProfiles]);

  useEffect(() => {
    let disposed = false;
    const unlistenOutput = listen<SshEvent>("ssh-output", (event) => {
      if (disposed || event.payload.sessionId !== sshSessionIdRef.current) return;
      const data = event.payload.data;
      sshOutputRef.current += data;
      setSshOutput(sshOutputRef.current);
      terminalInstanceRef.current?.write(data);
       const promptText = stripAnsi(sshOutputRef.current.slice(-240)).replace(/\r/g, "").trimEnd();
       const secretPrompt = /(password|passphrase|verification code|token)[^\n:]*[:?]\s*$/i.test(promptText);
       if (secretPrompt && !sshSecretPromptRef.current && sshPasswordKeyRef.current) {
         void invoke("ssh_send_stored_password", {
           sessionId: event.payload.sessionId,
           passwordKey: sshPasswordKeyRef.current,
         }).catch((error) => setNotice(`Unable to send the saved SSH password: ${String(error)}`));
       }
       sshSecretPromptRef.current = secretPrompt;
      if (recordingRef.current) {
        rawLogRef.current += data;
        plainLogRef.current += stripAnsi(data);
      }
    });
    const unlistenExit = listen<SshEvent>("ssh-exit", (event) => {
      if (disposed || event.payload.sessionId !== sshSessionIdRef.current) return;
      setSshConnected(false);
      sshOutputRef.current += `\n${event.payload.data}\n`;
      setSshOutput(sshOutputRef.current);
    });
    return () => {
      disposed = true;
      void unlistenOutput.then((dispose) => dispose());
      void unlistenExit.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    if (!terminalOpen || !terminalHostRef.current) return undefined;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "monospace",
      fontSize: 13,
      theme: { background: "#020a12", foreground: "#d9eafa", cursor: "#47cdf1" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(terminalHostRef.current);
    fit.fit();
    terminalInstanceRef.current = terminal;
    shellInputRef.current = "";
    if (terminalTab === "sxp") {
      terminal.write(managedSessions.length ? "SXP terminal ready. Type a command or open help.\r\n" : "Please create a Session before using SXP.\r\n");
    } else {
      terminal.write(sshOutput || "Select a Session and connect.\r\n");
    }
    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(terminalHostRef.current);
    const inputListener = terminal.onData((data: string) => {
      if (terminalTab === "ssh") {
        if (!sshSessionIdRef.current) return;
        void invoke("ssh_write", { sessionId: sshSessionIdRef.current, data });
        if (recordingRef.current && !sshSecretPromptRef.current) {
          if (data === "\r" || data === "\n") {
            if (shellInputRef.current.trim()) {
              commandLogRef.current += `[${new Date().toISOString()}] ${shellInputRef.current}\n`;
            }
            shellInputRef.current = "";
          } else if (data === "\u007f") {
            shellInputRef.current = shellInputRef.current.slice(0, -1);
          } else if (!data.startsWith("\u001b")) {
            shellInputRef.current += data;
          }
        }
        return;
      }
      if (data === "\r" || data === "\n") {
        const result = parseSxpCommand(shellInputRef.current, managedSessions);
        terminal.write(`\r\n${result.replace(/\n/g, "\r\n")}\r\n`);
        shellInputRef.current = "";
      } else if (data === "\u007f") {
        shellInputRef.current = shellInputRef.current.slice(0, -1);
        terminal.write("\b \b");
      } else if (!data.startsWith("\u001b")) {
        shellInputRef.current += data;
        terminal.write(data);
      }
    });
    return () => {
      inputListener.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      terminalInstanceRef.current = null;
    };
  }, [terminalOpen, terminalTab]);

  useEffect(() => {
    const closeAccountMenu = (event: MouseEvent) => {
      if (!accountControl.current?.contains(event.target as Node))
        setAccountOpen(false);
      if (!locationControl.current?.contains(event.target as Node))
        setLocationMenuOpen(false);
      if (!(event.target as HTMLElement).closest(".context-menu"))
        setContextMenu(null);
    };
    window.addEventListener("click", closeAccountMenu);
    return () => window.removeEventListener("click", closeAccountMenu);
  }, []);

  const api = async (endpoint: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (session.token) headers.set("Authorization", `Bearer ${session.token}`);
    if (session.locationId) headers.set("X-Location-ID", session.locationId);
    const body =
      init.body === undefined
        ? undefined
        : Array.from(new TextEncoder().encode(String(init.body)));
    const response = await invoke<NativeApiResponse>("api_request", {
      url: `${serverUrl(session)}${endpoint}`,
      method: init.method || "GET",
      headers: Array.from(headers.entries()),
      body,
      ignoreTlsErrors: session.ignoreTlsErrors,
    });
    return new ApiResponse(response.status, response.body);
  };

  const activeLocation = locations.find(
    (location) => location.id === session.locationId,
  );
  const hasCapability = (capability: string) =>
    activeLocation?.capabilities?.includes(capability) === true;
  const locationOnline = activeLocation?.status === "online";

  const loadLocations = async () => {
    if (locationRefreshInProgress.current) return;
    locationRefreshInProgress.current = true;
    if (!locationsLoaded.current) setLocationsLoading(true);
    try {
      const response = await api("/api/locations");
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as { locations?: Location[] };
      const available = (data.locations || []).filter(
        (location) => location.id,
      );
      locationsLoaded.current = true;
      setLocations(available);
      setSession((current) => ({
        ...current,
        locationId: available.some(
          (location) => location.id === current.locationId,
        )
          ? current.locationId
          : available[0]?.id || "",
      }));
    } finally {
      locationRefreshInProgress.current = false;
      setLocationsLoading(false);
    }
  };

  const loadFiles = async (nextPath = path) => {
    const response = await api(
      `/api/files?path=${encodeURIComponent(nextPath)}`,
    );
    if (!response.ok) throw new Error(await readError(response));
    const data = await response.json();
    setFiles(data.files || []);
    setPath(data.currentPath || "");
    setSearching(false);
    setSelected([]);
  };

  const loadLocalFiles = async (nextPath = localPath) => {
    const data = await invoke<LocalDirectory>("local_list_directory", {
      path: nextPath,
    });
    setLocalFiles(data.files || []);
    setLocalPath(data.path || "");
    setLocalSelected([]);
  };

  const updateTreeNode = (
    node: FolderNode,
    targetPath: string,
    update: (node: FolderNode) => FolderNode,
  ): FolderNode =>
    node.path === targetPath
      ? update(node)
      : {
          ...node,
          children: node.children.map((child) =>
            updateTreeNode(child, targetPath, update),
          ),
        };

  const loadTreeChildren = async (treePath: string, force = false) => {
    const response = await api(
      `/api/files?path=${encodeURIComponent(treePath)}`,
    );
    if (!response.ok) {
      if (!force) throw new Error(await readError(response));
      return;
    }
    const data = await response.json();
    const children = (data.files || [])
      .filter((file: FileItem) => file.isDirectory)
      .map((file: FileItem) => ({
        path: file.path,
        name: file.name,
        expanded: false,
        loaded: false,
        children: [],
      }))
      .sort((left: FolderNode, right: FolderNode) =>
        left.name.localeCompare(right.name),
      );
    setFolderTree((tree) =>
      updateTreeNode(tree, treePath, (node) => ({
        ...node,
        expanded: true,
        loaded: true,
        children,
      })),
    );
  };

  const toggleFolder = (node: FolderNode) => {
    if (!node.expanded && !node.loaded) {
      void run(() => loadTreeChildren(node.path));
      return;
    }
    setFolderTree((tree) =>
      updateTreeNode(tree, node.path, (item) => ({
        ...item,
        expanded: !item.expanded,
      })),
    );
  };

  useEffect(() => {
    if (session.token) {
      void loadLocations().catch((error) =>
        setNotice(error instanceof Error ? error.message : String(error)),
      );
      const healthTimer = window.setInterval(
        () =>
          void loadLocations().catch((error) =>
            setNotice(error instanceof Error ? error.message : String(error)),
          ),
        15000,
      );
      return () => window.clearInterval(healthTimer);
    }
    return undefined;
  }, [session.token]);

  useEffect(() => {
    void loadLocalFiles().catch((error) =>
      setNotice(error instanceof Error ? error.message : String(error)),
    );
  }, []);

  useEffect(() => {
    if (session.token && session.locationId) {
      const nextPath = pendingRemotePath ?? "";
      if (pendingRemotePath !== null) setPendingRemotePath(null);
      void loadFiles(nextPath).catch((error) => setNotice(error.message));
      void loadTreeChildren("").catch((error) => setNotice(error.message));
    }
  }, [session.token, session.locationId]);

  const selectLocation = (locationId: string) => {
    if (locationId === session.locationId) return;
    setSession((current) => ({ ...current, locationId }));
    setPath("");
    setSelected([]);
    setSearch("");
    setSearching(false);
    setPathBeforeSearch("");
    setFolderTree({
      path: "",
      name: "/",
      expanded: true,
      loaded: false,
      children: [],
    });
  };

  const saveSession = (form?: HTMLFormElement) => {
    const values = form ? new FormData(form) : null;
    const name = String(values?.get("sessionName") || sessionNameDraft).trim();
    const localAlias = String(values?.get("localFolderName") || localAliasDraft).trim();
    const remoteAlias = String(values?.get("remoteFolderName") || remoteAliasDraft).trim();
    const sshName = String(values ? values.get("sshName") || "" : sshProfileDraft.name).trim();
    const sshHost = String(values ? values.get("sshHost") || "" : sshProfileDraft.host).trim();
    const sshPort = Number(values ? values.get("sshPort") || "" : sshProfileDraft.port);
    const sshUsername = String(values ? values.get("sshUsername") || "" : sshProfileDraft.username).trim();
    const sshPrivateKeyPath = String(values ? values.get("sshPrivateKeyPath") || "" : sshProfileDraft.privateKeyPath).trim();
    const sshPassword = String(values ? values.get("sshPassword") || "" : sshProfileDraft.password);
    const hasSshConnection = [sshName, sshHost, sshUsername, sshPrivateKeyPath].some(Boolean);
    if (!name || !localAlias || !remoteAlias) {
      setSessionFormError("Session name and folder names are required.");
      return;
    }
    if ([name, localAlias, remoteAlias].some((value) => /\s/.test(value))) {
      setSessionFormError("Session names and folder names cannot contain spaces.");
      return;
    }
    if (hasSshConnection && (!sshName || !sshHost || !sshUsername || !Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)) {
      setSessionFormError("Complete the SSH connection name, host, username, and valid port, or clear all SSH fields.");
      return;
    }
    if (!session.locationId) {
      setSessionFormError("Select an available API Remote Location before saving this Session.");
      return;
    }
    const existingWorkspace = managedSessions.find((item) => item.id === workspaceSessionId);
    if (managedSessions.some((item) => item.id !== existingWorkspace?.id && item.name.toLowerCase() === name.toLowerCase())) {
      setSessionFormError(`A Session named "${name}" already exists.`);
      return;
    }
    const makeId = () =>
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const existingSxpEntry = existingWorkspace?.sxpEntries.find((entry) => entry.id === sxpEntryDraftId);
    const existingSshEntry = existingWorkspace?.sshEntries.find((entry) => entry.id === sshEntryDraftId);
    const sshProfile = hasSshConnection
      ? {
          id: sshProfileDraft.id || makeId(),
          name: sshName,
          host: sshHost,
          port: sshPort,
          username: sshUsername,
          privateKeyPath: sshPrivateKeyPath,
        }
      : undefined;
    const sxpEntry: SxpEntry = {
      id: existingSxpEntry?.id || makeId(),
      name: String(values?.get("sxpEntryName") || existingSxpEntry?.name || "Default Transfer").trim(),
      localAlias,
      localPath,
      remoteAlias,
      remotePath: path,
      locationId: session.locationId,
      locationName: activeLocation?.displayName || session.locationId,
    };
    const managedSession: ManagedSession = {
      id: existingWorkspace?.id || makeId(),
      name,
      sxpEntries: existingWorkspace?.sxpEntries.length
        ? existingSxpEntry
          ? existingWorkspace.sxpEntries.map((entry) => entry.id === existingSxpEntry.id ? sxpEntry : entry)
          : [...existingWorkspace.sxpEntries, sxpEntry]
        : [sxpEntry],
      sshEntries: sshProfile
        ? existingWorkspace?.sshEntries.length
          ? existingSshEntry
            ? existingWorkspace.sshEntries.map((entry) => entry.id === existingSshEntry.id ? sshProfile : entry)
            : [...existingWorkspace.sshEntries, sshProfile]
          : [sshProfile]
        : existingWorkspace?.sshEntries || [],
    };
    void run(async () => {
      if (sshProfile && sshPassword) {
        await invoke("set_ssh_password", { key: sshProfile.id, password: sshPassword });
      }
      if (sshProfile) {
        setSshProfiles((current) => current.some((item) => item.id === sshProfile.id)
          ? current.map((item) => item.id === sshProfile.id ? sshProfile : item)
          : [...current, sshProfile]);
        setSshProfileId(sshProfile.id);
        sshPasswordKeyRef.current = sshProfile.id;
        loadSshProfileDraft(sshProfile);
      }
      setManagedSessions((current) => existingWorkspace
        ? current.map((item) => item.id === existingWorkspace.id ? managedSession : item)
        : [...current, managedSession]);
      setWorkspaceSessionId(managedSession.id);
      setSxpWorkspaceId(managedSession.id);
      setSessionNameDraft(name);
      setSessionFormError("");
      setLastSavedSessionId(managedSession.id);
      notify(`Saved Session: ${name}`);
    });
  };

  const openSessionEntry = (entry: SessionEntry, managedSessionId?: string) => {
    if (entry.kind === "LOCAL") {
      setSplitMode(true);
      void run(() => loadLocalFiles(entry.path));
      return;
    }
    if (entry.kind === "SSH") {
      const profile = entry.sshProfile || sshProfiles.find((item) => item.id === entry.profileId);
      if (!profile) {
        setNotice(`Session entry "${entry.alias}" is unavailable; SSH Profile was not found.`);
        return;
      }
      setSshProfiles((current) => current.some((item) => item.id === profile.id)
        ? current.map((item) => item.id === profile.id ? profile : item)
        : [...current, profile]);
      setSshProfileId(profile.id);
      sshPasswordKeyRef.current = profile.id;
      if (managedSessionId) setWorkspaceSessionId(managedSessionId);
      setTerminalTab("ssh");
      setTerminalOpen(true);
      setNotice(`Session SSH connection selected: ${entry.profileName || entry.profileId}. Connect when ready.`);
      return;
    }
    const location = locations.find((candidate) => candidate.id === entry.locationId);
    if (!location || location.status !== "online") {
      setNotice(`Session entry "${entry.alias}" is unavailable; Location was not changed.`);
      return;
    }
    if (location.id === session.locationId) {
      void run(() => loadFiles(entry.path));
      return;
    }
    setPendingRemotePath(entry.path);
    setSession((current) => ({ ...current, locationId: location.id }));
  };

  const removeSession = (sessionId: string) => {
    if (managedSessions.length === 1) {
      setManagedSessions((current) => current.map((item) => item.id === sessionId ? { ...item, name: "Default" } : item));
      setSessionNameDraft("Default");
      notify("The last Workspace is kept as Default.");
      return;
    }
    setManagedSessions((current) => current.filter((item) => item.id !== sessionId));
    if (workspaceSessionId === sessionId) setWorkspaceSessionId("");
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice("");
    try {
      await action();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const notify = (message: string, duration = 4000) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(message);
    if (duration > 0)
      noticeTimer.current = window.setTimeout(() => setNotice(""), duration);
  };

  const stopTerminalResize = () => {
    terminalResizeRef.current = null;
    window.removeEventListener("pointermove", resizeTerminal);
    window.removeEventListener("pointerup", stopTerminalResize);
  };
  const resizeTerminal = (event: PointerEvent) => {
    const start = terminalResizeRef.current;
    if (!start) return;
    setTerminalHeight(
      Math.max(160, Math.min(window.innerHeight - 180, start.startHeight + start.startY - event.clientY)),
    );
  };
  const beginTerminalResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    terminalResizeRef.current = { startY: event.clientY, startHeight: terminalHeight };
    window.addEventListener("pointermove", resizeTerminal);
    window.addEventListener("pointerup", stopTerminalResize);
  };

  const stopColumnResize = () => {
    columnResizeRef.current = null;
    window.removeEventListener("pointermove", resizeColumn);
    window.removeEventListener("pointerup", stopColumnResize);
  };
  const resizeColumn = (event: PointerEvent) => {
    const start = columnResizeRef.current;
    const area = fileAreaRef.current;
    if (!start || !area) return;
    const delta = ((event.clientX - start.startX) / area.clientWidth) * 100;
    const next = Math.max(12, Math.min(70, start.startWidth + delta));
    setColumnWidths((current) => {
      const otherTotal = Object.entries(current)
        .filter(([key]) => key !== start.key)
        .reduce((total, [, width]) => total + width, 0);
      if (next + otherTotal > 96) return current;
      return { ...current, [start.key]: next };
    });
  };
  const beginColumnResize = (
    key: ColumnKey,
    event: React.PointerEvent<HTMLSpanElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    columnResizeRef.current = {
      key,
      startX: event.clientX,
      startWidth: columnWidths[key],
    };
    window.addEventListener("pointermove", resizeColumn);
    window.addEventListener("pointerup", stopColumnResize);
  };

  const loadSshProfileDraft = (profile: SshProfile | undefined) => {
    setSshProfileDraft(profile
      ? {
          id: profile.id,
          name: profile.name,
          host: profile.host,
          port: String(profile.port),
          username: profile.username,
          privateKeyPath: profile.privateKeyPath,
          password: "",
        }
      : { id: "", name: "", host: "", port: "22", username: "", privateKeyPath: "", password: "" });
  };

  const selectWorkspaceSession = (id: string) => {
    setWorkspaceSessionId(id);
    const workspace = managedSessions.find((item) => item.id === id);
    const profile = workspace?.sshEntries[0] || sshProfiles.find((item) => item.id === sshProfileId);
    if (profile) {
      setSshEntryDraftId(workspace?.sshEntries[0]?.id || profile.id);
      setSshProfileId(profile.id);
      sshPasswordKeyRef.current = profile.id;
      loadSshProfileDraft(profile);
    }
  };

  const openSessionsModal = (requestedWorkspaceId = workspaceSessionId) => {
    void run(async () => {
      let workspace = managedSessions.find((item) => item.id === requestedWorkspaceId);
      if (!workspace && !managedSessions.length) {
        const makeId = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        let localPath = "";
        let localAlias = "Home";
        try {
          const desktop = await invoke<LocalDirectory>("local_list_directory", { path: "Desktop" });
          localPath = desktop.path;
          localAlias = "Desktop";
        } catch {
          // Home root is the safe fallback when Desktop is unavailable.
        }
        let remotePath = "";
        let remoteAlias = activeLocation?.displayName || "Remote root";
        if (session.locationId) {
          const rootResponse = await api("/api/files?path=");
          if (rootResponse.ok) {
            const root = await rootResponse.json();
            const personal = (root.files || []).find((item: FileItem) => item.isDirectory && item.name.toLowerCase() === "personal");
            if (personal) {
              remotePath = personal.path;
              const personalResponse = await api(`/api/files?path=${encodeURIComponent(personal.path)}`);
              if (personalResponse.ok) {
                const personalData = await personalResponse.json();
                const username = session.username.toLowerCase();
                const userFolder = (personalData.files || []).find((item: FileItem) => item.isDirectory && item.name.toLowerCase() === username);
                if (userFolder) {
                  remotePath = userFolder.path;
                  remoteAlias = `Personal/${userFolder.name}`;
                } else {
                  remoteAlias = "Personal";
                }
              }
            }
          }
        }
        workspace = {
          id: makeId(),
          name: "Default",
          sxpEntries: [{ id: makeId(), name: "Default Transfer", localAlias, localPath, remoteAlias, remotePath, locationId: session.locationId, locationName: activeLocation?.displayName || session.locationId }],
          sshEntries: [],
        };
        setManagedSessions([workspace]);
        setSxpWorkspaceId(workspace.id);
      }
      if (workspace) {
        setWorkspaceSessionId(workspace.id);
        if (workspace.sxpEntries.length) setSxpWorkspaceId(workspace.id);
        const sxpEntry = workspace.sxpEntries[0];
        setSxpEntryDraftId(sxpEntry?.id || "");
        setSxpEntryNameDraft(sxpEntry?.name || "Default Transfer");
        const profile = workspace.sshEntries[0] || sshProfiles.find((item) => item.id === sshProfileId);
        setSessionNameDraft(workspace.name);
        setLocalAliasDraft(sxpEntry?.localAlias || "Home");
        setRemoteAliasDraft(sxpEntry?.remoteAlias || "Personal");
        if (profile) {
          setSshEntryDraftId(workspace.sshEntries[0]?.id || profile.id);
          loadSshProfileDraft(profile);
        } else {
          setSshEntryDraftId("");
          setSshProfileDraft({ id: "", name: "", host: "", port: "22", username: "", privateKeyPath: "", password: "" });
        }
      }
      setSessionFormError("");
      setSessionsOpen(true);
    });
  };

  const startNewWorkspace = () => {
    setWorkspaceSessionId("");
    setSessionNameDraft("");
    setLocalAliasDraft("Desktop");
    setRemoteAliasDraft(activeLocation?.displayName || "Personal");
    setSxpEntryDraftId("");
    setSxpEntryNameDraft("Default Transfer");
    setSshEntryDraftId("");
    setSshProfileDraft({ id: "", name: "", host: "", port: "22", username: "", privateKeyPath: "", password: "" });
    setSessionFormError("");
  };

  const startNewSshEntry = () => {
    setSshEntryDraftId("");
    setSshProfileDraft({ id: "", name: "", host: "", port: "22", username: "", privateKeyPath: "", password: "" });
  };

  const startNewSxpEntry = () => {
    setSxpEntryDraftId("");
    setSxpEntryNameDraft("New Transfer");
    setLocalAliasDraft("Desktop");
    setRemoteAliasDraft(activeLocation?.displayName || "Personal");
  };

  const connectSsh = () => {
    const profile = activeWorkspaceSession?.sshEntries[0] || sshProfiles.find((item) => item.id === sshProfileId);
    if (!activeWorkspaceSession || !profile) {
      openSessionsModal();
      setNotice("Select or create a Session with an SSH connection before connecting.");
      return;
    }
    void run(async () => {
      sshPasswordKeyRef.current = profile.id;
      sshSecretPromptRef.current = false;
      const id = await invoke<string>("ssh_connect", {
        profile: {
          name: profile.name,
          host: profile.host,
          port: profile.port,
           username: profile.username,
           privateKeyPath: profile.privateKeyPath || null,
         },
      });
      setSshSessionId(id);
      setSshConnected(true);
      sshOutputRef.current = `Connecting to ${profile.username}@${profile.host}:${profile.port}...\n`;
      setSshOutput(sshOutputRef.current);
    });
  };

  const disconnectSsh = () => {
    if (!sshSessionId) return;
    void run(async () => {
      await invoke("ssh_disconnect", { sessionId: sshSessionId });
      setSshConnected(false);
      setSshSessionId("");
      if (recording) setRecording(false);
      sshOutputRef.current += "\nDisconnected.\n";
      setSshOutput(sshOutputRef.current);
    });
  };

  const startRecording = () => {
    if (!sshConnected) return;
    rawLogRef.current = "";
    plainLogRef.current = "";
    commandLogRef.current = "";
    setRecordingStartedAt(Date.now());
    setRecording(true);
    notify("SSH output recording started.");
  };

  const stopRecording = () => {
    setRecording(false);
    notify("Recording finalized. Save the log package before disconnecting.");
  };

  const saveSshLogs = () => {
    const profile = sshProfiles.find((item) => item.id === sshProfileId);
    if (recording) {
      setNotice("Stop the SSH recording before saving the log package.");
      return;
    }
    if (!profile || (!rawLogRef.current && !plainLogRef.current)) {
      setNotice("There is no completed SSH recording to save.");
      return;
    }
    const metadata = JSON.stringify({
      profileName: profile.name,
      host: profile.host,
      startedAt: recordingStartedAt ? new Date(recordingStartedAt).toISOString() : null,
      endedAt: new Date().toISOString(),
      rawBytes: new TextEncoder().encode(rawLogRef.current).length,
      files: ["raw.log", "txt", "commands.log", "meta.json"],
    }, null, 2);
    void run(async () => {
      const paths = await invoke<{ raw: string; plain: string; commands: string; metadata: string }>(
        "save_ssh_logs",
        {
          profileName: profile.name,
          raw: rawLogRef.current,
          plain: plainLogRef.current,
          commands: commandLogRef.current,
          metadata,
          },
      );
      setSavedLogPaths([paths.raw, paths.plain, paths.commands, paths.metadata]);
      notify(`Saved SSH logs to ${paths.raw}`);
    });
  };

  const updateQueueItem = (id: string, update: Partial<TransferQueueItem>) => {
    setTransferQueue((current) => current.map((item) => item.id === id ? { ...item, ...update } : item));
  };

  const runQueuedUpload = async (item: TransferQueueItem) => {
    updateQueueItem(item.id, { status: "running", detail: "Inspecting files..." });
    try {
      const summary = await invoke<UploadSummary>("inspect_upload_paths", { paths: item.paths });
      const checksums = await invoke<Record<string, string>>("hash_upload_paths", { paths: item.paths });
      const headers: [string, string][] = session.token
        ? [
            ["Authorization", `Bearer ${session.token}`],
            ["X-Location-ID", item.locationId],
          ]
        : [["X-Location-ID", item.locationId]];
      updateQueueItem(item.id, { detail: `Staged ${Object.keys(checksums).length} checksummed file${Object.keys(checksums).length === 1 ? "" : "s"}; uploading...` });
      const rawResponse = await invoke<NativeApiResponse>("api_upload_paths", {
        url: `${serverUrl(session)}/api/upload/multiple`,
        headers,
        paths: item.paths,
        path: item.destinationPath,
        ignoreTlsErrors: session.ignoreTlsErrors,
      });
      const response = new ApiResponse(rawResponse.status, rawResponse.body);
      if (!response.ok) throw new Error(await readError(response));
      const { batchId } = (await response.json()) as { batchId?: string };
      if (!batchId) {
        updateQueueItem(item.id, { status: "completed", detail: `Uploaded ${summary.files} file${summary.files === 1 ? "" : "s"}.` });
        return;
      }
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const progressResponse = await invoke<NativeApiResponse>("api_request", {
          url: `${serverUrl(session)}/api/progress/batch/${encodeURIComponent(batchId)}`,
          method: "GET",
          headers,
          body: null,
          ignoreTlsErrors: session.ignoreTlsErrors,
        });
        const progress = new ApiResponse(progressResponse.status, progressResponse.body);
        if (!progress.ok) throw new Error(await readError(progress));
        const batch = await progress.json() as { status: string; progress: number; successCount: number; totalFiles: number; failedCount: number };
        updateQueueItem(item.id, { detail: `${batch.successCount}/${batch.totalFiles} files (${Math.round(batch.progress)}%)` });
        if (batch.status === "completed") {
          updateQueueItem(item.id, { status: "completed", detail: `Uploaded ${batch.successCount} file${batch.successCount === 1 ? "" : "s"}.` });
          return;
        }
        if (batch.status === "failed" || batch.status === "partial_fail") {
          throw new Error(`${batch.failedCount} file${batch.failedCount === 1 ? "" : "s"} failed.`);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
      throw new Error("Upload progress timed out.");
    } catch (error) {
      updateQueueItem(item.id, {
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const uploadSavedLog = () => {
    const managedSession = managedSessions.find((item) => item.id === uploadSessionId);
    const sxpEntry = managedSession?.sxpEntries[0];
    const destination = sxpEntry && {
      path: sxpEntry.remotePath,
      locationId: sxpEntry.locationId,
      locationName: sxpEntry.locationName,
    };
    if (!savedLogPaths.length) {
      setNotice("Save the completed SSH log package before uploading it.");
      return;
    }
    if (!destination?.locationId) {
      setNotice("Select a Session with an API Remote destination before uploading the log.");
      setQueueOpen(true);
      return;
    }
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
    const item: TransferQueueItem = {
      id,
      label: "SSH log package",
      paths: savedLogPaths,
      destinationPath: destination.path,
      locationId: destination.locationId,
      locationName: destination.locationName || destination.locationId,
      status: "queued",
      detail: "Waiting to start",
    };
    setTransferQueue((current) => [...current, item]);
    setQueueOpen(true);
    void runQueuedUpload(item);
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    await run(async () => {
      validateServer(session);
      const response = await api("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: session.username, password }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json();
      setSession((current) => ({
        ...current,
        token: data.token,
        username: data.user.username,
        userId: data.user.id ?? null,
        role: data.user.role ?? "user",
        permissions: data.user.permissions ?? [],
      }));
      setPassword("");
    });
  };

  const selectedItems = files.filter((file) => selected.includes(file.path));
  const workspaceSessions = managedSessions.filter((item) => item.sshEntries.length > 0);
  const activeWorkspaceSession = workspaceSessions.find((item) => item.id === workspaceSessionId);
  const toggle = (file: FileItem, checked: boolean) =>
    setSelected((current) =>
      checked
        ? [...new Set([...current, file.path])]
        : current.filter((value) => value !== file.path),
    );

  const searchFiles = () =>
    run(async () => {
      const query = search.trim();
      if (!query) {
        if (searching) await loadFiles(pathBeforeSearch);
        return;
      }
      if (!searching) setPathBeforeSearch(path);
      const response = await api(
        `/api/files/search?query=${encodeURIComponent(query)}`,
      );
      const data = await response.json();
      if (!response.ok || data.indexing)
        throw new Error(data.message || "Search is not available yet.");
      setFiles(
        (data.files || []).filter((file: FileItem) => file.name && file.path),
      );
      setSearching(true);
      setSelected([]);
    });

  const clearSearch = () => {
    setSearch("");
    if (searching) void run(() => loadFiles(pathBeforeSearch));
  };

  const isValidMoveTarget = (items: FileItem[], destination: string) =>
    items.length > 0 &&
    items.every((item) => {
      const source = item.path;
      const sourceFolder = source.split("/").slice(0, -1).join("/");
      return (
        destination !== sourceFolder &&
        (!item.isDirectory ||
          (destination !== source && !destination.startsWith(`${source}/`)))
      );
    });

  const moveItems = (items: FileItem[], destination: string) =>
    run(async () => {
      if (!isValidMoveTarget(items, destination))
        throw new Error(
          "Choose a folder other than the current folder or a folder inside a selected folder.",
        );
      const response = await api("/api/files/paste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items.map(({ name, isDirectory, path: itemPath }) => ({
            name,
            isDirectory,
            path: itemPath,
          })),
          operation: "cut",
          targetPath: destination,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json();
      setDragItems([]);
      setDropTarget("");
      setContextMenu(null);
      notify(data.message || "Move complete.");
      setFolderTree({
        path: "",
        name: "/",
        expanded: true,
        loaded: false,
        children: [],
      });
      await Promise.all([loadFiles(path), loadTreeChildren("", true)]);
    });

  const beginDrag = (event: React.DragEvent, file: FileItem) => {
    const items = selected.includes(file.path) ? selectedItems : [file];
    if (!selected.includes(file.path)) setSelected([file.path]);
    setDragItems(items);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      "text/plain",
      items.map((item) => item.name).join(", "),
    );
  };

  const finishDrag = () => {
    setDragItems([]);
    setDropTarget("");
  };

  const download = () =>
    run(async () => {
      if (!selectedItems.length) return;
      const singleFile =
        selectedItems.length === 1 && !selectedItems[0].isDirectory;
      const fileName = singleFile ? selectedItems[0].name : "archive.zip";
      notify(
        singleFile
          ? `Preparing download: ${fileName}...`
          : `Preparing archive for ${selectedItems.length} item${selectedItems.length === 1 ? "" : "s"}...`,
        0,
      );
      const destination = await invoke<string>("download_to_disk", {
        url: singleFile
          ? `${serverUrl(session)}/api/files/download/${downloadPath(selectedItems[0].path)}`
          : `${serverUrl(session)}/api/archive`,
        method: singleFile ? "GET" : "POST",
        headers: session.token
          ? [
              ["Authorization", `Bearer ${session.token}`],
              ...(session.locationId
                ? [["X-Location-ID", session.locationId]]
                : []),
              ...(singleFile ? [] : [["Content-Type", "application/json"]]),
            ]
          : [],
        body: singleFile
          ? undefined
          : Array.from(
              new TextEncoder().encode(
                JSON.stringify({
                  items: selectedItems.map(
                    ({ name, isDirectory, path: itemPath }) => ({
                      name,
                      isDirectory,
                      path: itemPath,
                    }),
                  ),
                  currentPath: path,
                  locationId: session.locationId,
                }),
              ),
            ),
        fileName,
        ignoreTlsErrors: session.ignoreTlsErrors,
      });
      notify(`Downloaded to ${destination}`);
    });

  const uploadPaths = (paths: string[]) =>
    void run(async () => {
      if (!paths.length) return;
      notify(
        `Drop received: inspecting ${paths.length} path${paths.length === 1 ? "" : "s"}...`,
        0,
      );
      const summary = await invoke<UploadSummary>("inspect_upload_paths", {
        paths,
      });
      const accepted = window.confirm(
        `Upload ${summary.files} file${summary.files === 1 ? "" : "s"} and ${summary.directories} folder${summary.directories === 1 ? "" : "s"} to ${path ? `/${path}` : "/"}?`,
      );
      if (!accepted) return;
      const headers = session.token
        ? [
            ["Authorization", `Bearer ${session.token}`],
            ...(session.locationId
              ? [["X-Location-ID", session.locationId]]
              : []),
          ]
        : [];
      notify(
        `Uploading ${summary.files} file${summary.files === 1 ? "" : "s"}...`,
        0,
      );
      const rawResponse = await invoke<NativeApiResponse>("api_upload_paths", {
        url: `${serverUrl(session)}/api/upload/multiple`,
        headers,
        paths,
        path,
        ignoreTlsErrors: session.ignoreTlsErrors,
      });
      const response = new ApiResponse(rawResponse.status, rawResponse.body);
      if (!response.ok) throw new Error(await readError(response));
      const { batchId } = (await response.json()) as { batchId?: string };
      if (!batchId) {
        notify(
          `Uploaded ${summary.directories} folder${summary.directories === 1 ? "" : "s"}.`,
        );
        await loadFiles(path);
        return;
      }
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const progress = await api(
          `/api/progress/batch/${encodeURIComponent(batchId)}`,
        );
        if (!progress.ok) throw new Error(await readError(progress));
        const batch = (await progress.json()) as {
          status: string;
          progress: number;
          successCount: number;
          totalFiles: number;
          failedCount: number;
        };
        notify(
          `Uploading: ${batch.successCount}/${batch.totalFiles} files (${Math.round(batch.progress)}%)`,
          0,
        );
        if (batch.status === "completed") {
          notify(
            `Uploaded ${batch.successCount} file${batch.successCount === 1 ? "" : "s"}.`,
          );
          await loadFiles(path);
          return;
        }
        if (batch.status === "failed" || batch.status === "partial_fail")
          throw new Error(
            `Upload finished with ${batch.failedCount} failed file${batch.failedCount === 1 ? "" : "s"}.`,
          );
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
      throw new Error("Upload progress timed out.");
    });

  const upload = async () =>
    uploadPaths(await invoke<string[]>("pick_upload_files"));

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") uploadPaths(event.payload.paths);
      })
      .then((listener) => {
        if (disposed) listener();
        else unlisten = listener;
      })
      .catch((error) => {
        if (!disposed)
          setNotice(
            `Unable to listen for file drops: ${error instanceof Error ? error.message : String(error)}`,
          );
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [session.token, path, session.ignoreTlsErrors]);

  const createFolder = () =>
    run(async () => {
      const folderName = window.prompt("Folder name");
      if (!folderName?.trim()) return;
      const response = await api("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folderName: folderName.trim(),
          currentPath: path,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      await loadFiles(path);
      notify(`Created ${folderName.trim()}.`);
    });

  const rename = () =>
    run(async () => {
      if (selectedItems.length !== 1) return;
      const item = selectedItems[0];
      const newName = window.prompt("New name", item.name);
      if (!newName?.trim() || newName === item.name) return;
      const response = await api("/api/files/rename", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          oldName: item.name,
          newName: newName.trim(),
          currentPath: path,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      await loadFiles(path);
      notify(`Renamed ${item.name}.`);
    });

  const remove = () =>
    run(async () => {
      if (
        !selectedItems.length ||
        !window.confirm(
          `Delete ${selectedItems.length} selected item${selectedItems.length === 1 ? "" : "s"}?`,
        )
      )
        return;
      const response = await api("/api/files/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: selectedItems.map(({ name, isDirectory }) => ({
            name,
            isDirectory,
          })),
          currentPath: path,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      await loadFiles(path);
      notify("Deleted selected items.");
    });

  const share = () =>
    run(async () => {
      if (selectedItems.length !== 1 || selectedItems[0].isDirectory) return;
      const response = await api("/api/files/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationId: session.locationId,
          filePath: selectedItems[0].path,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as ShareResponse;
      const url =
        data.data?.fullUrl ||
        (data.data?.shareUrl
          ? `${serverUrl(session)}${data.data.shareUrl}`
          : "");
      if (!url) throw new Error("The server did not return a share link.");
      setShareUrl(url);
      notify("Share link created.");
    });

  const changePassword = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get("currentPassword") || "");
    const newPassword = String(form.get("newPassword") || "");
    const confirmPassword = String(form.get("confirmPassword") || "");
    void run(async () => {
      if (newPassword !== confirmPassword)
        throw new Error("The new passwords do not match.");
      const response = await api("/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!response.ok) throw new Error(await readError(response));
      setChangePasswordOpen(false);
      setSession((current) => ({ ...current, token: "" }));
      notify("Password changed. Please sign in again.");
    });
  };

  const signOut = () => {
    setAccountOpen(false);
    setSession((current) => ({
      ...current,
      token: "",
      username: "",
      userId: null,
      role: "",
      permissions: [],
    }));
  };

  const renderTreeNode = (node: FolderNode) => (
    <div className="folder-tree" key={node.path}>
      <div
        className={`tree-node ${path === node.path ? "active" : ""} ${dropTarget === node.path ? "drop-target" : ""}`}
        onDragOver={(event) => {
          if (isValidMoveTarget(dragItems, node.path)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget(node.path);
          }
        }}
        onDragLeave={() => setDropTarget("")}
        onDrop={(event) => {
          event.preventDefault();
          const items = dragItems;
          finishDrag();
          void moveItems(items, node.path);
        }}
      >
        <button
          className="tree-toggle"
          aria-label={`${node.expanded ? "Collapse" : "Expand"} ${node.name}`}
          onClick={() => toggleFolder(node)}
        >
          {node.expanded ? "−" : "+"}
        </button>
        <button
          className="tree-folder"
          onClick={() => void run(() => loadFiles(node.path))}
        >
          <span className="folder-mini" />
          {node.name}
        </button>
        {dragItems.length > 0 && dropTarget === node.path && (
          <span className="drop-label">Move here</span>
        )}
      </div>
      {node.expanded && (
        <div className="tree-children">
          {node.loaded ? (
            node.children.map(renderTreeNode)
          ) : (
            <span className="tree-loading">Loading folders...</span>
          )}
        </div>
      )}
    </div>
  );

  const renderLocalPane = () => (
    <section className="local-pane" aria-label="Local files">
      <div className="local-pane-heading">
        <span className="sidebar-label">LOCAL</span>
        <strong>{localPath ? `~/${localPath}` : "~/"}</strong>
      </div>
      <div className="local-pane-actions">
        <button
          onClick={() =>
            void run(() =>
              loadLocalFiles(parentPath(localPath)),
            )
          }
          disabled={busy || !localPath}
        >
          Up
        </button>
        <button onClick={() => void run(() => loadLocalFiles(""))} disabled={busy}>
          Home
        </button>
      </div>
      <div className="local-file-list">
        {localFiles.map((file) => (
          <button
            key={file.path}
            className={`local-file ${localSelected.includes(file.path) ? "selected" : ""}`}
            onClick={() => setLocalSelected([file.path])}
            onDoubleClick={() =>
              file.isDirectory && void run(() => loadLocalFiles(file.path))
            }
          >
            <span>{file.isDirectory ? "📁" : "📄"}</span>
            <span className="local-file-name">{file.name}</span>
            <small>{file.isDirectory ? "Folder" : formatSize(file.size)}</small>
          </button>
        ))}
        {!localFiles.length && <span className="muted">No files in this folder.</span>}
      </div>
      <div className="local-pane-footer">{localFiles.length} items</div>
    </section>
  );

  if (!session.token)
    return (
      <main className="login">
        <form onSubmit={login}>
          <div className="login-mark" aria-hidden="true">
            <span />
          </div>
          <h1>File Transfer</h1>
          <p>Sign in to your file server over HTTPS.</p>
          <label>
            Server address
            <input
              placeholder="files.example.internal"
              value={session.host}
              onChange={(event) =>
                setSession((current) => ({
                  ...current,
                  host: event.target.value,
                }))
              }
            />
          </label>
          <label>
            HTTPS port
            <input
              inputMode="numeric"
              value={session.port}
              onChange={(event) =>
                setSession((current) => ({
                  ...current,
                  port: event.target.value,
                }))
              }
            />
          </label>
          <label>
            Username
            <input
              value={session.username}
              onChange={(event) =>
                setSession((current) => ({
                  ...current,
                  username: event.target.value,
                }))
              }
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="tls-option">
            <input
              type="checkbox"
              checked={session.ignoreTlsErrors}
              onChange={(event) =>
                setSession((current) => ({
                  ...current,
                  ignoreTlsErrors: event.target.checked,
                }))
              }
            />{" "}
            Ignore SSL certificate verification{" "}
            <small>Only enable for a server you trust.</small>
          </label>
          <button disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
          {notice && <output role="alert">{notice}</output>}
          {appVersion && <small className="login-version">{appVersion}</small>}
        </form>
      </main>
    );

  return (
    <main className="explorer">
      <header className="titlebar">
        <span className="app-mark" />
        <span className="app-name">LAB File Manager</span>
        <span className="connection-status">SECURE STORAGE</span>
        {activeLocation && (
          <div className="location-control" ref={locationControl}>
            <span className="location-label">Location</span>
            {locations.length > 1 ? (
              <button
                className="location-select"
                aria-label="Location"
                aria-expanded={locationMenuOpen}
                aria-haspopup="listbox"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  setLocationMenuOpen((open) => !open);
                }}
              >
                {activeLocation.displayName}
                <span className="location-chevron" aria-hidden="true">⌄</span>
              </button>
            ) : (
              <span className="location-single">
                {activeLocation.displayName}
              </span>
            )}
            {locations.length > 1 && locationMenuOpen && (
              <div className="location-menu" role="listbox" aria-label="Locations">
                {locations.map((location) => (
                  <button
                    key={location.id}
                    className={location.id === session.locationId ? "selected" : ""}
                    role="option"
                    aria-selected={location.id === session.locationId}
                    onClick={() => {
                      setLocationMenuOpen(false);
                      void selectLocation(location.id);
                    }}
                  >
                    {location.displayName}
                  </button>
                ))}
              </div>
            )}
            <span
              className={`health-dot ${activeLocation.status === "online" ? "online" : ""}`}
              title={activeLocation.status || "unknown"}
              aria-label={activeLocation.status || "unknown"}
            />
          </div>
        )}
        <div className="account-control" ref={accountControl}>
          <button
            className="account"
            onClick={(event) => {
              event.stopPropagation();
              setAccountOpen((open) => !open);
            }}
            aria-expanded={accountOpen}
          >
            {session.username}
            <span className="account-role">
              {session.role === "admin" ? "Admin" : "User"}
            </span>
            <span className="account-chevron">⌄</span>
          </button>
          {accountOpen && (
            <div className="account-menu">
              <div className="account-summary">
                <strong>{session.username}</strong>
                <span>
                  {session.role === "admin"
                    ? "System administrator"
                    : "Standard user"}
                </span>
              </div>
              <button
                onClick={() => {
                   setAccountOpen(false);
                   openSessionsModal();
                }}
              >
                Sessions
              </button>
              <button
                onClick={() => {
                  setAccountOpen(false);
                  setChangePasswordOpen(true);
                }}
              >
                Change password
              </button>
              <hr />
              <button className="danger" onClick={signOut}>
                Log out
              </button>
            </div>
          )}
        </div>
      </header>
      <nav className="commandbar" aria-label="File actions">
        <button
          className="primary"
          onClick={upload}
          disabled={busy || !locationOnline || !hasCapability("upload")}
        >
          Upload
        </button>
        <button
          onClick={createFolder}
          disabled={busy || !locationOnline || !hasCapability("mkdir")}
        >
          New folder
        </button>
        <span className="divider" />
        <button
          disabled={
            busy ||
            !locationOnline ||
            !selectedItems.length ||
            !hasCapability("read")
          }
          onClick={download}
        >
          Download
        </button>
        <button
          disabled={
            busy ||
            !locationOnline ||
            !selectedItems.length ||
            !hasCapability("move")
          }
          onClick={() =>
            notify("Drag selected files to a destination folder to move them.")
          }
        >
          Move
        </button>
        <button
          disabled={
            busy ||
            !locationOnline ||
            selectedItems.length !== 1 ||
            !hasCapability("rename")
          }
          onClick={rename}
        >
          Rename
        </button>
        <button
          disabled={
            busy ||
            !locationOnline ||
            selectedItems.length !== 1 ||
            selectedItems[0].isDirectory ||
            !hasCapability("share")
          }
          onClick={share}
        >
          Share
        </button>
        <button
          disabled={
            busy ||
            !locationOnline ||
            !selectedItems.length ||
            !hasCapability("delete")
          }
          onClick={remove}
        >
          Delete
        </button>
        <span className="divider" />
        <button
          onClick={() =>
            setSelected(
              selected.length === files.length
                ? []
                : files.map((file) => file.path),
            )
          }
        >
          Select all
        </button>
        <span className="view-switch">
          <button
            className={viewMode === "details" ? "active" : ""}
            onClick={() => setViewMode("details")}
          >
            Details
          </button>
          <button
            className={viewMode === "grid" ? "active" : ""}
            onClick={() => setViewMode("grid")}
          >
            Grid
          </button>
          <button
            className={splitMode ? "active" : ""}
            onClick={() => setSplitMode((enabled) => !enabled)}
            aria-pressed={splitMode}
          >
            Split
          </button>
        </span>
        <button
          onClick={() => {
            void loadLocations();
            void run(() => loadFiles(path));
          }}
          disabled={busy}
        >
          Refresh
        </button>
        <button
          className={terminalOpen ? "active" : ""}
          onClick={() => setTerminalOpen((open) => !open)}
          aria-pressed={terminalOpen}
          aria-label="Terminal"
        >
          Terminal
        </button>
      </nav>
      <div className="navigation">
        <button
          className="nav-button"
          onClick={() =>
            void run(() =>
              loadFiles(searching ? pathBeforeSearch : parentPath(path)),
            )
          }
          disabled={busy || (!path && !searching)}
        >
          ↑
        </button>
        <div className="crumbs">
          <button onClick={() => void run(() => loadFiles(""))}>/</button>
          {path
            .split("/")
            .filter(Boolean)
            .map((part, index, parts) => (
              <React.Fragment key={`${part}-${index}`}>
                <span className="crumb-separator">›</span>
                <button
                  onClick={() =>
                    void run(() =>
                      loadFiles(parts.slice(0, index + 1).join("/")),
                    )
                  }
                >
                  {part}
                </button>
              </React.Fragment>
            ))}
        </div>
        <div className="search-control">
          <input
            className="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") searchFiles();
              if (event.key === "Escape") clearSearch();
            }}
            placeholder="Search files"
          />
          {(search || searching) && (
            <button className="clear-search" onClick={clearSearch}>
              ×
            </button>
          )}
        </div>
      </div>
      <div className={`desktop-workspace${splitMode ? " split-workspace" : ""}`}>
        {splitMode && renderLocalPane()}
        <aside className="desktop-folder-tree">
          <span className="sidebar-label">Folders</span>
          <div className="folder-pane">
            <div id="folders" ref={folderTreeRef} className="folder-tree-scroll">
              {renderTreeNode(folderTree)}
            </div>
            <PersistentScrollbar targetRef={folderTreeRef} label="Folders" />
          </div>
        </aside>
        <section className="desktop-content">
          <div className="content-heading">
            <div>
              <span className="eyebrow">CURRENT DIRECTORY</span>
              <h1>
                {searching ? `Search results for "${search}"` : path || "/"}
              </h1>
            </div>
            {selectedItems.length > 0 && (
              <span className="selection-count">
                {selectedItems.length} selected
              </span>
            )}
          </div>
          {notice && (
            <output className="notice transfer-notice" role="status">
              {notice}
            </output>
          )}
          {shareUrl && (
            <div className="share-link">
              <label>
                Share link
                <input
                  readOnly
                  value={shareUrl}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <button
                onClick={() =>
                  void navigator.clipboard
                    .writeText(shareUrl)
                    .then(() => notify("Share link copied."))
                    .catch((error) => setNotice(error.message))
                }
              >
                Copy link
              </button>
              <button onClick={() => setShareUrl("")}>Close</button>
            </div>
          )}
          <div className="file-pane">
            <div id="files" ref={fileAreaRef} className="file-area">
              {viewMode === "grid" ? (
              <div className="file-grid">
                {files.map((file) => (
                  <article
                    key={file.path}
                    className={`file-tile ${selected.includes(file.path) ? "selected" : ""} ${dropTarget === file.path ? "drop-target" : ""}`}
                    draggable
                    onDragStart={(event) => beginDrag(event, file)}
                    onDragEnd={finishDrag}
                    onDragOver={(event) => {
                      if (
                        file.isDirectory &&
                        isValidMoveTarget(dragItems, file.path)
                      ) {
                        event.preventDefault();
                        setDropTarget(file.path);
                      }
                    }}
                    onDrop={(event) => {
                      if (file.isDirectory) {
                        event.preventDefault();
                        const items = dragItems;
                        finishDrag();
                        void moveItems(items, file.path);
                      }
                    }}
                    onClick={(event) => {
                      if (event.ctrlKey || event.metaKey) toggle(file, true);
                      else setSelected([file.path]);
                    }}
                    onDoubleClick={() =>
                      file.isDirectory
                        ? void run(() => loadFiles(file.path))
                        : download()
                    }
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (!selected.includes(file.path))
                        setSelected([file.path]);
                      setContextMenu({ x: event.clientX, y: event.clientY });
                    }}
                  >
                    <span className="tile-icon">
                      {file.isDirectory ? "📁" : "📄"}
                    </span>
                    <strong>{file.name}</strong>
                    <span>{file.isDirectory ? "File folder" : "File"}</span>
                    <small>
                      {file.isDirectory
                        ? "Drop files here"
                        : formatSize(file.size)}
                    </small>
                  </article>
                ))}
              </div>
            ) : (
              <table className="file-table">
                <colgroup>
                  <col className="selection-column" />
                  <col style={{ width: `${columnWidths.name}%` }} />
                  <col style={{ width: `${columnWidths.modified}%` }} />
                  <col style={{ width: `${columnWidths.size}%` }} />
                </colgroup>
                <thead>
                  <tr>
                    <th aria-label="Select" />
                    {(["name", "modified", "size"] as ColumnKey[]).map((column) => (
                      <th key={column} className="resizable-column">
                        {column[0].toUpperCase() + column.slice(1)}
                        <span
                          className="column-resize-handle"
                          onPointerDown={(event) => beginColumnResize(column, event)}
                          role="separator"
                          aria-label={`Resize ${column} column`}
                        />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {files.map((file) => (
                    <tr
                      key={file.path}
                      draggable
                      className={`file-row ${selected.includes(file.path) ? "selected" : ""} ${dropTarget === file.path ? "drop-target" : ""}`}
                      onDragStart={(event) => beginDrag(event, file)}
                      onDragEnd={finishDrag}
                      onDragOver={(event) => {
                        if (
                          file.isDirectory &&
                          isValidMoveTarget(dragItems, file.path)
                        ) {
                          event.preventDefault();
                          setDropTarget(file.path);
                        }
                      }}
                      onDrop={(event) => {
                        if (file.isDirectory) {
                          event.preventDefault();
                          const items = dragItems;
                          finishDrag();
                          void moveItems(items, file.path);
                        }
                      }}
                      onClick={(event) => {
                        if (event.ctrlKey || event.metaKey) toggle(file, true);
                        else setSelected([file.path]);
                      }}
                      onDoubleClick={() =>
                        file.isDirectory
                          ? void run(() => loadFiles(file.path))
                          : download()
                      }
                      onContextMenu={(event) => {
                        event.preventDefault();
                        if (!selected.includes(file.path))
                          setSelected([file.path]);
                        setContextMenu({ x: event.clientX, y: event.clientY });
                      }}
                    >
                      <td>
                        <input
                          aria-label={`Select ${file.name}`}
                          type="checkbox"
                          checked={selected.includes(file.path)}
                          onChange={(event) =>
                            toggle(file, event.target.checked)
                          }
                          onClick={(event) => event.stopPropagation()}
                        />
                      </td>
                      <td>
                        <span className="file-name">
                          {file.isDirectory ? "📁" : "📄"} {file.name}
                        </span>
                      </td>
                      <td className="muted">
                        {file.modified
                          ? new Date(file.modified).toLocaleString()
                          : "--"}
                      </td>
                      <td className="muted">
                        {file.isDirectory ? "--" : formatSize(file.size)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            </div>
            <PersistentScrollbar targetRef={fileAreaRef} label="Files" />
          </div>
        </section>
      </div>
      <footer className="statusbar">
        <span>
          {files.length} item{files.length === 1 ? "" : "s"}
        </span>
        <span>{searching ? "Search results" : path ? `/${path}` : "/"}</span>
      </footer>
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            disabled={!selectedItems.length}
            onClick={() => {
              setContextMenu(null);
              download();
            }}
          >
            Download
          </button>
          <button
            disabled={!selectedItems.length}
            onClick={() => {
              setContextMenu(null);
              notify(
                "Drag selected files to a destination folder to move them.",
              );
            }}
          >
            Move
          </button>
          <button
            disabled={selectedItems.length !== 1}
            onClick={() => {
              setContextMenu(null);
              rename();
            }}
          >
            Rename
          </button>
          <button
            disabled={
              selectedItems.length !== 1 || selectedItems[0].isDirectory
            }
            onClick={() => {
              setContextMenu(null);
              share();
            }}
          >
            Share
          </button>
          <hr />
          <button
            disabled={!selectedItems.length}
            onClick={() => {
              setContextMenu(null);
              remove();
            }}
          >
            Delete
          </button>
        </div>
      )}
      {changePasswordOpen && (
        <div
          className="modal-cover"
          onMouseDown={() => setChangePasswordOpen(false)}
        >
          <div
            className="modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2>Change password</h2>
            <form onSubmit={changePassword}>
              <p>Changing your password signs this device out.</p>
              <label>
                Current password
                <input
                  name="currentPassword"
                  type="password"
                  autoFocus
                  required
                />
              </label>
              <label>
                New password
                <input
                  name="newPassword"
                  type="password"
                  minLength={6}
                  required
                />
              </label>
              <label>
                Confirm new password
                <input
                  name="confirmPassword"
                  type="password"
                  minLength={6}
                  required
                />
              </label>
              <div className="modal-actions">
                <button
                  type="button"
                  onClick={() => setChangePasswordOpen(false)}
                >
                  Cancel
                </button>
                <button className="confirm" type="submit" disabled={busy}>
                  Change password
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {sessionsOpen && (
        <div
          className="modal-cover"
          onMouseDown={() => setSessionsOpen(false)}
        >
          <div
            className="modal sessions-modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2>Sessions</h2>
             <p>Save LOCAL, API Remote, and SSH connection details as one Session shared by SXP and SSH.</p>
            {sessionFormError && <output className="form-error" role="alert">{sessionFormError}</output>}
            <div className="sessions-layout">
              <form
                className="session-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveSession(event.currentTarget);
                }}
              >
              <label>
                Session name
                <input
                  name="sessionName"
                  value={sessionNameDraft}
                  onChange={(event) => setSessionNameDraft(event.target.value)}
                  placeholder="ReleaseWorkspace"
                  required
                />
               <small className="field-help">Name for this saved workspace.</small>
              </label>
              <div className="sxp-entry-picker">
                <span>SXP entries in this Workspace</span>
                <div>
                  {managedSessions.find((item) => item.id === workspaceSessionId)?.sxpEntries.map((entry) => (
                    <button type="button" className={entry.id === sxpEntryDraftId ? "selected" : ""} key={entry.id} onClick={() => { setSxpEntryDraftId(entry.id); setSxpEntryNameDraft(entry.name); setLocalAliasDraft(entry.localAlias); setRemoteAliasDraft(entry.remoteAlias); }}>
                      {entry.name}
                    </button>
                  ))}
                  <button type="button" onClick={startNewSxpEntry}>+ Add SXP Entry</button>
                </div>
              </div>
              <label>
                SXP entry name
                <input name="sxpEntryName" value={sxpEntryNameDraft} onChange={(event) => setSxpEntryNameDraft(event.target.value)} required />
              </label>
              <label>
                Local folder name
                <input
                  name="localFolderName"
                  value={localAliasDraft}
                  onChange={(event) => setLocalAliasDraft(event.target.value)}
                  required
                />
                <small className="field-help">Name used to identify the current LOCAL folder in this Session.</small>
              </label>
               <label>
                 Remote folder name
                <input
                  name="remoteFolderName"
                  value={remoteAliasDraft}
                  onChange={(event) => setRemoteAliasDraft(event.target.value)}
                  required
                />
                 <small className="field-help">Name used to identify the current API Remote folder in this Session.</small>
               </label>
                <fieldset className="session-ssh-fields">
                  <legend>SSH connection (optional)</legend>
                  <div className="ssh-entry-picker">
                    <span>SSH entries in this Workspace</span>
                    <div>
                      {managedSessions.find((item) => item.id === workspaceSessionId)?.sshEntries.map((entry) => (
                        <button type="button" className={entry.id === sshEntryDraftId ? "selected" : ""} key={entry.id} onClick={() => { setSshEntryDraftId(entry.id); setSshProfileId(entry.id); sshPasswordKeyRef.current = entry.id; loadSshProfileDraft(entry); }}>
                          {entry.name}
                        </button>
                      ))}
                      <button type="button" onClick={startNewSshEntry}>+ Add SSH Entry</button>
                    </div>
                  </div>
                  <label>
                    Connection name
                    <input name="sshName" value={sshProfileDraft.name} onChange={(event) => setSshProfileDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Production shell" />
                  </label>
                  <label>
                    Host
                    <input name="sshHost" value={sshProfileDraft.host} onChange={(event) => setSshProfileDraft((current) => ({ ...current, host: event.target.value }))} placeholder="server.example.com" />
                  </label>
                  <label>
                    Port
                    <input name="sshPort" inputMode="numeric" value={sshProfileDraft.port} onChange={(event) => setSshProfileDraft((current) => ({ ...current, port: event.target.value }))} />
                  </label>
                  <label>
                    Username
                    <input name="sshUsername" value={sshProfileDraft.username} onChange={(event) => setSshProfileDraft((current) => ({ ...current, username: event.target.value }))} />
                  </label>
                  <label>
                    Private key path (optional)
                    <input name="sshPrivateKeyPath" value={sshProfileDraft.privateKeyPath} onChange={(event) => setSshProfileDraft((current) => ({ ...current, privateKeyPath: event.target.value }))} placeholder="/home/test/.ssh/id_ed25519" />
                  </label>
                  <label>
                    Password (optional)
                    <input name="sshPassword" type="password" autoComplete="new-password" value={sshProfileDraft.password} onChange={(event) => setSshProfileDraft((current) => ({ ...current, password: event.target.value }))} placeholder="Stored in the OS keyring" />
                  </label>
                  <small className="field-help">SSH details are stored inside this Session. The password is saved only in the OS keyring.</small>
                </fieldset>
              <div className="modal-actions">
                <button type="button" onClick={() => setSessionsOpen(false)}>
                  Close
                </button>
                <button className="confirm" type="submit">
                  Save current paths
                </button>
              </div>
              </form>
              <div className="session-list">
                <div className="session-list-heading">
                  <strong>Workspaces</strong>
                  <button type="button" className="confirm" onClick={startNewWorkspace}>+ New Workspace</button>
                </div>
                {lastSavedSessionId && <span className="session-saved-note">Saved successfully.</span>}
              {!managedSessions.length && (
                <span className="muted">No Sessions saved yet.</span>
              )}
              {managedSessions.map((managedSession) => (
                <div className="session-card" key={managedSession.id}>
                  <div className="session-card-heading">
                    <strong>{managedSession.name}</strong>
                    <button type="button" onClick={() => openSessionsModal(managedSession.id)}>Edit</button>
                    <button
                      type="button"
                      className="session-delete"
                      disabled={managedSessions.length === 1}
                      onClick={() => removeSession(managedSession.id)}
                    >
                      Remove
                    </button>
                  </div>
                  {managedSession.sxpEntries.map((entry) => (
                    <div className="session-entry" key={entry.id}>
                      <span>SXP: {entry.name}</span>
                      <small>LOCAL ~/{entry.localPath || ""} → {entry.locationName || entry.locationId}:{entry.remotePath || "/"}</small>
                    </div>
                  ))}
                  {managedSession.sshEntries.map((entry) => (
                    <div className="session-entry" key={entry.id}>
                      <span>SSH: {entry.name}</span>
                      <small>{entry.username}@{entry.host}:{entry.port}</small>
                    </div>
                  ))}
                </div>
              ))}
              </div>
            </div>
          </div>
        </div>
      )}
      {terminalOpen && (
        <section className="terminal-dock" style={{ height: `${terminalHeight}px` }} aria-label="Terminal panel">
          <div className="terminal-resize-handle" onPointerDown={beginTerminalResize} role="separator" aria-label="Resize terminal" />
          <header className="terminal-header">
            <div className="terminal-tabs">
              <button className={terminalTab === "sxp" ? "active" : ""} onClick={() => setTerminalTab("sxp")}>SXP</button>
              <button className={terminalTab === "ssh" ? "active" : ""} onClick={() => setTerminalTab("ssh")}>SSH</button>
            </div>
            <div className="terminal-actions">
              <button onClick={() => openSessionsModal()}>Open Sessions</button>
              <button onClick={() => setQueueOpen(true)}>Transfer Queue ({transferQueue.filter((item) => item.status === "queued" || item.status === "running").length})</button>
              <button aria-label="Collapse terminal" onClick={() => setTerminalOpen(false)}>⌄</button>
            </div>
          </header>
          {terminalTab === "sxp" ? (
            <div className="terminal-content">
              <div className="sxp-terminal-controls">
                <PaletteSelect
                  label="Select a File Transfer Workspace"
                  value={sxpWorkspaceId}
                  options={managedSessions.filter((workspace) => workspace.sxpEntries.length > 0).map((workspace) => ({ value: workspace.id, label: workspace.name }))}
                  onChange={setSxpWorkspaceId}
                />
              </div>
              <div ref={terminalHostRef} className="xterm-host" aria-label="SXP terminal" />
              <button
                className="terminal-help-button"
                aria-label="Show SXP help"
                onClick={() => setSxpHelpOpen((open) => !open)}
              >
                ?
              </button>
              {sxpHelpOpen && <pre className="terminal-help-popover">{sxpHelp}</pre>}
            </div>
          ) : (
            <div className="terminal-content ssh-terminal-content">
              <div className="ssh-controls">
                <PaletteSelect
                  label="Select a Session"
                  value={workspaceSessionId}
                  options={workspaceSessions.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
                  onChange={selectWorkspaceSession}
                />
                {!sshConnected ? (
                  <button className="confirm" onClick={connectSsh}>Connect</button>
                ) : (
                  <button className="danger" onClick={disconnectSsh}>Disconnect</button>
                )}
              </div>
              {!activeWorkspaceSession && <p className="terminal-inline-note">Create or open a Session with an SSH connection before connecting.</p>}
              <div ref={terminalHostRef} className="xterm-host" aria-label="SSH terminal" />
              <div className="ssh-recording-actions">
                    {!recording ? (
                      <button disabled={!sshConnected} onClick={startRecording}>Start Recording</button>
                    ) : (
                      <button className="danger" onClick={stopRecording}>Stop Recording</button>
                    )}
                    <button disabled={recording || !rawLogRef.current} onClick={saveSshLogs}>Save Log</button>
                    <div className="upload-session-select">
                      <span>Destination Session</span>
                      <PaletteSelect
                        label="Select Session"
                        value={uploadSessionId}
                        options={managedSessions.map((managedSession) => ({ value: managedSession.id, label: managedSession.name }))}
                        onChange={setUploadSessionId}
                      />
                    </div>
                    <button disabled={!savedLogPaths.length || recording} onClick={uploadSavedLog}>Upload Log</button>
                    {recording && <span className="recording-indicator">Recording</span>}
              </div>
            </div>
          )}
        </section>
      )}
      {!terminalOpen && (
        <button className="terminal-restore" onClick={() => setTerminalOpen(true)} aria-label="Restore terminal">
          Terminal ⌃
        </button>
      )}
      {queueOpen && (
        <div className="modal-cover" onMouseDown={() => setQueueOpen(false)}>
          <div className="modal queue-modal" onMouseDown={(event) => event.stopPropagation()}>
            <h2>Transfer Queue</h2>
            {!transferQueue.length && <p className="muted">No transfers queued.</p>}
            {transferQueue.map((item) => (
              <div className="queue-item" key={item.id}>
                <strong>{item.label}</strong>
                <small>{item.locationName} {item.destinationPath || "/"}</small>
                <span className={`queue-status ${item.status}`}>{item.status}</span>
                <span>{item.detail}</span>
                {item.status === "failed" && (
                  <button type="button" onClick={() => {
                    updateQueueItem(item.id, { status: "queued", detail: "Retry queued" });
                    void runQueuedUpload({ ...item, status: "queued", detail: "Retry queued" });
                  }}>Retry</button>
                )}
              </div>
            ))}
            <div className="modal-actions">
              <button type="button" onClick={() => setQueueOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
