import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
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

const sxpHelp = `sxp <session-id> upload <source-entry> <destination-entry>
sxp <session-id> mv <source-entry> <destination-entry>

REMOTE (Location displayName) means the API Remote selected by the top LOCATION control.
SXP only accepts entries registered in the selected Session.`;

const parseSxpCommand = (input: string, sessions: ManagedSession[]) => {
  const args = input.trim().split(/\s+/).filter(Boolean);
  if (args[0] !== "sxp") return "Only the embedded sxp command is available here.";
  if (!sessions.length) return "請先設置 Session，建立 Session 後才能使用 sxp。";
  if (args[1] === "help") return sxpHelp;
  if (args.length !== 5 || !["upload", "mv"].includes(args[2])) {
    return `Usage: sxp <session-id> ${args[2] === "mv" ? "mv" : "upload"} <source-entry> <destination-entry>`;
  }
  const session = sessions.find(
    (item) => item.id === args[1] || item.name === args[1],
  );
  if (!session) return `Session not found: ${args[1]}`;
  const source = session.entries.find((entry) => entry.alias === args[3]);
  const destination = session.entries.find((entry) => entry.alias === args[4]);
  if (!source || !destination) {
    return "SXP source and destination must be named entries in the selected Session.";
  }
  return `Parsed ${args[2]}: ${source.alias} -> ${destination.alias}\n` +
    "Transfer execution will be submitted to the shared queue.";
};

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
  const [sxpOpen, setSxpOpen] = useState(false);
  const [sxpInput, setSxpInput] = useState("");
  const [sxpOutput, setSxpOutput] = useState("");
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
    localStorage.setItem(sessionRegistryKey, JSON.stringify(managedSessions));
  }, [managedSessions]);

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
                  setSxpOutput(
                    managedSessions.length
                      ? sxpHelp
                      : "請先設置 Session，建立 Session 後才能使用 sxp。",
                  );
                  setSxpOpen(true);
                }}
              >
                SXP Terminal
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
                <thead>
                  <tr>
                    <th aria-label="Select" />
                    <th>Name</th>
                    <th>Modified</th>
                    <th>Size</th>
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
            <p>
              Sessions store named directory entries only. API tokens, passwords,
              and private keys are never saved here.
            </p>
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
              </label>
              <label>
                LOCAL entry alias
                <input
                  value={localAliasDraft}
                  onChange={(event) => setLocalAliasDraft(event.target.value)}
                  required
                />
              </label>
              <label>
                REMOTE entry alias
                <input
                  value={remoteAliasDraft}
                  onChange={(event) => setRemoteAliasDraft(event.target.value)}
                  required
                />
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
                          : `LOCAL ~/${entry.path}`}
                      </small>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {sxpOpen && (
        <div className="modal-cover" onMouseDown={() => setSxpOpen(false)}>
          <div className="modal sxp-modal" onMouseDown={(event) => event.stopPropagation()}>
            <h2>SXP Terminal</h2>
            <p>Embedded only. This does not install or invoke a system `sxp` command.</p>
            <pre className="sxp-output">{sxpOutput || sxpHelp}</pre>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setSxpOutput(parseSxpCommand(sxpInput, managedSessions));
              }}
            >
              <label>
                Command
                <input
                  value={sxpInput}
                  onChange={(event) => setSxpInput(event.target.value)}
                  placeholder="sxp help"
                  spellCheck={false}
                />
              </label>
              <div className="modal-actions">
                <button type="button" onClick={() => setSxpOpen(false)}>Close</button>
                <button className="confirm" type="submit">Run</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
