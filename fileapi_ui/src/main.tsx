import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "./styles.css";
import "./login.css";
import "./location-control.css";
import "./tls.css";
import "./webui-shell.css";
import "./explorer-parity.css";

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
  kind: "LOCAL" | "REMOTE";
  path: string;
  locationId?: string;
  locationName?: string;
};
type ManagedSession = {
  id: string;
  name: string;
  entries: SessionEntry[];
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

const sxpHelp = `sxp <Session name> upload <source folder> <destination folder>
sxp <Session name> mv <source folder> <destination folder>

REMOTE (Location name) is the API Remote selected by the top LOCATION control.
Source and destination folders must be named folders in the selected Session.`;

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
  const source = session.entries.find((entry) => entry.alias === args[3]);
  const destination = session.entries.find((entry) => entry.alias === args[4]);
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
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sxpInput, setSxpInput] = useState("");
  const [sxpOutput, setSxpOutput] = useState("");
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
  const [sshProfileId, setSshProfileId] = useState("");
  const [sshConnected, setSshConnected] = useState(false);
  const [sshSessionId, setSshSessionId] = useState("");
  const [sshOutput, setSshOutput] = useState("");
  const [sshInput, setSshInput] = useState("");
  const [sshProfileOpen, setSshProfileOpen] = useState(false);
  const [sshProfileDraft, setSshProfileDraft] = useState({
    name: "",
    host: "",
    port: "22",
    username: "",
    privateKeyPath: "",
  });
  const [recording, setRecording] = useState(false);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const rawLogRef = useRef("");
  const plainLogRef = useRef("");
  const commandLogRef = useRef("");
  const [sessionNameDraft, setSessionNameDraft] = useState("");
  const [localAliasDraft, setLocalAliasDraft] = useState("LocalHome");
  const [remoteAliasDraft, setRemoteAliasDraft] = useState("RemoteRoot");
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
    if (!sshSessionId) return undefined;
    let disposed = false;
    const unlistenOutput = listen<SshEvent>("ssh-output", (event) => {
      if (disposed || event.payload.sessionId !== sshSessionId) return;
      const data = event.payload.data;
      setSshOutput((current) => current + data);
      if (recording) {
        rawLogRef.current += data;
        plainLogRef.current += stripAnsi(data);
      }
    });
    const unlistenExit = listen<SshEvent>("ssh-exit", (event) => {
      if (disposed || event.payload.sessionId !== sshSessionId) return;
      setSshConnected(false);
      setSshOutput((current) => `${current}\n${event.payload.data}\n`);
    });
    return () => {
      disposed = true;
      void unlistenOutput.then((dispose) => dispose());
      void unlistenExit.then((dispose) => dispose());
    };
  }, [sshSessionId, recording]);

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

  const saveSession = () => {
    const name = sessionNameDraft.trim();
    const localAlias = localAliasDraft.trim();
    const remoteAlias = remoteAliasDraft.trim();
    if (!name || !localAlias || !remoteAlias) {
      setNotice("Session name and both entry aliases are required.");
      return;
    }
    if ([name, localAlias, remoteAlias].some((value) => /\s/.test(value))) {
      setNotice("Session names and entry aliases cannot contain spaces.");
      return;
    }
    if (!activeLocation || !session.locationId) {
      setNotice("A connected Remote Location is required to save a Session.");
      return;
    }
    const makeId = () =>
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const managedSession: ManagedSession = {
      id: makeId(),
      name,
      entries: [
        {
          id: makeId(),
          alias: localAlias,
          kind: "LOCAL",
          path: localPath,
        },
        {
          id: makeId(),
          alias: remoteAlias,
          kind: "REMOTE",
          path,
          locationId: session.locationId,
          locationName: activeLocation.displayName,
        },
      ],
    };
    setManagedSessions((current) => [...current, managedSession]);
    setSessionNameDraft("");
    notify(`Saved Session: ${name}`);
  };

  const openSessionEntry = (entry: SessionEntry) => {
    if (entry.kind === "LOCAL") {
      setSplitMode(true);
      void run(() => loadLocalFiles(entry.path));
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
    setManagedSessions((current) => current.filter((item) => item.id !== sessionId));
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

  const saveSshProfile = () => {
    const name = sshProfileDraft.name.trim();
    const host = sshProfileDraft.host.trim();
    const username = sshProfileDraft.username.trim();
    const port = Number(sshProfileDraft.port);
    if (!name || !host || !username || !Number.isInteger(port) || port < 1 || port > 65535) {
      setNotice("Enter a profile name, host, username, and valid SSH port.");
      return;
    }
    const id = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const profile: SshProfile = {
      id,
      name,
      host,
      port,
      username,
      privateKeyPath: sshProfileDraft.privateKeyPath.trim(),
    };
    setSshProfiles((current) => [...current, profile]);
    setSshProfileId(id);
    setSshProfileDraft({ name: "", host: "", port: "22", username: "", privateKeyPath: "" });
    setSshProfileOpen(false);
    notify(`Saved SSH Profile: ${name}`);
  };

  const connectSsh = () => {
    const profile = sshProfiles.find((item) => item.id === sshProfileId);
    if (!profile) {
      setSshProfileOpen(true);
      setNotice("Select or create an SSH Profile before connecting.");
      return;
    }
    void run(async () => {
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
      setSshOutput(`Connecting to ${profile.username}@${profile.host}:${profile.port}...\n`);
    });
  };

  const disconnectSsh = () => {
    if (!sshSessionId) return;
    void run(async () => {
      await invoke("ssh_disconnect", { sessionId: sshSessionId });
      setSshConnected(false);
      setSshSessionId("");
      if (recording) setRecording(false);
      setSshOutput((current) => `${current}\nDisconnected.\n`);
    });
  };

  const sendSshInput = () => {
    const input = sshInput;
    if (!input.trim() || !sshConnected || !sshSessionId) return;
    const secretPrompt = /(password|passphrase|verification code|token)\s*[:?]\s*$/i.test(
      sshOutput.slice(-180),
    );
    void run(async () => {
      await invoke("ssh_write", { sessionId: sshSessionId, data: `${input}\n` });
      if (recording && !secretPrompt) {
        commandLogRef.current += `[${new Date().toISOString()}] ${input}\n`;
      }
      setSshInput("");
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
      notify(`Saved SSH logs to ${paths.raw}`);
    });
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
                  setSessionsOpen(true);
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
            <p>Save the current LOCAL and API Remote folders under a name you can recognize later.</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                saveSession();
              }}
            >
              <label>
                Session name
                <input
                  value={sessionNameDraft}
                  onChange={(event) => setSessionNameDraft(event.target.value)}
                  placeholder="ReleaseWorkspace"
                  required
                />
                <small className="field-help">Name for this saved workspace.</small>
              </label>
              <label>
                Local folder name
                <input
                  value={localAliasDraft}
                  onChange={(event) => setLocalAliasDraft(event.target.value)}
                  required
                />
                <small className="field-help">Name used to identify the current LOCAL folder in this Session.</small>
              </label>
              <label>
                Remote folder name
                <input
                  value={remoteAliasDraft}
                  onChange={(event) => setRemoteAliasDraft(event.target.value)}
                  required
                />
                <small className="field-help">Name used to identify the current API Remote folder in this Session.</small>
              </label>
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
              <strong>Saved Sessions</strong>
              {!managedSessions.length && (
                <span className="muted">No Sessions saved yet.</span>
              )}
              {managedSessions.map((managedSession) => (
                <div className="session-card" key={managedSession.id}>
                  <div className="session-card-heading">
                    <strong>{managedSession.name}</strong>
                    <button
                      type="button"
                      className="session-delete"
                      onClick={() => removeSession(managedSession.id)}
                    >
                      Remove
                    </button>
                  </div>
                  {managedSession.entries.map((entry) => (
                    <button
                      className="session-entry"
                      key={entry.id}
                      onClick={() => openSessionEntry(entry)}
                    >
                      <span>{entry.alias}</span>
                      <small>
                        {entry.kind === "REMOTE"
                          ? `REMOTE (${entry.locationName || entry.locationId}) ${entry.path || "/"}`
                          : `LOCAL ~/${entry.path || ""}`}
                      </small>
                    </button>
                  ))}
                </div>
              ))}
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
              <button onClick={() => setSessionsOpen(true)}>Open Sessions</button>
              <button aria-label="Collapse terminal" onClick={() => setTerminalOpen(false)}>⌄</button>
            </div>
          </header>
          {terminalTab === "sxp" ? (
            <div className="terminal-content">
              <pre className="sxp-output">{sxpOutput || (managedSessions.length ? sxpHelp : "Please create a Session before using SXP.")}</pre>
              <form
                className="terminal-command"
                onSubmit={(event) => {
                  event.preventDefault();
                  setSxpOutput(parseSxpCommand(sxpInput, managedSessions));
                }}
              >
                <input
                  value={sxpInput}
                  onChange={(event) => setSxpInput(event.target.value)}
                  placeholder="sxp <Session name> upload <source folder> <destination folder>"
                  spellCheck={false}
                  aria-label="SXP command"
                />
                <button className="confirm" type="submit">Run</button>
              </form>
            </div>
          ) : (
            <div className="terminal-content ssh-terminal-content">
              <div className="ssh-controls">
                <label>
                  SSH Profile
                  <select value={sshProfileId} onChange={(event) => setSshProfileId(event.target.value)}>
                    <option value="">Select a profile</option>
                    {sshProfiles.map((profile) => (
                      <option value={profile.id} key={profile.id}>{profile.name}</option>
                    ))}
                  </select>
                </label>
                <button onClick={() => setSshProfileOpen((open) => !open)}>
                  {sshProfileOpen ? "Close Profile Editor" : "Manage SSH Profiles"}
                </button>
                {!sshConnected ? (
                  <button className="confirm" onClick={connectSsh}>Connect</button>
                ) : (
                  <button className="danger" onClick={disconnectSsh}>Disconnect</button>
                )}
              </div>
              {sshProfileOpen ? (
                <form
                  className="ssh-profile-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveSshProfile();
                  }}
                >
                  <label>Profile name<input value={sshProfileDraft.name} onChange={(event) => setSshProfileDraft((current) => ({ ...current, name: event.target.value }))} required /></label>
                  <label>Host<input value={sshProfileDraft.host} onChange={(event) => setSshProfileDraft((current) => ({ ...current, host: event.target.value }))} placeholder="server.example.com" required /></label>
                  <label>Port<input inputMode="numeric" value={sshProfileDraft.port} onChange={(event) => setSshProfileDraft((current) => ({ ...current, port: event.target.value }))} required /></label>
                  <label>Username<input value={sshProfileDraft.username} onChange={(event) => setSshProfileDraft((current) => ({ ...current, username: event.target.value }))} required /></label>
                  <label>Private key path (optional)<input value={sshProfileDraft.privateKeyPath} onChange={(event) => setSshProfileDraft((current) => ({ ...current, privateKeyPath: event.target.value }))} placeholder="/home/test/.ssh/id_ed25519" /></label>
                  <button className="confirm" type="submit">Save SSH Profile</button>
                </form>
              ) : (
                <>
                  <pre className="ssh-output">{sshOutput || "Select an SSH Profile and connect."}</pre>
                  <div className="ssh-recording-actions">
                    {!recording ? (
                      <button disabled={!sshConnected} onClick={startRecording}>Start Recording</button>
                    ) : (
                      <button className="danger" onClick={stopRecording}>Stop Recording</button>
                    )}
                    <button disabled={recording || !rawLogRef.current} onClick={saveSshLogs}>Save Log</button>
                    <button disabled={!rawLogRef.current || recording} onClick={() => notify("Upload Log will use the selected Session and SXP transfer queue.")}>Upload Log</button>
                    {recording && <span className="recording-indicator">Recording</span>}
                  </div>
                  <form
                    className="terminal-command"
                    onSubmit={(event) => {
                      event.preventDefault();
                      sendSshInput();
                    }}
                  >
                    <input
                      value={sshInput}
                      onChange={(event) => setSshInput(event.target.value)}
                      placeholder={sshConnected ? "Enter a shell command" : "Connect to SSH before entering a command"}
                      disabled={!sshConnected}
                      type={/(password|passphrase|verification code|token)\s*[:?]\s*$/i.test(sshOutput.slice(-180)) ? "password" : "text"}
                      aria-label="SSH shell input"
                    />
                    <button className="confirm" type="submit" disabled={!sshConnected}>Send</button>
                  </form>
                </>
              )}
            </div>
          )}
        </section>
      )}
      {!terminalOpen && (
        <button className="terminal-restore" onClick={() => setTerminalOpen(true)} aria-label="Restore terminal">
          Terminal ⌃
        </button>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
