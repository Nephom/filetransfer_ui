import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { resolveResource } from "@tauri-apps/api/path";
import {
  formatQueueProgress,
  initialQueueProgress,
  pruneQueueHistory,
  updateQueueProgress as calculateQueueProgress,
  type QueueProgress,
} from "./queue/progress";
import { classifyQueueError, retryDelayMs, type QueueErrorCategory } from "./queue/recovery";
import { assertQueueTransition } from "./queue/state";
import { QueueScheduler } from "./queue/scheduler";
import { QueueStore } from "./queue/store";
// `@xterm/xterm`/`@xterm/addon-fit` (and their CSS) are dynamically
// imported inside the terminal-setup effect below instead of eagerly here:
// they're only ever needed once the user actually opens the SSH terminal
// panel, and eagerly bundling a terminal emulator into the app's critical
// startup path measurably delays first paint for no benefit to everyone who
// never opens a terminal in a given session. Only the *type* is imported
// here, which TypeScript/esbuild erases entirely at build time (no runtime
// cost, so it doesn't defeat the point of the dynamic import below).
import type { Terminal } from "@xterm/xterm";
import "./styles.css";
import "./login.css";
import "./location-control.css";
import "./tls.css";
import "./webui-shell.css";
import "./explorer-parity.css";
import "./desktop-ui.css";
import "./starship-bridge.css";

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
  onlyTerminalMode: boolean;
};
type ShareResponse = {
  data?: {
    fullUrl?: string;
    shareUrl?: string;
    directDownloadUrl?: string;
    directDownloadFullUrl?: string;
  };
};
type ShareLink = {
  shareToken: string;
  fileName: string;
  locationId?: string;
  createdAt?: number;
  expiresAt?: number | null;
  maxDownloads: number;
  downloadCount: number;
  remainingDownloads?: number | null;
  isActive: boolean;
  isExpired?: boolean;
  isExhausted?: boolean;
  shareUrl?: string;
  directDownloadUrl?: string;
};
type NativeApiResponse = { status: number; body: number[] };
type UploadSummary = { files: number; directories: number; totalSize: number; sources: { path: string; size: number; modified: number }[] };
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
type SortKey = ColumnKey | "directory";
type SortDirection = "asc" | "desc";
type SshProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
};
type SshEvent = { sessionId: string; data: string; requestId: string };
type SshTerminalTab = {
  id: string;
  title: string;
  workspaceId: string;
  sshEntryId: string;
  sessionId: string;
  connected: boolean;
  connecting?: boolean;
  output: string;
  recording: boolean;
  recordingStartedAt: number | null;
  rawLog: string;
  plainLog: string;
  commandLog: string;
  savedLogPaths: string[];
};
type TransferQueueItem = {
  id: string;
  label: string;
  kind: "upload" | "download" | "download-set";
  paths: string[];
  destinationPath: string;
  locationId: string;
  locationName: string;
  status: "queued" | "running" | "retrying" | "completed" | "failed" | "cancelled" | "needs_user_action";
  detail: string;
  progress?: QueueProgress;
  errorCategory?: QueueErrorCategory;
  error?: {
    category: QueueErrorCategory;
    message: string;
    itemId: string;
    path?: string;
    attempt: number;
    timestamp: number;
  };
  retryCount?: number;
  finishedAt?: number;
  downloadUrl?: string;
  downloadMethod?: string;
  downloadHeaders?: [string, string][];
  downloadBody?: number[];
  downloadFileName?: string;
  archiveFormat?: "tar.gz" | "zip";
  // HOME-relative LOCAL destination directory (matches `localPath`'s own
  // format), captured when a REMOTE -> LOCAL download is queued so it keeps
  // targeting that folder even if the user navigates the LOCAL pane
  // elsewhere afterwards. Only meaningful for "download"/"download-set"
  // items; upload items keep using `destinationPath` for the REMOTE side.
  localDestinationFolder?: string;
  setFiles?: { relativePath: string; remotePath: string; size: number }[];
  setCompleted?: number;
  sshEntryId?: string;
  sshItems?: FileItem[];
};
type UndoEntry = {
  id: string;
  description: string;
  source: "api" | "ssh" | "local";
  locationId?: string;
  entryId?: string;
  oldPath: string;
  newPath: string;
};
type DesktopSettings = {
  uiDensity: "auto" | "compact" | "standard" | "comfortable";
  undoHistoryEnabled: boolean;
  operationLogEnabled: boolean;
  operationLogLevel: "DEBUG" | "INFO" | "WARN" | "ERROR";
  shareLinkExpirationDays: number;
  // "secure": share.html page link (can be password-protected, matches the
  // web UI's share flow). "direct": a plain, unauthenticated file URL meant
  // for tools that only accept a bare link (e.g. a BMC firmware page) and
  // cannot open a web page or send an Authorization header.
  shareLinkMode: "secure" | "direct";
  confirmations: {
    delete: boolean;
    overwrite: boolean;
    recursive: boolean;
    crossSourceMove: boolean;
  };
};

type ModalDragId =
  | "settings"
  | "sessions"
  | "workspace-name"
  | "ssh-entry"
  | "sxp-entry"
  | "share-links"
  | "queue"
  | "viewer";
type ModalOffset = { x: number; y: number };
type ModalDragSession = {
  onMove: (event: MouseEvent) => void;
  onUp: () => void;
};
type OperationStorageInfo = {
  historyPath: string;
  logPath: string;
  historyBytes: number;
  logBytes: number;
  logFiles: string[];
};

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

const stripAnsi = (value: string) =>
  value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:][\d;]*)*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");

// Prepended to an SSH tab's `output` (the buffer replayed into xterm.js on
// every tab switch/terminal recreation, see the `terminalOpen`/
// `activeSshTabId` effect below) whenever a *new* connection generation is
// about to start writing into it -- i.e. on reconnect, and when a session
// ends. Session output is normally appended across reconnects so the
// terminal keeps showing prior scrollback, but if the previous connection
// was cut off mid-escape-sequence (a truncated OSC/DCS/APC/PM/SOS string --
// e.g. a shell's own OSC 10/11 "what are your colors?" query/response that
// never got its terminator before the socket closed), xterm.js's VT parser
// is left in an unterminated "collecting a control string" state. Replayed
// from a *fresh* Terminal instance, that dangling state swallows every
// following byte -- including the entire next session's output -- as
// literal control-string payload until it happens to hit a stray BEL/ST, at
// which point the swallowed bytes (which look exactly like the reported
// "^[" / "[110;rgb:...]" symptom) get surfaced instead of rendered as text.
// `ESC \` (ST) unconditionally closes any such open string first (OSC also
// accepts BEL, but ST closes all five string-based sequence types and is a
// harmless no-op if nothing was actually open), and a plain SGR reset
// (`ESC [0m`) then clears any bold/color/underline state so it can't bleed
// across the boundary either -- deliberately *not* a full terminal reset
// (`ESC c`), which would also wipe the visible scrollback the user still
// expects to see across a reconnect. This is only ever inserted into
// `output` (xterm's replay buffer) -- never into `rawLog`/`plainLog`, which
// must stay a faithful transcript of only the bytes actually received.
const VT_SESSION_BOUNDARY_GUARD = "\u001b\\\u001b[0m";

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
  menuPlacement = "down",
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  menuPlacement?: "down" | "up";
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
        <div className={`location-menu palette-select-menu ${menuPlacement === "up" ? "menu-up" : ""}`} role="listbox" aria-label={label}>
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
// "Only Terminal" lets a developer reach the Local Explorer + SSH Terminal
// without signing in or running the API server at all. It's available
// automatically in `npm run dev` / `npm run tauri dev` builds; production
// builds only expose it if VITE_ENABLE_ONLY_TERMINAL_MODE=true is baked in.
const onlyTerminalAvailable =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_ONLY_TERMINAL_MODE === "true";
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
  onlyTerminalMode: false,
};
const sessionRegistryKey = "fileapi-session-registry";
const desktopSettingsKey = "nfterm-settings";
const defaultDesktopSettings: DesktopSettings = {
  uiDensity: "auto",
  undoHistoryEnabled: true,
  operationLogEnabled: true,
  operationLogLevel: "DEBUG",
  // 0 = server default (currently 1 day); the server also enforces its own
  // configured maximum (shareLinks.maxExpiration), so values here that
  // exceed it are rejected server-side with a clear error.
  shareLinkExpirationDays: 0,
  // Defaults to the safer, page-based link (matches the web UI's default
  // behaviour). Users who need a bare URL for BMC/tooling must opt in.
  shareLinkMode: "secure",
  confirmations: { delete: true, overwrite: true, recursive: true, crossSourceMove: true },
};

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
// A LOCAL path is "absolute" once a privileged (root/Administrator) session
// has broken out of the HOME jail: a real filesystem path (Unix "/...", or
// a Windows drive like "C:/..."), as opposed to the normal HOME-relative
// path strings ("", "Documents/foo") the Rust side otherwise always uses.
const isAbsoluteLocalPath = (path: string) => path.startsWith("/") || /^[A-Za-z]:/.test(path);
// Breadcrumb segments for the LOCAL path bar. Handles both HOME-relative
// paths (the normal case) and real absolute paths (elevated-only), the
// latter needing its own logic since naively splitting on "/" loses the
// leading "/" (Unix) or the drive letter (Windows).
const localBreadcrumbSegments = (path: string): { label: string; target: string }[] => {
  if (!isAbsoluteLocalPath(path)) {
    const parts = path.split("/").filter(Boolean);
    return parts.map((part, index) => ({ label: part, target: parts.slice(0, index + 1).join("/") }));
  }
  if (path.startsWith("/")) {
    const parts = path.split("/").filter(Boolean);
    const segments = [{ label: "/", target: "/" }];
    parts.forEach((part, index) => {
      segments.push({ label: part, target: `/${parts.slice(0, index + 1).join("/")}` });
    });
    return segments;
  }
  const parts = path.split("/").filter(Boolean);
  const drive = parts[0] || "";
  const rest = parts.slice(1);
  const segments = [{ label: `${drive}/`, target: `${drive}/` }];
  rest.forEach((part, index) => {
    segments.push({ label: part, target: `${drive}/${rest.slice(0, index + 1).join("/")}` });
  });
  return segments;
};
const sshParentPath = (path: string) => {
  const segments = path.split("/").filter(Boolean);
  return segments.length > 1 ? `/${segments.slice(0, -1).join("/")}` : "/";
};
const joinSshPath = (directory: string, name: string) =>
  directory === "/" ? `/${name}` : `${directory.replace(/\/+$/, "")}/${name}`;
const downloadPath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");
const formatSize = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 ** 2
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 ** 2).toFixed(1)} MB`;
const fileTimestamp = (value: number | string | undefined) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};
const compareFileNames = (left: string, right: string) =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
const compareFileItems = (
  left: FileItem,
  right: FileItem,
  sortKey: SortKey,
  direction: SortDirection,
) => {
  if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
  let result = sortKey === "modified"
    ? fileTimestamp(left.modified) - fileTimestamp(right.modified)
    : sortKey === "size"
      ? left.size - right.size
      : compareFileNames(left.name, right.name);
  if (result === 0) {
    result = compareFileNames(left.name, right.name) || left.path.localeCompare(right.path);
  }
  return direction === "desc" ? -result : result;
};
const sortFileItems = (items: FileItem[], sortKey: SortKey, direction: SortDirection) =>
  [...items].sort((left, right) => compareFileItems(left, right, sortKey, direction));
const sanitizeArchiveName = (value: string) => {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim();
  return cleaned || "nFterm";
};
const localArchiveTimestamp = (date = new Date()) => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}_${pad(date.getMinutes())}_${pad(date.getSeconds())}`;
};
const sessionArchiveName = (sessionName: string) =>
  `${sanitizeArchiveName(sessionName)}_${localArchiveTimestamp()}`;

type SortControlsProps = {
  label: string;
  sortKey: SortKey;
  direction: SortDirection;
  onSortKeyChange: (value: SortKey) => void;
  onDirectionChange: () => void;
};
const SortControls = ({ label, sortKey, direction, onSortKeyChange, onDirectionChange }: SortControlsProps) => (
  <label className="sort-control">
    {label}
    <select value={sortKey} onChange={(event) => onSortKeyChange(event.target.value as SortKey)} aria-label={`${label} field`}>
      <option value="name">Name</option>
      <option value="modified">Modified</option>
      <option value="size">Size</option>
      <option value="directory">Directory first</option>
    </select>
    <button type="button" onClick={onDirectionChange} aria-label={`${label} ${direction === "asc" ? "descending" : "ascending"}`}>
      {direction === "asc" ? "Ascending" : "Descending"}
    </button>
  </label>
);
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
  // The LOCAL folder-tree "forest": the first entry is always the HOME
  // shortcut (path ""), matching the pane's own default view. When the app
  // is running elevated (`isLocalElevated`), one extra top-level entry is
  // appended per real filesystem root reported by `list_local_roots`
  // (drive letters on Windows, "/" everywhere else) so a privileged user
  // can actually reach the real root instead of being stuck inside HOME.
  // Non-elevated users only ever see the HOME entry -- the jail enforced by
  // the Rust side (`resolve_local_transfer_path`) is the real boundary;
  // this is just keeping the tree's shape consistent with it.
  const [localTrees, setLocalTrees] = useState<FolderNode[]>([
    { path: "", name: "~", expanded: true, loaded: false, children: [] },
  ]);
  const [isLocalElevated, setIsLocalElevated] = useState(false);
  const [localRoots, setLocalRoots] = useState<string[]>([]);
  const [localHomeAbsolute, setLocalHomeAbsolute] = useState("");
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationsLoading, setLocationsLoading] = useState(false);
  const [path, setPath] = useState("");
  const [remoteSshEntryId, setRemoteSshEntryId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const selectionAnchorRef = useRef<string | null>(null);
  const localSelectionAnchorRef = useRef<string | null>(null);
  const [notice, setNotice] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [shareLinksOpen, setShareLinksOpen] = useState(false);
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [shareLinksLoading, setShareLinksLoading] = useState(false);
  const [sharePasswordOpen, setSharePasswordOpen] = useState(false);
  const [sharePasswordDraft, setSharePasswordDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [locationMenuOpen, setLocationMenuOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveLogNameOpen, setSaveLogNameOpen] = useState(false);
  const [saveLogNameDraft, setSaveLogNameDraft] = useState("");
  const [saveLogDestinationPath, setSaveLogDestinationPath] = useState("");
  const [desktopSettings, setDesktopSettings] = useState<DesktopSettings>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(desktopSettingsKey) || "null");
      const uiDensity = ["auto", "compact", "standard", "comfortable"].includes(saved?.uiDensity)
        ? saved.uiDensity
        : defaultDesktopSettings.uiDensity;
      const operationLogLevel = ["DEBUG", "INFO", "WARN", "ERROR"].includes(saved?.operationLogLevel)
        ? saved.operationLogLevel
        : defaultDesktopSettings.operationLogLevel;
      const shareLinkExpirationDays =
        Number.isFinite(saved?.shareLinkExpirationDays) && saved.shareLinkExpirationDays >= 0
          ? saved.shareLinkExpirationDays
          : defaultDesktopSettings.shareLinkExpirationDays;
      const shareLinkMode = ["secure", "direct"].includes(saved?.shareLinkMode)
        ? saved.shareLinkMode
        : defaultDesktopSettings.shareLinkMode;
      return {
        ...defaultDesktopSettings,
        ...saved,
        uiDensity,
        operationLogLevel,
        shareLinkExpirationDays,
        shareLinkMode,
        confirmations: { ...defaultDesktopSettings.confirmations, ...(saved?.confirmations || {}) },
      };
    } catch {
      return defaultDesktopSettings;
    }
  });
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const [storageInfo, setStorageInfo] = useState<OperationStorageInfo | null>(null);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [pathBeforeSearch, setPathBeforeSearch] = useState("");
  const [viewMode, setViewMode] = useState<"details" | "grid">(() =>
    localStorage.getItem("file-view-mode") === "grid" ? "grid" : "details",
  );
  const [localViewMode, setLocalViewMode] = useState<"details" | "grid">(() =>
    localStorage.getItem("local-file-view-mode") === "grid" ? "grid" : "details",
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
  const [workspaceNameDialogOpen, setWorkspaceNameDialogOpen] = useState(false);
  const [sessionFormError, setSessionFormError] = useState("");
  const [lastSavedSessionId, setLastSavedSessionId] = useState("");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [sshTabs, setSshTabs] = useState<SshTerminalTab[]>([]);
  const [activeSshTabId, setActiveSshTabId] = useState("");
  const [sshQuickListOpen, setSshQuickListOpen] = useState(true);
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const previousTerminalHeightRef = useRef(260);
  const [terminalHeight, setTerminalHeight] = useState(() =>
    Number(localStorage.getItem("fileapi-terminal-height")) || 260,
  );
  const [localPaneWidth, setLocalPaneWidth] = useState(() =>
    Number(localStorage.getItem("fileapi-local-pane-width")) || 380,
  );
  const [localTreeWidth, setLocalTreeWidth] = useState(() =>
    Number(localStorage.getItem("fileapi-local-tree-width")) || 130,
  );
  // The LOCAL mini folder-tree is collapsed by default: showing it and the
  // file list side by side is a second split *within* the already-split
  // LOCAL pane, which crowded the screen. A small toggle (mirroring the
  // Terminal panel's show/hide button) lets it be opened on demand.
  const [localTreeOpen, setLocalTreeOpen] = useState(false);
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
  const [remoteSortKey, setRemoteSortKey] = useState<SortKey>("name");
  const [remoteSortDirection, setRemoteSortDirection] = useState<SortDirection>("asc");
  const [localSortKey, setLocalSortKey] = useState<SortKey>("name");
  const [localSortDirection, setLocalSortDirection] = useState<SortDirection>("asc");
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
  const [selectedSshEntryId, setSelectedSshEntryId] = useState("");
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
  const [sshPasswordSaved, setSshPasswordSaved] = useState(false);
  const [sshEntryDraftId, setSshEntryDraftId] = useState("");
  const [recording, setRecording] = useState(false);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [savedLogPaths, setSavedLogPaths] = useState<string[]>([]);
  const [uploadSessionId, setUploadSessionId] = useState("");
  const [transferQueue, setTransferQueue] = useState<TransferQueueItem[]>([]);
  const queueStoreRef = useRef(new QueueStore<TransferQueueItem>((items) => pruneQueueHistory(items, Date.now())));
  useEffect(() => {
    queueStoreRef.current.replace(transferQueue);
  }, [transferQueue]);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [archiveFormatOpen, setArchiveFormatOpen] = useState(false);
  const [archiveFormatDraft, setArchiveFormatDraft] = useState<"tar.gz" | "zip" | "queue">("tar.gz");
  const [uploadDestinationOpen, setUploadDestinationOpen] = useState(false);
  const [uploadDestinationPath, setUploadDestinationPath] = useState("");
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerTitle, setViewerTitle] = useState("");
  const [viewerContent, setViewerContent] = useState("");
  const [viewerLocalPath, setViewerLocalPath] = useState("");
  const [viewerRemotePath, setViewerRemotePath] = useState("");
  const rawLogRef = useRef("");
  const plainLogRef = useRef("");
  const commandLogRef = useRef("");
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const sshSessionIdRef = useRef("");
  const sshConnectingRef = useRef(false);
  const recordingRef = useRef(false);
  const sshSecretPromptRef = useRef(false);
  const activeSshTabIdRef = useRef("");
  // Maps a connection attempt's `requestId` (see `performSshConnect`) to the
  // tab id that initiated it. The Rust side starts streaming `ssh-output`
  // for a new session before the `ssh_connect` invoke() call resolves in
  // this frontend, so `requestId` -- echoed back on every event -- is the
  // only reliable way to bind that early output to the right tab. A tab is
  // looked up primarily by `sessionId` (set once `ssh_connect` resolves);
  // this map only matters for the brief window before that.
  const pendingSshConnectRequestsRef = useRef<Record<string, string>>({});
  const connectAttemptRef = useRef<Record<string, string>>({});
  const sshTabsRef = useRef<SshTerminalTab[]>([]);
  const shellInputRef = useRef("");
  const dragPreparationRef = useRef(new Map<string, Promise<string>>());
  const queueProgressSamplesRef = useRef(new Map<string, { bytes: number; at: number }[]>());
  const queueCompletionHandlersRef = useRef(new Map<string, (destination: string) => Promise<void>>());
  const dragExpandTimerRef = useRef<number | undefined>(undefined);
  const dragScrollIntervalRef = useRef<number | null>(null);
  const dragIconPathRef = useRef<Promise<string> | null>(null);
  const [sessionNameDraft, setSessionNameDraft] = useState("");
  const [localAliasDraft, setLocalAliasDraft] = useState("LocalHome");
  const [remoteAliasDraft, setRemoteAliasDraft] = useState("RemoteRoot");
  const [sxpEntryDraftId, setSxpEntryDraftId] = useState("");
  const [sxpEntryNameDraft, setSxpEntryNameDraft] = useState("Default Transfer");
  // Session Manager only shows the Workspace list/summary; adding or
  // editing an SSH entry or a Session Path entry happens in its own
  // floating dialog on top of the Sessions modal.
  const [sshEntryDialogOpen, setSshEntryDialogOpen] = useState(false);
  const [sxpEntryDialogOpen, setSxpEntryDialogOpen] = useState(false);
  const [pendingRemotePath, setPendingRemotePath] = useState<string | null>(null);
  const [folderTree, setFolderTree] = useState<FolderNode>({
    path: "",
    name: "/",
    expanded: true,
    loaded: false,
    children: [],
  });
  const [dragItems, setDragItems] = useState<FileItem[]>([]);
  const [dragSource, setDragSource] = useState<"local" | "remote" | "">("");
  // Which pane the toolbar (New folder/Rename/Delete/View/Select all) acts
  // on when Split mode shows both LOCAL and REMOTE at once. Without this,
  // the toolbar always silently acted on REMOTE even while the user was
  // clicking around in LOCAL, with no indication of where an action would
  // actually apply.
  const [activePane, setActivePane] = useState<"local" | "remote">("remote");
  // `null` means "no active drop target". This must be distinct from `""`,
  // which is a legitimate real path (HOME for LOCAL, and the API-remote
  // storage root) -- using `""` as the sentinel made the HOME/root tree row
  // look permanently "drop-target"-styled any time `dropTarget` was reset,
  // since `dropTarget === node.path` (`"" === ""`) was true even with no
  // drag in progress.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Which pane the cursor is *actually* hovering over during a cross-pane
  // drag. `dragSource` alone only tells us a drag started somewhere -- it
  // does not track where the pointer currently is, so pane-wide "you can
  // drop here" highlighting must not be derived from `dragSource` alone or
  // the opposite pane lights up the instant the drag starts, before the
  // cursor has moved there. See onDragEnter/onDragLeave on each pane body.
  const [paneDragHover, setPaneDragHover] = useState<"local" | "remote" | "">("");
  // Rubber-band/marquee mouse-drag multi-select. `marqueeRect` (viewport/
  // client coordinates, so no CSS containing-block dependency) drives the
  // visible selection-box overlay; `marqueeStateRef` carries the drag's
  // starting point, which pane it belongs to, whether it's additive
  // (Ctrl/Cmd held at drag-start), and the selection to union with.
  const [marqueeRect, setMarqueeRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const marqueeStateRef = useRef<{
    pane: "local" | "remote";
    startX: number;
    startY: number;
    additive: boolean;
    baseSelection: string[];
    container: HTMLElement;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const accountControl = useRef<HTMLDivElement>(null);
  const locationControl = useRef<HTMLDivElement>(null);
  const folderTreeRef = useRef<HTMLDivElement>(null);
  const localFolderTreeRef = useRef<HTMLDivElement>(null);
  const fileAreaRef = useRef<HTMLDivElement>(null);
  const localFileListRef = useRef<HTMLDivElement>(null);
  const dragItemsRef = useRef<FileItem[]>([]);
  const dragSourceRef = useRef<"local" | "remote" | "">("");
  const noticeTimer = useRef<number | undefined>();
  const locationsLoaded = useRef(false);
  const locationRefreshInProgress = useRef(false);
  const terminalResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const paneResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const localTreeResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const columnResizeRef = useRef<{
    key: ColumnKey;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [modalOffsets, setModalOffsets] = useState<Partial<Record<ModalDragId, ModalOffset>>>({});
  const modalDragRef = useRef<ModalDragSession | null>(null);

  const stopModalDrag = () => {
    const active = modalDragRef.current;
    if (!active) return;
    window.removeEventListener("mousemove", active.onMove);
    window.removeEventListener("mouseup", active.onUp);
    modalDragRef.current = null;
  };

  const beginModalDrag = (id: ModalDragId) => (event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, input, select, textarea, a")) return;

    const modal = event.currentTarget.closest<HTMLElement>(".modal");
    if (!modal) return;
    event.preventDefault();
    event.stopPropagation();
    stopModalDrag();

    const rect = modal.getBoundingClientRect();
    const handleHeight = event.currentTarget.getBoundingClientRect().height;
    const startingOffset = modalOffsets[id] || { x: 0, y: 0 };
    const minVisibleWidth = Math.min(160, rect.width);
    const minLeft = -rect.width + minVisibleWidth;
    const maxLeft = window.innerWidth - minVisibleWidth;
    const minTop = 8;
    const maxTop = Math.max(minTop, window.innerHeight - handleHeight - 8);
    let dragStarted = false;

    const onMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - event.clientX;
      const deltaY = moveEvent.clientY - event.clientY;
      if (!dragStarted && Math.hypot(deltaX, deltaY) < 5) return;
      dragStarted = true;
      const nextLeft = Math.max(minLeft, Math.min(maxLeft, rect.left + moveEvent.clientX - event.clientX));
      const nextTop = Math.max(minTop, Math.min(maxTop, rect.top + moveEvent.clientY - event.clientY));
      setModalOffsets((current) => ({
        ...current,
        [id]: {
          x: startingOffset.x + nextLeft - rect.left,
          y: startingOffset.y + nextTop - rect.top,
        },
      }));
    };
    const onUp = () => stopModalDrag();
    modalDragRef.current = { onMove, onUp };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const modalStyle = (id: ModalDragId): React.CSSProperties => {
    const offset = modalOffsets[id];
    return offset ? { left: `${offset.x}px`, top: `${offset.y}px` } : {};
  };

  useEffect(() => () => stopModalDrag(), []);

  useEffect(() => {
    const openIds: Partial<Record<ModalDragId, boolean>> = {
      settings: settingsOpen,
      sessions: sessionsOpen,
      "workspace-name": workspaceNameDialogOpen,
      "ssh-entry": sshEntryDialogOpen,
      "sxp-entry": sxpEntryDialogOpen,
      "share-links": shareLinksOpen,
      queue: queueOpen,
      viewer: viewerOpen,
    };
    setModalOffsets((current) => {
      const next = { ...current };
      let changed = false;
      (Object.keys(next) as ModalDragId[]).forEach((id) => {
        if (!openIds[id]) {
          delete next[id];
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [queueOpen, sessionsOpen, settingsOpen, shareLinksOpen, sshEntryDialogOpen, sxpEntryDialogOpen, viewerOpen, workspaceNameDialogOpen]);

  useEffect(() => {
    const closeTopmostOverlay = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;

      if (sshEntryDialogOpen) {
        setSshEntryDialogOpen(false);
      } else if (sxpEntryDialogOpen) {
        setSxpEntryDialogOpen(false);
      } else if (workspaceNameDialogOpen) {
        setWorkspaceNameDialogOpen(false);
      } else if (sharePasswordOpen) {
        setSharePasswordOpen(false);
      } else if (changePasswordOpen) {
        setChangePasswordOpen(false);
      } else if (saveLogNameOpen) {
        setSaveLogNameOpen(false);
      } else if (shareLinksOpen) {
        setShareLinksOpen(false);
      } else if (sessionsOpen) {
        setSessionsOpen(false);
      } else if (settingsOpen) {
        setSettingsOpen(false);
      } else if (archiveFormatOpen) {
        setArchiveFormatOpen(false);
      } else if (uploadDestinationOpen) {
        setUploadDestinationOpen(false);
      } else if (queueOpen) {
        setQueueOpen(false);
      } else if (viewerOpen) {
        setViewerOpen(false);
      } else if (contextMenu) {
        setContextMenu(null);
      } else if (locationMenuOpen) {
        setLocationMenuOpen(false);
      } else if (accountOpen) {
        setAccountOpen(false);
      } else {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", closeTopmostOverlay);
    return () => window.removeEventListener("keydown", closeTopmostOverlay);
  }, [
    accountOpen,
    archiveFormatOpen,
    changePasswordOpen,
    contextMenu,
    locationMenuOpen,
    queueOpen,
    saveLogNameOpen,
    sessionsOpen,
    settingsOpen,
    shareLinksOpen,
    sharePasswordOpen,
    sshEntryDialogOpen,
    sxpEntryDialogOpen,
    uploadDestinationOpen,
    viewerOpen,
    workspaceNameDialogOpen,
  ]);

  useEffect(() => {
    sshTabsRef.current = sshTabs;
  }, [sshTabs]);

  useEffect(() => {
    return () => {
      for (const tab of sshTabsRef.current) {
        if (tab.sessionId) void invoke("ssh_disconnect", { sessionId: tab.sessionId });
      }
    };
  }, []);

  useEffect(() => {
    sshSessionIdRef.current = sshSessionId;
  }, [sshSessionId]);

  useEffect(() => {
    activeSshTabIdRef.current = activeSshTabId;
    const tab = sshTabs.find((item) => item.id === activeSshTabId);
    setSshConnected(Boolean(tab?.connected));
    setSshSessionId(tab?.sessionId || "");
    setSshOutput(tab?.output || "");
    setRecording(Boolean(tab?.recording));
    setRecordingStartedAt(tab?.recordingStartedAt || null);
    setSavedLogPaths(tab?.savedLogPaths || []);
    sshSessionIdRef.current = tab?.sessionId || "";
    sshOutputRef.current = tab?.output || "";
  }, [activeSshTabId, sshTabs]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("nfterm-session");
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
    localStorage.setItem("nfterm-session", JSON.stringify(session));
  }, [session]);

  useEffect(() => {
    localStorage.setItem("file-view-mode", viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem("local-file-view-mode", localViewMode);
  }, [localViewMode]);

  useEffect(() => {
    localStorage.setItem("file-layout-mode", splitMode ? "split" : "single");
  }, [splitMode]);

  useEffect(() => {
    localStorage.setItem("fileapi-terminal-height", String(terminalHeight));
  }, [terminalHeight]);

  useEffect(() => {
    localStorage.setItem("fileapi-local-pane-width", String(localPaneWidth));
  }, [localPaneWidth]);

  useEffect(() => {
    localStorage.setItem("fileapi-local-tree-width", String(localTreeWidth));
  }, [localTreeWidth]);

  useEffect(() => {
    localStorage.setItem("fileapi-column-widths", JSON.stringify(columnWidths));
  }, [columnWidths]);

  useEffect(() => {
    if (!splitMode) return;
    if (!localPath) {
      void run(async () => {
        await loadLocalFiles("");
      });
      return;
    }
    const refreshTimer = window.setInterval(() => {
      void refreshLocalFiles().catch((error) => {
        setNotice(error instanceof Error ? error.message : String(error));
      });
    }, 2000);
    return () => window.clearInterval(refreshTimer);
  }, [splitMode, localPath]);

  useEffect(() => {
    localStorage.setItem(sessionRegistryKey, JSON.stringify(managedSessions));
  }, [managedSessions]);

  useEffect(() => {
    localStorage.setItem("fileapi-ssh-profiles", JSON.stringify(sshProfiles));
  }, [sshProfiles]);

  useEffect(() => {
    localStorage.setItem(desktopSettingsKey, JSON.stringify(desktopSettings));
    // Mirror the enabled/level setting into the Rust process so
    // Rust-originated log calls (SSH auth attempts, connect/disconnect,
    // create/rename, drag staging, etc.) respect the same configuration the
    // user set here instead of only ever using the process's startup
    // defaults.
    void invoke("set_operation_log_config", {
      enabled: desktopSettings.operationLogEnabled,
      level: desktopSettings.operationLogLevel,
    }).catch(() => {});
  }, [desktopSettings]);

  useEffect(() => {
    if (!desktopSettings.operationLogEnabled) return undefined;
    void invoke("initialize_operation_log").then(() => invoke("append_operation_log", {
      level: desktopSettings.operationLogLevel,
      operation: "app",
      status: "started",
      sourceLabel: "Desktop",
      destinationLabel: "",
      detail: "nFterm started.",
    })).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    return () => {
      void invoke("append_operation_log", {
        level: desktopSettings.operationLogLevel,
        operation: "app",
        status: "stopped",
        sourceLabel: "Desktop",
        destinationLabel: "",
        detail: "nFterm stopped.",
      });
    };
  }, []);

  useEffect(() => {
    const updateViewport = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useEffect(() => {
    const maxHeight = Math.max(160, viewport.height - 180);
    setTerminalHeight((current) => Math.min(current, maxHeight));
  }, [viewport.height]);

  useEffect(() => {
    if (managedSessions.length || !sshProfiles.length) return;
    const makeId = () => typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const migrated = sshProfiles.map((profile) => ({
      id: makeId(),
      name: profile.name,
      sxpEntries: [{ id: makeId(), name: "Default Transfer", localAlias: "Home", localPath: "", remoteAlias: "Personal", remotePath: "", locationId: session.locationId, locationName: session.locationId }],
      sshEntries: [profile],
    }));
    setManagedSessions(migrated);
    setWorkspaceSessionId(migrated[0]?.id || "");
  }, [managedSessions.length, sshProfiles]);

  useEffect(() => {
    let disposed = false;
    // Resolve which tab an `ssh-output`/`ssh-exit` event belongs to.
    // `sessionId` is authoritative once known; `requestId` (set by
    // `performSshConnect` before `ssh_connect` is invoked) is the only way
    // to bind an event to a tab *before* that -- output can start streaming
    // from the backend before the invoke() promise resolves with the real
    // session id, and with several tabs connecting close together, event
    // arrival order is not guaranteed to match invocation order.
    const resolveTab = (payload: SshEvent) => {
      const bySession = sshTabsRef.current.find((item) => item.sessionId === payload.sessionId);
      if (bySession) return bySession;
      const pendingTabId = pendingSshConnectRequestsRef.current[payload.requestId];
      return pendingTabId ? sshTabsRef.current.find((item) => item.id === pendingTabId) : undefined;
    };
    const unlistenOutput = listen<SshEvent>("ssh-output", (event) => {
      if (disposed) return;
      const tab = resolveTab(event.payload);
      if (!tab) return;
      if (tab.sessionId !== event.payload.sessionId) {
        setSshTabs((current) => current.map((item) => item.id === tab.id ? { ...item, sessionId: event.payload.sessionId, connected: true } : item));
      }
      const data = event.payload.data;
      setSshTabs((current) => current.map((item) => {
        if (item.id !== tab.id) return item;
        const output = item.output + data;
        return {
          ...item,
          output,
          rawLog: item.recording ? item.rawLog + data : item.rawLog,
          plainLog: item.recording ? item.plainLog + stripAnsi(data) : item.plainLog,
        };
      }));
      if (tab.id === activeSshTabIdRef.current) {
        sshOutputRef.current += data;
        terminalInstanceRef.current?.write(data);
        const promptText = stripAnsi(sshOutputRef.current.slice(-240)).replace(/\r/g, "").trimEnd();
        sshSecretPromptRef.current = /(password|passphrase|verification code|token)[^\n:]*[:?]\s*$/i.test(promptText);
      }
    });
    const unlistenExit = listen<SshEvent>("ssh-exit", (event) => {
      if (disposed) return;
      const tab = resolveTab(event.payload);
      if (!tab) return;
      setSshTabs((current) => current.map((item) => item.id !== tab.id ? item : {
        ...item,
        connected: false,
        sessionId: "",
        output: `${item.output}${VT_SESSION_BOUNDARY_GUARD}\n${event.payload.data}\n`,
      }));
      if (tab.id === activeSshTabIdRef.current) {
        setSshConnected(false);
        sshConnectingRef.current = false;
      }
    });
    return () => {
      disposed = true;
      void unlistenOutput.then((dispose) => dispose());
      void unlistenExit.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    if (!terminalOpen || !terminalHostRef.current) return undefined;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/xterm/css/xterm.css"),
    ]).then(([{ Terminal }, { FitAddon }]) => {
      // The effect (or the whole terminal panel) may have already been
      // torn down by the time this dynamic import resolves.
      if (disposed || !terminalHostRef.current) return;
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
      terminal.write(sshTabsRef.current.find((item) => item.id === activeSshTabId)?.output || "Select a saved SSH session or open the Session manager to add one.\r\n");
      const resizeSshPty = () => {
        const tab = sshTabsRef.current.find((item) => item.id === activeSshTabId);
        if (!tab?.sessionId) return;
        void invoke("ssh_resize", { sessionId: tab.sessionId, cols: terminal.cols, rows: terminal.rows });
      };
      const resizeObserver = new ResizeObserver(() => {
        fit.fit();
        resizeSshPty();
      });
      resizeObserver.observe(terminalHostRef.current);
      resizeSshPty();
      const inputListener = terminal.onData((data: string) => {
        const tab = sshTabsRef.current.find((item) => item.id === activeSshTabId);
        if (!tab?.sessionId) return;
        void invoke("ssh_write", { sessionId: tab.sessionId, data });
        if (recordingRef.current && !sshSecretPromptRef.current) {
          if (data === "\r" || data === "\n") {
            if (shellInputRef.current.trim()) {
              const command = `[${new Date().toISOString()}] ${shellInputRef.current}\n`;
              commandLogRef.current += command;
              setSshTabs((current) => current.map((item) => item.id === tab.id ? { ...item, commandLog: item.commandLog + command } : item));
            }
            shellInputRef.current = "";
          } else if (data === "\u007f") {
            shellInputRef.current = shellInputRef.current.slice(0, -1);
          } else if (!data.startsWith("\u001b")) {
            shellInputRef.current += data;
          }
        }
      });
      cleanup = () => {
        inputListener.dispose();
        resizeObserver.disconnect();
        terminal.dispose();
        terminalInstanceRef.current = null;
      };
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [terminalOpen, activeSshTabId, sshTabs.find((item) => item.id === activeSshTabId)?.sessionId]);

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

  const apiForLocation = async (endpoint: string, locationId: string) => {
    const headers: [string, string][] = [
      ...(session.token ? [["Authorization", `Bearer ${session.token}`] as [string, string]] : []),
      ["X-Location-ID", locationId],
    ];
    const response = await invoke<NativeApiResponse>("api_request", {
      url: `${serverUrl(session)}${endpoint}`,
      method: "GET",
      headers,
      body: null,
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

  const findSshProfileById = (entryId: string): SshProfile | undefined =>
    managedSessions.flatMap((workspace) => workspace.sshEntries).find((entry) => entry.id === entryId);

  const ensureApiRemote = () => {
    if (remoteSshEntryId) {
      throw new Error("This action is not available while browsing an SSH remote. Switch LOCATION back to an API Remote first.");
    }
  };

  const connectedSshBrowseOptions = () =>
    managedSessions
      .flatMap((workspace) => workspace.sshEntries)
      .filter((entry) => sshTabs.some((tab) => tab.sshEntryId === entry.id && tab.connected));

  const loadFiles = async (nextPath = path, sshEntryOverride: string | null = null) => {
    const sshEntryId = sshEntryOverride !== null ? sshEntryOverride : remoteSshEntryId;
    if (sshEntryId) {
      const profile = findSshProfileById(sshEntryId);
      if (!profile) {
        setRemoteSshEntryId("");
        throw new Error("The SSH connection for this remote view is no longer available.");
      }
      const data = await invoke<LocalDirectory>("ssh_list_directory", { profile, path: nextPath });
      setFiles(data.files || []);
      setPath(data.path || "");
      setSearching(false);
      selectionAnchorRef.current = null;
      setSelected([]);
      return;
    }
    const response = await api(
      `/api/files?path=${encodeURIComponent(nextPath)}&sort=${remoteSortKey}&order=${remoteSortDirection}`,
    );
    if (!response.ok) throw new Error(await readError(response));
    const data = await response.json();
    setFiles(data.files || []);
    setPath(data.currentPath || "");
    setSearching(false);
    selectionAnchorRef.current = null;
    setSelected([]);
  };

  // Where "up" from `path` should go for the LOCAL pane. Non-elevated
  // sessions never leave the HOME jail (existing `parentPath` behaviour).
  // Elevated sessions can walk all the way up to the real filesystem root
  // (or drive root on Windows) -- including up out of HOME itself, via
  // `localHomeAbsolute` (HOME's own real absolute path, fetched once at
  // startup) once `path` is the empty HOME shortcut.
  const localParentPath = (path: string): string => {
    const absolute = path === "" ? localHomeAbsolute : path;
    if (!isLocalElevated || !absolute || !isAbsoluteLocalPath(absolute)) return parentPath(path);
    if (absolute === "/") return "/";
    const segments = absolute.split("/").filter(Boolean);
    if (/^[A-Za-z]:$/.test(segments[0] || "")) {
      return segments.length > 1 ? `${segments[0]}/${segments.slice(1, -1).join("/")}` : `${segments[0]}/`;
    }
    return segments.length > 1 ? `/${segments.slice(0, -1).join("/")}` : "/";
  };
  const showLocalUp = (): boolean => {
    if (!isLocalElevated) return Boolean(localPath);
    if (!localPath) return Boolean(localHomeAbsolute);
    if (localPath === "/") return false;
    const segments = localPath.split("/").filter(Boolean);
    if (/^[A-Za-z]:$/.test(segments[0] || "") && segments.length <= 1) return false;
    return true;
  };

  const loadLocalFiles = async (nextPath = localPath) => {
    try {
      const data = await invoke<LocalDirectory>("local_list_directory", {
        path: nextPath,
      });
      setLocalFiles(data.files || []);
      setLocalPath(data.path || "");
      setLocalSelected([]);
    } catch (error) {
      writeOperationLog("browse", "failed", `LOCAL: ~/${localPath || ""}`, `LOCAL: ~/${nextPath || ""}`, `Failed to list LOCAL directory: ${describeError(error)}`, "ERROR");
      throw error;
    }
  };

  const refreshLocalFiles = async () => {
    try {
      const data = await invoke<LocalDirectory>("local_list_directory", {
        path: localPath,
      });
      setLocalFiles(data.files || []);
      setLocalPath(data.path || "");
      setLocalSelected((current) => current.filter((item) =>
        (data.files || []).some((file) => file.path === item),
      ));
    } catch (error) {
      writeOperationLog("browse", "failed", `LOCAL: ~/${localPath || ""}`, `LOCAL: ~/${localPath || ""}`, `Failed to refresh LOCAL directory: ${describeError(error)}`, "ERROR");
      throw error;
    }
  };

  const loadLocalTreeChildren = async (treePath: string, force = false) => {
    try {
      const data = await invoke<LocalDirectory>("local_list_directory", { path: treePath });
      const children = (data.files || [])
        .filter((file) => file.isDirectory)
        .map((file) => ({ path: file.path, name: file.name, expanded: false, loaded: false, children: [] }))
        .sort((left, right) => compareFileNames(left.name, right.name));
      setLocalTrees((trees) =>
        trees.map((tree) => updateTreeNode(tree, treePath, (node) => ({ ...node, expanded: true, loaded: true, children }))),
      );
    } catch (error) {
      // `force` is used for background/prefetch expansion where a failure
      // (e.g. a permission-denied subfolder) is tolerated and the tree node
      // is just left collapsed - but it must still be logged, not silently
      // dropped, so ERROR-level browse failures always show up somewhere.
      writeOperationLog("browse", "failed", "LOCAL folder tree", `LOCAL: ~/${treePath || ""}`, `Failed to expand LOCAL folder tree node: ${describeError(error)}`, "ERROR");
      if (!force) throw error instanceof Error ? error : new Error(String(error));
    }
  };


  const toggleLocalFolder = (node: FolderNode) => {
    if (!node.expanded && !node.loaded) {
      void run(() => loadLocalTreeChildren(node.path));
      return;
    }
    setLocalTrees((trees) =>
      trees.map((tree) => updateTreeNode(tree, node.path, (item) => ({ ...item, expanded: !item.expanded }))),
    );
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

  const loadTreeChildren = async (treePath: string, force = false, sshEntryOverride: string | null = null) => {
    const sshEntryId = sshEntryOverride !== null ? sshEntryOverride : remoteSshEntryId;
    let childFiles: FileItem[];
    if (sshEntryId) {
      const profile = findSshProfileById(sshEntryId);
      if (!profile) {
        if (!force) throw new Error("The SSH connection for this remote view is no longer available.");
        return;
      }
      try {
        const data = await invoke<LocalDirectory>("ssh_list_directory", { profile, path: treePath });
        childFiles = data.files || [];
      } catch (error) {
        if (!force) throw error instanceof Error ? error : new Error(String(error));
        return;
      }
    } else {
      const response = await api(
        `/api/files?path=${encodeURIComponent(treePath)}&sort=name&order=asc`,
      );
      if (!response.ok) {
        if (!force) throw new Error(await readError(response));
        return;
      }
      const data = await response.json();
      childFiles = data.files || [];
    }
    const children = childFiles
      .filter((file: FileItem) => file.isDirectory)
      .map((file: FileItem) => ({
        path: file.path,
        name: file.name,
        expanded: false,
        loaded: false,
        children: [],
      }))
      .sort((left: FolderNode, right: FolderNode) =>
        compareFileNames(left.name, right.name),
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

  // Drag-and-drop UX helpers shared by every scrollable drop target (the
  // Folders tree, the file list, and the LOCAL tree/list) so a user can drag
  // a file to any folder -- including ones currently off-screen or
  // collapsed -- without needing a separate "Move" picker dialog.
  const stopDragAutoScroll = () => {
    if (dragScrollIntervalRef.current !== null) {
      window.clearInterval(dragScrollIntervalRef.current);
      dragScrollIntervalRef.current = null;
    }
  };

  const handleDragAutoScroll = (event: React.DragEvent, container: HTMLElement | null) => {
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const threshold = 48;
    const distanceFromTop = event.clientY - rect.top;
    const distanceFromBottom = rect.bottom - event.clientY;
    stopDragAutoScroll();
    if (distanceFromTop >= 0 && distanceFromTop < threshold) {
      const speed = Math.max(2, (threshold - distanceFromTop) / 2);
      dragScrollIntervalRef.current = window.setInterval(() => {
        container.scrollTop -= speed;
      }, 16);
    } else if (distanceFromBottom >= 0 && distanceFromBottom < threshold) {
      const speed = Math.max(2, (threshold - distanceFromBottom) / 2);
      dragScrollIntervalRef.current = window.setInterval(() => {
        container.scrollTop += speed;
      }, 16);
    }
  };

  const scheduleTreeExpand = (node: FolderNode) => {
    if (node.expanded) return;
    window.clearTimeout(dragExpandTimerRef.current);
    dragExpandTimerRef.current = window.setTimeout(() => toggleFolder(node), 650);
  };

  const scheduleLocalTreeExpand = (node: FolderNode) => {
    if (node.expanded) return;
    window.clearTimeout(dragExpandTimerRef.current);
    dragExpandTimerRef.current = window.setTimeout(() => toggleLocalFolder(node), 650);
  };

  useEffect(() => {
    if (session.token && !session.onlyTerminalMode) {
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
  }, [session.token, session.onlyTerminalMode]);

  useEffect(() => {
    void (async () => {
      try {
        await loadLocalFiles("");
        await loadLocalTreeChildren("", true);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const elevated = await invoke<boolean>("is_local_elevated");
        setIsLocalElevated(elevated);
        if (!elevated) return;
        const [roots, homePath] = await Promise.all([
          invoke<string[]>("list_local_roots"),
          invoke<string>("local_home_path"),
        ]);
        setLocalRoots(roots);
        setLocalHomeAbsolute(homePath);
        setLocalTrees((trees) => [
          ...trees,
          ...roots
            .filter((root) => !trees.some((tree) => tree.path === root))
            .map((root) => ({ path: root, name: root, expanded: false, loaded: false, children: [] })),
        ]);
        notify(
          "Running with root/Administrator privileges: the LOCAL pane is no longer confined to your home directory. Be careful moving or deleting files outside it.",
        );
      } catch {
        // Not fatal -- the LOCAL pane just stays confined to HOME as usual.
      }
    })();
  }, []);

  useEffect(() => {
    if (session.token && session.locationId && !session.onlyTerminalMode) {
      const nextPath = pendingRemotePath ?? "";
      if (pendingRemotePath !== null) setPendingRemotePath(null);
      void loadFiles(nextPath).catch((error) => setNotice(error.message));
      void loadTreeChildren("").catch((error) => setNotice(error.message));
    }
  }, [session.token, session.locationId, session.onlyTerminalMode]);

  const selectLocation = (locationId: string) => {
    const wasSsh = Boolean(remoteSshEntryId);
    setRemoteSshEntryId("");
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
    if (locationId === session.locationId) {
      // Same API Location as before: the [session.locationId] effect will
      // not re-fire, so if we were leaving SSH browsing we must refresh
      // explicitly to avoid leaving the old SSH listing on screen.
      if (wasSsh) {
        void run(async () => {
          await Promise.all([loadFiles("", ""), loadTreeChildren("", true, "")]);
        });
      }
      return;
    }
    setSession((current) => ({ ...current, locationId }));
  };

  const selectSshBrowse = (entryId: string) => {
    if (entryId === remoteSshEntryId) return;
    setRemoteSshEntryId(entryId);
    setPath("/");
    setSelected([]);
    setSearch("");
    setSearching(false);
    setPathBeforeSearch("");
    setFolderTree({
      path: "/",
      name: "/",
      expanded: true,
      loaded: false,
      children: [],
    });
    void run(async () => {
      await Promise.all([loadFiles("/", entryId), loadTreeChildren("/", true, entryId)]);
    });
  };

  // Creates or renames a Workspace. This only manages the Workspace's name;
  // SSH entries and Session Path entries are added/edited afterwards, each
  // in their own floating dialog (see `saveSshEntry` and `saveSxpEntry`),
  // so a brand-new Workspace does not need a Location or a Path entry
  // selected up front just to exist.
  const saveWorkspaceName = (form?: HTMLFormElement) => {
    const values = form ? new FormData(form) : null;
    const name = String(values?.get("sessionName") || sessionNameDraft).trim();
    if (!name) {
      setSessionFormError("Workspace name is required.");
      return;
    }
    if (/\s/.test(name)) {
      setSessionFormError("Workspace names cannot contain spaces.");
      return;
    }
    const existingWorkspace = managedSessions.find((item) => item.id === workspaceSessionId);
    if (managedSessions.some((item) => item.id !== existingWorkspace?.id && item.name.toLowerCase() === name.toLowerCase())) {
      setSessionFormError(`A Workspace named "${name}" already exists.`);
      return;
    }
    const makeId = () =>
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const managedSession: ManagedSession = existingWorkspace
      ? { ...existingWorkspace, name }
      : { id: makeId(), name, sxpEntries: [], sshEntries: [] };
    setManagedSessions((current) => existingWorkspace
      ? current.map((item) => item.id === existingWorkspace.id ? managedSession : item)
      : [...current, managedSession]);
    setWorkspaceSessionId(managedSession.id);
    setSessionNameDraft(name);
    setSessionFormError("");
    setLastSavedSessionId(managedSession.id);
    setWorkspaceNameDialogOpen(false);
    notify(`Saved Workspace: ${name}`);
  };

  const openWorkspaceNameDialog = (workspace?: ManagedSession) => {
    const target = workspace || managedSessions.find((item) => item.id === workspaceSessionId);
    setWorkspaceSessionId(target?.id || "");
    setSessionNameDraft(target?.name || "");
    setSessionFormError("");
    setWorkspaceNameDialogOpen(true);
  };

  const openAddSxpEntryDialog = () => {
    setSxpEntryDraftId("");
    setSxpEntryNameDraft("Default Transfer");
    setLocalAliasDraft("Home");
    setRemoteAliasDraft(activeLocation?.displayName || "Personal");
    setSessionFormError("");
    setSxpEntryDialogOpen(true);
  };

  const openEditSxpEntryDialog = (entry: SxpEntry) => {
    setSxpEntryDraftId(entry.id);
    setSxpEntryNameDraft(entry.name);
    setLocalAliasDraft(entry.localAlias);
    setRemoteAliasDraft(entry.remoteAlias);
    setSessionFormError("");
    setSxpEntryDialogOpen(true);
  };

  // Saves the current LOCAL and API Remote browser paths (not free-typed
  // paths) under the given aliases as one Session Path entry on the active
  // Workspace, then closes the floating dialog and returns to the Sessions
  // modal's Workspace view.
  const saveSxpEntry = () => {
    const workspace = managedSessions.find((item) => item.id === workspaceSessionId);
    const name = sxpEntryNameDraft.trim();
    const localAlias = localAliasDraft.trim();
    const remoteAlias = remoteAliasDraft.trim();
    if (!workspace) {
      setSessionFormError("Save the Workspace name first, then add a Path entry to it.");
      return;
    }
    if (!name || !localAlias || !remoteAlias) {
      setSessionFormError("Preset name, local folder name, and remote folder name are required.");
      return;
    }
    if ([name, localAlias, remoteAlias].some((value) => /\s/.test(value))) {
      setSessionFormError("Path entry names cannot contain spaces.");
      return;
    }
    if (!session.locationId) {
      setSessionFormError("Select an available API Remote Location before saving this Path entry.");
      return;
    }
    const makeId = () =>
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const entry: SxpEntry = {
      id: sxpEntryDraftId || makeId(),
      name,
      localAlias,
      localPath,
      remoteAlias,
      remotePath: path,
      locationId: session.locationId,
      locationName: activeLocation?.displayName || session.locationId,
    };
    setManagedSessions((current) => current.map((item) => item.id !== workspace.id ? item : {
      ...item,
      sxpEntries: item.sxpEntries.some((candidate) => candidate.id === entry.id)
        ? item.sxpEntries.map((candidate) => candidate.id === entry.id ? entry : candidate)
        : [...item.sxpEntries, entry],
    }));
    setSessionFormError("");
    setSxpEntryDialogOpen(false);
    notify(`${sxpEntryDraftId ? "Updated" : "Added"} Path entry: ${entry.name}`);
  };

  const removeSxpEntry = () => {
    const workspace = managedSessions.find((item) => item.id === workspaceSessionId);
    if (!workspace || !sxpEntryDraftId) return;
    const entry = workspace.sxpEntries.find((item) => item.id === sxpEntryDraftId);
    if (!entry) return;
    if (workspace.sxpEntries.length === 1) {
      setNotice("Add another Path entry before removing this one; a Workspace used for transfers needs at least one.");
      return;
    }
    if (!window.confirm(`Remove Path entry "${entry.name}"?`)) return;
    setManagedSessions((current) => current.map((item) => item.id !== workspace.id ? item : { ...item, sxpEntries: item.sxpEntries.filter((candidate) => candidate.id !== entry.id) }));
    setSxpEntryDialogOpen(false);
  };

  const removeSession = (sessionId: string) => {
    if (managedSessions.length === 1) return;
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

  const stopPaneResize = () => {
    paneResizeRef.current = null;
    window.removeEventListener("pointermove", resizePane);
    window.removeEventListener("pointerup", stopPaneResize);
  };
  const resizePane = (event: PointerEvent) => {
    const start = paneResizeRef.current;
    if (!start) return;
    const maxWidth = Math.min(720, window.innerWidth - 300);
    setLocalPaneWidth(
      Math.max(220, Math.min(maxWidth, start.startWidth + (event.clientX - start.startX))),
    );
  };
  const beginPaneResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    paneResizeRef.current = { startX: event.clientX, startWidth: localPaneWidth };
    window.addEventListener("pointermove", resizePane);
    window.addEventListener("pointerup", stopPaneResize);
  };

  const stopLocalTreeResize = () => {
    localTreeResizeRef.current = null;
    window.removeEventListener("pointermove", resizeLocalTree);
    window.removeEventListener("pointerup", stopLocalTreeResize);
  };
  const resizeLocalTree = (event: PointerEvent) => {
    const start = localTreeResizeRef.current;
    if (!start) return;
    setLocalTreeWidth(
      Math.max(80, Math.min(Math.max(160, localPaneWidth - 160), start.startWidth + (event.clientX - start.startX))),
    );
  };
  const beginLocalTreeResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    localTreeResizeRef.current = { startX: event.clientX, startWidth: localTreeWidth };
    window.addEventListener("pointermove", resizeLocalTree);
    window.addEventListener("pointerup", stopLocalTreeResize);
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
    setSshPasswordSaved(false);
    if (profile?.id) {
      void invoke<boolean>("ssh_has_password", { entryId: profile.id })
        .then(setSshPasswordSaved)
        .catch(() => setSshPasswordSaved(false));
    }
  };

  const makeSshTabId = () => typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const activeSshTab = sshTabs.find((item) => item.id === activeSshTabId);
  const recordingHasOutput = Boolean(activeSshTab?.rawLog || activeSshTab?.plainLog);

  const createSshTab = (workspaceId = workspaceSessionId, entryId = selectedSshEntryId) => {
    const workspace = managedSessions.find((item) => item.id === workspaceId);
    const profile = workspace?.sshEntries.find((item) => item.id === entryId);
    if (!workspace || !profile) {
      openSessionsModal();
      setNotice("Select an SSH entry before opening a terminal tab.");
      return "";
    }
    const tab: SshTerminalTab = {
      id: makeSshTabId(),
      title: profile.name || `${profile.username}@${profile.host}`,
      workspaceId,
      sshEntryId: profile.id,
      sessionId: "",
      connected: false,
      connecting: false,
      output: "",
      recording: false,
      recordingStartedAt: null,
      rawLog: "",
      plainLog: "",
      commandLog: "",
      savedLogPaths: [],
    };
    setSshTabs((current) => [...current, tab]);
    setActiveSshTabId(tab.id);
    setWorkspaceSessionId(workspaceId);
    setSelectedSshEntryId(entryId);
    setTerminalOpen(true);
    loadSshProfileDraft(profile);
    return tab.id;
  };

  const closeSshTab = (tabId: string) => {
    const tab = sshTabs.find((item) => item.id === tabId);
    if (!tab) return;
    if (tab.connected && !window.confirm(`Disconnect and close ${tab.title}?`)) return;
    void run(async () => {
      if (tab.sessionId) await invoke("ssh_disconnect", { sessionId: tab.sessionId });
      setSshTabs((current) => {
        const remaining = current.filter((item) => item.id !== tabId);
        if (tabId === activeSshTabId) setActiveSshTabId(remaining[remaining.length - 1]?.id || "");
        return remaining;
      });
    });
  };

  const selectSshTab = (tab: SshTerminalTab) => {
    setActiveSshTabId(tab.id);
    setWorkspaceSessionId(tab.workspaceId);
    setSelectedSshEntryId(tab.sshEntryId);
    const profile = managedSessions.find((item) => item.id === tab.workspaceId)?.sshEntries.find((item) => item.id === tab.sshEntryId);
    if (profile) {
      setSshProfileId(profile.id);
      loadSshProfileDraft(profile);
    }
  };

  const performSshConnect = (tabId: string, profile: SshProfile) => {
    const attemptId = `${tabId}-${Date.now()}`;
    connectAttemptRef.current[tabId] = attemptId;
    setSshTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, connecting: true }));
    void run(async () => {
      sshConnectingRef.current = true;
      // `attemptId` doubles as the backend `requestId`: it uniquely
      // identifies this connection attempt, and the backend echoes it back
      // on every `ssh-output`/`ssh-exit` event so those events can be bound
      // to this tab even if they arrive before this invoke() call resolves.
      pendingSshConnectRequestsRef.current[attemptId] = tabId;
      try {
        const nativeProfile = {
          id: profile.id,
          name: profile.name,
          host: profile.host,
          port: profile.port,
          username: profile.username,
          privateKeyPath: profile.privateKeyPath || null,
        };
        setSshTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, output: `${item.output}${VT_SESSION_BOUNDARY_GUARD}Connecting to ${profile.username}@${profile.host}:${profile.port}...\n` }));
        const id = await invoke<string>("ssh_connect", { profile: nativeProfile, requestId: attemptId });
        if (connectAttemptRef.current[tabId] !== attemptId) return; // cancelled or superseded
        setSshTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, sessionId: id, connected: true, connecting: false }));
      } catch (error) {
        if (connectAttemptRef.current[tabId] !== attemptId) return; // cancelled or superseded
        const detail = error instanceof Error ? error.message : String(error);
        setSshTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, output: `${item.output}${detail}\n`, connecting: false }));
        setNotice(detail);
      } finally {
        delete pendingSshConnectRequestsRef.current[attemptId];
        sshConnectingRef.current = false;
      }
    });
  };

  const cancelSshConnect = (tabId: string) => {
    delete connectAttemptRef.current[tabId];
    setSshTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, connecting: false, output: `${item.output}Connection attempt cancelled.\n` }));
    notify("Connection attempt cancelled. The connection may still complete in the background and will be ignored if it does.");
  };

  const quickConnectSsh = (workspaceId: string, entryId: string) => {
    const existingTab = sshTabs.find((tab) => tab.workspaceId === workspaceId && tab.sshEntryId === entryId);
    const workspace = managedSessions.find((item) => item.id === workspaceId);
    const profile = workspace?.sshEntries.find((item) => item.id === entryId);
    if (existingTab) {
      selectSshTab(existingTab);
      if (!existingTab.connected && !existingTab.connecting && profile) performSshConnect(existingTab.id, profile);
      return;
    }
    if (!workspace || !profile) {
      openSessionsModal();
      setNotice("Select an SSH entry before connecting.");
      return;
    }
    const tabId = createSshTab(workspaceId, entryId);
    if (tabId) performSshConnect(tabId, profile);
  };

  const toggleTerminalMaximized = () => {
    if (terminalMaximized) {
      setTerminalHeight(previousTerminalHeightRef.current);
      setTerminalMaximized(false);
    } else {
      previousTerminalHeightRef.current = terminalHeight;
      setTerminalHeight(Math.max(160, window.innerHeight - 180));
      setTerminalMaximized(true);
    }
  };

  const selectWorkspaceSession = (id: string) => {
    setWorkspaceSessionId(id);
    const workspace = managedSessions.find((item) => item.id === id);
    const profile = workspace?.sshEntries[0] || sshProfiles.find((item) => item.id === sshProfileId);
    if (profile) {
      setSshEntryDraftId(workspace?.sshEntries[0]?.id || profile.id);
      setSelectedSshEntryId(profile.id);
      setSshProfileId(profile.id);
      loadSshProfileDraft(profile);
    }
  };

  const openSessionsModal = (requestedWorkspaceId = workspaceSessionId) => {
    void run(async () => {
      let workspace = managedSessions.find((item) => item.id === requestedWorkspaceId);
      if (!workspace && !managedSessions.length) {
        const makeId = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const localPath = "";
        const localAlias = "Home";
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
      }
      if (workspace) {
        setWorkspaceSessionId(workspace.id);
        const sxpEntry = workspace.sxpEntries[0];
        setSxpEntryDraftId(sxpEntry?.id || "");
        setSxpEntryNameDraft(sxpEntry?.name || "Default Transfer");
        const profile = workspace.sshEntries[0] || sshProfiles.find((item) => item.id === sshProfileId);
        setSessionNameDraft(workspace.name);
        setLocalAliasDraft(sxpEntry?.localAlias || "Home");
        setRemoteAliasDraft(sxpEntry?.remoteAlias || "Personal");
        if (profile) {
          setSshEntryDraftId(workspace.sshEntries[0]?.id || profile.id);
          setSelectedSshEntryId(profile.id);
          loadSshProfileDraft(profile);
        } else {
          setSshEntryDraftId("");
          setSelectedSshEntryId("");
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
    setLocalAliasDraft("Home");
    setRemoteAliasDraft(activeLocation?.displayName || "Personal");
    setSxpEntryDraftId("");
    setSxpEntryNameDraft("Default Transfer");
    setSshEntryDraftId("");
    setSshProfileDraft({ id: "", name: "", host: "", port: "22", username: "", privateKeyPath: "", password: "" });
    setSessionFormError("");
    setWorkspaceNameDialogOpen(true);
  };

  const startNewSshEntry = () => {
    setSshEntryDraftId("");
    setSelectedSshEntryId("");
    setSshProfileDraft({ id: "", name: "", host: "", port: "22", username: "", privateKeyPath: "", password: "" });
    setSshPasswordSaved(false);
  };

  const openAddSshEntryDialog = () => {
    startNewSshEntry();
    setSessionFormError("");
    setSshEntryDialogOpen(true);
  };

  const openEditSshEntryDialog = (entry: SshProfile) => {
    setSshEntryDraftId(entry.id);
    setSshProfileId(entry.id);
    loadSshProfileDraft(entry);
    setSessionFormError("");
    setSshEntryDialogOpen(true);
  };

  const saveSshEntry = () => {
    const workspace = managedSessions.find((item) => item.id === workspaceSessionId);
    const name = sshProfileDraft.name.trim();
    const host = sshProfileDraft.host.trim();
    const username = sshProfileDraft.username.trim();
    const port = Number(sshProfileDraft.port);
    if (!workspace) {
      setSessionFormError("Save the Workspace name first, then add an SSH entry to it.");
      return;
    }
    if (!name || !host || !username || !Number.isInteger(port) || port < 1 || port > 65535) {
      setSessionFormError("Connection name, host, username, and a valid port are required.");
      return;
    }
    const wasEditing = Boolean(sshProfileDraft.id);
    const entry: SshProfile = { id: sshProfileDraft.id || makeSshTabId(), name, host, port, username, privateKeyPath: sshProfileDraft.privateKeyPath.trim() };
    setManagedSessions((current) => current.map((item) => item.id !== workspace.id ? item : {
      ...item,
      sshEntries: item.sshEntries.some((candidate) => candidate.id === entry.id)
        ? item.sshEntries.map((candidate) => candidate.id === entry.id ? entry : candidate)
        : [...item.sshEntries, entry],
    }));
    setSshProfiles((current) => current.some((item) => item.id === entry.id) ? current.map((item) => item.id === entry.id ? entry : item) : [...current, entry]);
    // Keep the just-saved entry as the "active" SSH selection for connecting
    // outside this dialog, but clear the draft/form and close the floating
    // SSH Entry dialog, returning to the Sessions modal's Workspace view.
    // This applies to both creating a new entry and updating an existing
    // one -- either way, Save returns to the Workspace.
    setSelectedSshEntryId(entry.id);
    setSshProfileId(entry.id);
    const password = sshProfileDraft.password;
    setSshEntryDraftId("");
    setSshProfileDraft({ id: "", name: "", host: "", port: "22", username: "", privateKeyPath: "", password: "" });
    setSshPasswordSaved(false);
    setSessionFormError("");
    setSshEntryDialogOpen(false);
    if (password) {
      void invoke("ssh_save_password", { entryId: entry.id, password })
        .then(() => setSshPasswordSaved(true))
        .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    }
    notify(`${wasEditing ? "Updated" : "Added"} SSH entry: ${entry.name}`);
  };

  const forgetSshPassword = () => {
    if (!sshProfileDraft.id) return;
    void invoke("ssh_forget_password", { entryId: sshProfileDraft.id })
      .then(() => {
        setSshPasswordSaved(false);
        notify("Saved password removed for this SSH entry.");
      })
      .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  };

  const removeSshEntry = () => {
    const workspace = managedSessions.find((item) => item.id === workspaceSessionId);
    if (!workspace || !sshEntryDraftId) return;
    const entry = workspace.sshEntries.find((item) => item.id === sshEntryDraftId);
    if (!entry || !window.confirm(`Remove SSH entry "${entry.name}"?`)) return;
    setManagedSessions((current) => current.map((item) => item.id !== workspace.id ? item : { ...item, sshEntries: item.sshEntries.filter((candidate) => candidate.id !== entry.id) }));
    setSshProfiles((current) => current.filter((item) => item.id !== entry.id));
    void invoke("ssh_forget_password", { entryId: entry.id }).catch(() => {});
    startNewSshEntry();
    setSshEntryDialogOpen(false);
  };

  const connectSsh = () => {
    const tabId = activeSshTabId || createSshTab();
    const tab = sshTabs.find((item) => item.id === tabId);
    const workspace = managedSessions.find((item) => item.id === (tab?.workspaceId || workspaceSessionId));
    const profile = workspace?.sshEntries.find((item) => item.id === (tab?.sshEntryId || selectedSshEntryId));
    if (!tabId || !workspace || !profile) {
      openSessionsModal();
      setNotice("Select or create a Session with an SSH connection before connecting.");
      return;
    }
    performSshConnect(tabId, profile);
  };

  const installSshKey = () => {
    const tabId = activeSshTabId || createSshTab();
    const tab = sshTabs.find((item) => item.id === tabId);
    const workspace = managedSessions.find((item) => item.id === (tab?.workspaceId || workspaceSessionId));
    const profile = workspace?.sshEntries.find((item) => item.id === (tab?.sshEntryId || selectedSshEntryId));
    if (!tabId || !workspace || !profile) {
      openSessionsModal();
      setNotice("Select an SSH entry before installing its key.");
      return;
    }
    void run(async () => {
      setSshTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, output: `${item.output}Installing SSH key for ${profile.username}@${profile.host}:${profile.port} using the saved password...\n` }));
      try {
        const message = await invoke<string>("ssh_install_key", {
          profile: {
            id: profile.id,
            name: profile.name,
            host: profile.host,
            port: profile.port,
            username: profile.username,
            privateKeyPath: profile.privateKeyPath || null,
          },
        });
        setSshTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, output: `${item.output}${message}\n` }));
        notify(message);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setSshTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, output: `${item.output}${detail}\n` }));
        setNotice(detail);
      }
    });
  };

  const disconnectSsh = () => {
    const tab = activeSshTab;
    if (!tab?.sessionId) return;
    void run(async () => {
      await invoke("ssh_disconnect", { sessionId: tab.sessionId });
      setSshTabs((current) => current.map((item) => item.id !== tab.id ? item : { ...item, connected: false, sessionId: "", output: `${item.output}\nDisconnected.\n`, recording: false }));
      sshConnectingRef.current = false;
    });
  };

  const startRecording = () => {
    if (!activeSshTab?.connected) return;
    rawLogRef.current = "";
    plainLogRef.current = "";
    commandLogRef.current = "";
    const startedAt = Date.now();
    setSshTabs((current) => current.map((item) => item.id !== activeSshTab.id ? item : { ...item, recording: true, recordingStartedAt: startedAt, rawLog: "", plainLog: "", commandLog: "", savedLogPaths: [] }));
    notify("SSH output recording started.");
  };

  const stopRecording = () => {
    if (!activeSshTab) return;
    setSshTabs((current) => current.map((item) => item.id === activeSshTab.id ? { ...item, recording: false } : item));
    notify("Recording finalized. Save the log package before disconnecting.");
  };

  const saveSshLogs = () => {
    const tab = activeSshTab;
    const profile = managedSessions.find((item) => item.id === tab?.workspaceId)?.sshEntries.find((item) => item.id === tab?.sshEntryId);
    const logName = saveLogNameDraft.trim();
    if (tab?.recording) {
      setNotice("Stop the SSH recording before saving the log package.");
      return;
    }
    if (!tab || !profile || (!tab.rawLog && !tab.plainLog)) {
      setNotice("There is no completed SSH recording to save.");
      return;
    }
    if (!logName) {
      setNotice("Enter a name for the SSH log package.");
      return;
    }
    const metadata = JSON.stringify({
           profileName: logName,
      host: profile.host,
      startedAt: tab.recordingStartedAt ? new Date(tab.recordingStartedAt).toISOString() : null,
      endedAt: new Date().toISOString(),
      rawBytes: new TextEncoder().encode(tab.rawLog).length,
      files: ["raw.log", "txt", "commands.log", "meta.json"],
    }, null, 2);
    void run(async () => {
      const paths = await invoke<{ raw: string; plain: string; commands: string; metadata: string }>(
        "save_ssh_logs",
         {
            profileName: logName,
           destinationPath: saveLogDestinationPath,
           raw: tab.rawLog,
          plain: tab.plainLog,
          commands: tab.commandLog,
          metadata,
        },
       );
       setSshTabs((current) => current.map((item) => item.id === tab.id ? { ...item, savedLogPaths: [paths.raw, paths.plain, paths.commands, paths.metadata] } : item));
       if (desktopSettings.operationLogEnabled) {
          void invoke("append_operation_log", {
            level: "INFO",
            operation: "save_ssh_log",
           status: "completed",
           sourceLabel: logName,
            destinationLabel: `LOCAL: ~/${saveLogDestinationPath || ""}`,
           detail: "SSH output recording package saved.",
         });
       }
       setSaveLogNameOpen(false);
       notify(`Saved SSH logs to ${paths.raw}`);
      });
    };

  const openSaveLogDialog = () => {
    if (!recordingHasOutput || recording) return;
    const profile = managedSessions.find((item) => item.id === activeSshTab?.workspaceId)?.sshEntries.find((item) => item.id === activeSshTab?.sshEntryId);
    setSaveLogNameDraft(profile?.name || "SSH session");
    void run(async () => {
      const selectedPath = await invoke<string | null>("pick_local_directory", { path: localPath });
      if (selectedPath === null) return;
      setSaveLogDestinationPath(selectedPath);
      setSaveLogNameOpen(true);
    });
  };

  const writeOperationLog = (operation: string, status: string, sourceLabel: string, destinationLabel: string, detail: string, level: DesktopSettings["operationLogLevel"] = "INFO") => {
    if (!desktopSettings.operationLogEnabled) return;
    const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
    if (levels[level] < levels[desktopSettings.operationLogLevel]) return;
    void invoke("append_operation_log", {
      level,
      operation,
      status,
      sourceLabel,
      destinationLabel,
      detail,
    });
  };
  // Every file-mutating action below should log both how it finished, success
  // or failure -- an on-screen `notify`/error banner disappears after a few
  // seconds and is gone for good, so without a persisted log entry a failure
  // (e.g. "builder error") leaves no trace to diagnose after the fact.
  const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const updateQueueItem = (id: string, update: Partial<TransferQueueItem>) => {
    setTransferQueue((current) => {
      const now = Date.now();
      const updated = current.map((item) => {
        if (item.id !== id) return item;
        // A late invoke/listener callback must not resurrect a cancelled item.
        if (item.status === "cancelled" && update.status && update.status !== "cancelled") return item;
        const terminal = update.status === "completed" || update.status === "failed" || update.status === "cancelled";
        if (update.status && update.status !== item.status) {
          assertQueueTransition(item.status, update.status);
        }
        const nextItem = {
          ...item,
          ...update,
          ...(terminal ? { finishedAt: item.finishedAt || now } : {}),
        };
        if (update.status === "failed" || update.status === "needs_user_action") {
          nextItem.error = {
            category: update.errorCategory || item.errorCategory || "unknown",
            message: update.detail || item.detail,
            itemId: item.id,
            path: item.paths[0],
            attempt: (update.retryCount || item.retryCount || 0) + 1,
            timestamp: now,
          };
        }
        return nextItem;
      });
      const retained = pruneQueueHistory(updated, now);
      queueStoreRef.current.replace(retained);
      return retained;
    });
  };

  const updateQueueProgress = (id: string, completedBytes: number, totalBytes: number | null, completedItems?: number, totalItems?: number) => {
    const previousSample = queueProgressSamplesRef.current.get(id) || [];
    const now = Date.now();
    const progress = calculateQueueProgress(
      transferQueue.find((item) => item.id === id)?.progress,
      completedBytes,
      totalBytes,
      completedItems,
      totalItems,
      previousSample,
    );
    queueProgressSamplesRef.current.set(id, [...previousSample, { bytes: completedBytes, at: now }].filter((sample) => now - sample.at <= 3000));
    updateQueueItem(id, { progress, detail: `${formatSize(completedBytes)}${totalBytes ? ` / ${formatSize(totalBytes)}` : ""}${formatQueueProgress(progress)}` });
    return progress;
  };

  const cancelledQueueItemsRef = useRef(new Set<string>());
  const cancelQueueItem = (id: string) => {
    const current = transferQueue.find((item) => item.id === id);
    if (!current || ["completed", "failed", "cancelled"].includes(current.status)) return;
    cancelledQueueItemsRef.current.add(id);
    queueProgressSamplesRef.current.delete(id);
    queueCompletionHandlersRef.current.delete(id);
    void invoke("cancel_transfer", { transferId: id }).catch(() => {});
    updateQueueItem(id, { status: "cancelled", detail: "Cancelled by user." });
    writeOperationLog(current.kind === "upload" ? "upload" : "download", "cancelled", current.label, current.destinationPath, "Transfer queue item cancelled by user.", "INFO");
  };
  const removeQueueItem = (id: string) => {
    const current = transferQueue.find((item) => item.id === id);
    if (current && !["completed", "failed", "cancelled"].includes(current.status)) {
      cancelQueueItem(id);
      return;
    }
    cancelledQueueItemsRef.current.add(id);
    queueProgressSamplesRef.current.delete(id);
    queueCompletionHandlersRef.current.delete(id);
    setTransferQueue((current) => current.filter((item) => item.id !== id));
  };
  const clearQueueHistory = () => {
    setTransferQueue((current) => current.filter((item) => !["completed", "failed", "cancelled"].includes(item.status)));
  };
  const clearQueueStatus = (status: TransferQueueItem["status"]) => {
    setTransferQueue((current) => current.filter((item) => item.status !== status));
  };
  const clearFinishedQueue = () => {
    setTransferQueue((current) => current.filter((item) => !["completed", "failed", "cancelled"].includes(item.status)));
  };
  const isQueueItemCancelled = (id: string) => cancelledQueueItemsRef.current.has(id);

  const executeQueuedSshUpload = async (item: TransferQueueItem, profile: SshProfile) => {
    writeOperationLog("upload", "started", item.label, `${item.locationName}:${item.destinationPath || "/"}`, "SSH transfer queue upload started.", "DEBUG");
    updateQueueItem(item.id, { status: "running", detail: `Uploading 0/${item.paths.length} items...` });
    let completed = 0;
    try {
      for (const localPath of item.paths) {
        if (isQueueItemCancelled(item.id)) return;
        await invoke("ssh_upload_path", { profile, localPath, remoteDestinationFolder: item.destinationPath });
        completed += 1;
        updateQueueItem(item.id, { detail: `Uploading ${completed}/${item.paths.length} items...` });
      }
      updateQueueItem(item.id, { status: "completed", detail: `Uploaded ${completed} item(s) to ${item.destinationPath || "/"}.` });
      writeOperationLog("upload", "completed", item.label, `${item.locationName}:${item.destinationPath || "/"}`, `Uploaded ${completed} item(s) via SFTP.`);
      await loadFiles(path);
    } catch (error) {
      if (isQueueItemCancelled(item.id)) return;
      const recovery = classifyQueueError(error);
      const detail = `${recovery.message} (${completed}/${item.paths.length} completed before failing)`;
      updateQueueItem(item.id, { status: recovery.needsUserAction ? "needs_user_action" : "failed", detail: `[${recovery.category}] ${detail}`, errorCategory: recovery.category });
      writeOperationLog("upload", "failed", item.label, `${item.locationName}:${item.destinationPath || "/"}`, `SSH queued upload failed: ${detail}`, "ERROR");
    }
  };

  const executeQueuedUpload = async (item: TransferQueueItem) => {
    writeOperationLog("upload", "started", item.label, `${item.locationName}:${item.destinationPath || "/"}`, "Transfer queue upload started.", "DEBUG");
    updateQueueItem(item.id, { status: "running", detail: "Inspecting local files (this does not load file contents into the UI)..." });
    let unlistenProgress: (() => void) | undefined;
    try {
      const summary = await invoke<UploadSummary>("inspect_upload_paths", { paths: item.paths });
      unlistenProgress = await listen<{ transferId: string; bytesCompleted: number; bytesTotal: number }>(
        "upload-progress",
        (event) => {
          if (event.payload.transferId !== item.id || isQueueItemCancelled(item.id)) return;
          const { bytesCompleted, bytesTotal } = event.payload;
          const progress = updateQueueProgress(item.id, bytesCompleted, bytesTotal || null, 0, summary.files);
          updateQueueItem(item.id, {
            detail: `Uploading ${formatSize(bytesCompleted)} / ${formatSize(bytesTotal)}${formatQueueProgress(progress)}`,
          });
        },
      );
      const headers: [string, string][] = session.token
        ? [
            ["Authorization", `Bearer ${session.token}`],
            ["X-Location-ID", item.locationId],
          ]
        : [["X-Location-ID", item.locationId]];
      updateQueueItem(item.id, {
        detail: `Prepared ${summary.files} file${summary.files === 1 ? "" : "s"} (${formatSize(summary.totalSize)}); streaming upload...`,
      });
      updateQueueItem(item.id, { progress: initialQueueProgress(summary.files, summary.totalSize || null) });
      const currentSources = await invoke<UploadSummary>("inspect_upload_paths", { paths: item.paths });
      const sourceChanged = summary.sources.length !== currentSources.sources.length
        || summary.sources.some((source, index) => {
          const current = currentSources.sources[index];
          return !current || current.path !== source.path || current.size !== source.size || current.modified !== source.modified;
        });
      if (sourceChanged) throw new Error("Upload source changed after it was queued. Re-add the file to upload the new content.");
      const rawResponse = await invoke<NativeApiResponse>("api_upload_paths", {
        transferId: item.id,
        expectedSources: summary.sources,
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
         if (isQueueItemCancelled(item.id)) return;
         updateQueueItem(item.id, { status: "completed", detail: `Uploaded ${summary.files} file${summary.files === 1 ? "" : "s"}.` });
         writeOperationLog("upload", "completed", item.label, `${item.locationName}:${item.destinationPath || "/"}`, `Uploaded ${summary.files} file${summary.files === 1 ? "" : "s"}.`);
         return;
      }
      for (let attempt = 0; attempt < 600; attempt += 1) {
        if (isQueueItemCancelled(item.id)) return;
        const progressResponse = await invoke<NativeApiResponse>("api_request", {
          url: `${serverUrl(session)}/api/progress/batch/${encodeURIComponent(batchId)}`,
          method: "GET",
          headers,
          body: null,
          ignoreTlsErrors: session.ignoreTlsErrors,
        });
        if (isQueueItemCancelled(item.id)) return;
        const progress = new ApiResponse(progressResponse.status, progressResponse.body);
        if (!progress.ok) throw new Error(await readError(progress));
         const batch = await progress.json() as { status: string; progress: number; successCount: number; totalFiles: number; failedCount: number; totalSize?: number; transferredSize?: number };
         const totalBytes = batch.totalSize || summary.totalSize || null;
         const completedBytes = batch.transferredSize || (totalBytes ? Math.round(totalBytes * batch.progress / 100) : 0);
         const queueProgress = updateQueueProgress(item.id, completedBytes, totalBytes, batch.successCount, batch.totalFiles);
         updateQueueItem(item.id, { detail: `${batch.successCount}/${batch.totalFiles} files (${Math.round(batch.progress)}%)${totalBytes ? ` · ${formatSize(completedBytes)} / ${formatSize(totalBytes)}` : ""}${formatQueueProgress(queueProgress)}` });
         if (batch.status === "completed") {
             if (isQueueItemCancelled(item.id)) return;
             updateQueueItem(item.id, { status: "completed", detail: `Uploaded ${batch.successCount} file${batch.successCount === 1 ? "" : "s"}.` });
            writeOperationLog("upload", "completed", item.label, `${item.locationName}:${item.destinationPath || "/"}`, `Uploaded ${batch.successCount} file${batch.successCount === 1 ? "" : "s"}.`);
            await loadFiles(path);
            return;
        }
        if (batch.status === "failed" || batch.status === "partial_fail") {
          throw new Error(`${batch.failedCount} file${batch.failedCount === 1 ? "" : "s"} failed.`);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
      throw new Error("Upload progress timed out.");
    } catch (error) {
      if (isQueueItemCancelled(item.id)) return;
      const recovery = classifyQueueError(error);
      const detail = recovery.message;
      const retryCount = item.retryCount || 0;
      if (recovery.retryable && retryCount < 3 && !isQueueItemCancelled(item.id)) {
        const nextItem = { ...item, status: "retrying" as const, retryCount: retryCount + 1, detail: `[${recovery.category}] Retry ${retryCount + 1}/3 queued`, errorCategory: recovery.category };
        updateQueueItem(item.id, nextItem);
        window.setTimeout(() => { updateQueueItem(item.id, { status: "queued", detail: "Retry starting" }); void runQueuedUpload({ ...nextItem, status: "queued" }); }, retryDelayMs(retryCount + 1));
        return;
      }
      updateQueueItem(item.id, {
        status: recovery.needsUserAction ? "needs_user_action" : "failed",
        detail: `[${recovery.category}] ${detail}`,
        errorCategory: recovery.category,
      });
      writeOperationLog("upload", "failed", item.label, `${item.locationName}:${item.destinationPath || "/"}`, `Upload failed: ${detail}`, "ERROR");
    } finally {
      unlistenProgress?.();
    }
  };

  const executeQueuedDownload = async (item: TransferQueueItem) => {
    const destinationLabel = `LOCAL: ~/${item.localDestinationFolder || ""}`;
    writeOperationLog("download", "started", item.label, destinationLabel, "Transfer queue download started.", "DEBUG");
    updateQueueItem(item.id, { status: "running", detail: item.archiveFormat ? `Preparing ${item.archiveFormat} archive...` : "Downloading..." });
    // download_to_disk streams the response and emits "download-progress"
    // events tagged with this item's id so the queue can show byte-level
    // progress for single-file and archive downloads (previously just a
    // static "Downloading..." label for the whole transfer).
    const unlistenProgress = await listen<{ transferId: string; bytesCompleted: number; bytesTotal?: number }>(
      "download-progress",
      (event) => {
        if (event.payload.transferId !== item.id) return;
        const { bytesCompleted, bytesTotal } = event.payload;
        updateQueueProgress(item.id, bytesCompleted, bytesTotal ?? null);
      },
    );
    try {
      if (item.archiveFormat) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        updateQueueItem(item.id, { detail: `Streaming ${item.archiveFormat} download...` });
      }
      const destination = await invoke<string>("download_to_disk", {
        transferId: item.id,
        url: item.downloadUrl,
        method: item.downloadMethod || "GET",
        headers: item.downloadHeaders || [],
        body: item.downloadBody,
        fileName: item.downloadFileName || "download.bin",
        destinationFolder: item.localDestinationFolder || "",
        ignoreTlsErrors: session.ignoreTlsErrors,
      });
      if (isQueueItemCancelled(item.id)) return;
      const completionHandler = queueCompletionHandlersRef.current.get(item.id);
      if (completionHandler) {
        await completionHandler(destination);
        queueCompletionHandlersRef.current.delete(item.id);
      }
      if (isQueueItemCancelled(item.id)) return;
      updateQueueItem(item.id, {
        status: "completed",
        detail: `Downloaded to ${destination}.${item.progress ? formatQueueProgress(item.progress) : ""}`,
      });
      writeOperationLog("download", "completed", item.label, destinationLabel, `Downloaded to ${destination}.`);
    } catch (error) {
      if (isQueueItemCancelled(item.id)) return;
      const recovery = classifyQueueError(error);
      const detail = recovery.message;
      const retryCount = item.retryCount || 0;
      if (recovery.retryable && retryCount < 3 && !isQueueItemCancelled(item.id)) {
        const nextItem = { ...item, status: "retrying" as const, retryCount: retryCount + 1, detail: `[${recovery.category}] Retry ${retryCount + 1}/3 queued`, errorCategory: recovery.category };
        updateQueueItem(item.id, nextItem);
        window.setTimeout(() => { updateQueueItem(item.id, { status: "queued", detail: "Retry starting" }); void runQueuedDownload({ ...nextItem, status: "queued" }); }, retryDelayMs(retryCount + 1));
        return;
      }
      updateQueueItem(item.id, { status: recovery.needsUserAction ? "needs_user_action" : "failed", detail: `[${recovery.category}] ${detail}`, errorCategory: recovery.category });
      writeOperationLog("download", "failed", item.label, destinationLabel, `Download failed: ${detail}`, "ERROR");
    } finally {
      unlistenProgress();
    }
  };

  const executeQueuedDownloadSet = async (item: TransferQueueItem) => {
    const files = item.setFiles || [];
    const destinationLabel = `LOCAL: ~/${item.localDestinationFolder || ""}`;
    writeOperationLog("download", "started", item.label, destinationLabel, `Queued download of ${files.length} file(s) started.`, "DEBUG");
    updateQueueItem(item.id, { status: "running", detail: `Downloading 0/${files.length} files...`, setCompleted: 0 });
    const headers: [string, string][] = session.token
      ? [["Authorization", `Bearer ${session.token}`], ...(session.locationId ? [["X-Location-ID", session.locationId] as [string, string]] : [])]
      : [];
    let completed = 0;
    let lastDestinationRoot = "";
    try {
      for (const file of files) {
        if (isQueueItemCancelled(item.id)) return;
        // `file.relativePath` already starts with the selected item's own
        // top-level name (the flatten endpoint prefixes it with each
        // selected item's name) -- it must not also be nested under an
        // extra synthetic "<n> selected items" segment here, or a single
        // selected directory would end up duplicated inside itself.
        const destination = await invoke<string>("download_to_disk_at", {
          transferId: item.id,
          url: `${serverUrl(session)}/api/files/download/${downloadPath(file.remotePath)}`,
          method: "GET",
          headers,
          body: undefined,
          destinationFolder: item.localDestinationFolder || "",
          relativePath: file.relativePath,
          ignoreTlsErrors: session.ignoreTlsErrors,
        });
        completed += 1;
        lastDestinationRoot = destination.slice(0, destination.length - (file.relativePath.length + 1));
        updateQueueItem(item.id, { detail: `Downloading ${completed}/${files.length} files...`, setCompleted: completed });
        const totalBytes = files.reduce((sum, current) => sum + current.size, 0);
        const completedBytes = files.slice(0, completed).reduce((sum, current) => sum + current.size, 0);
        updateQueueProgress(item.id, completedBytes, totalBytes, completed, files.length);
      }
      updateQueueItem(item.id, { status: "completed", detail: `Downloaded ${completed} file(s) to ${lastDestinationRoot || destinationLabel}.` });
      writeOperationLog("download", "completed", item.label, destinationLabel, `Downloaded ${completed} file(s).`);
    } catch (error) {
      if (isQueueItemCancelled(item.id)) return;
      const recovery = classifyQueueError(error);
      const detail = recovery.message;
      const retryCount = item.retryCount || 0;
      if (recovery.retryable && retryCount < 3 && !isQueueItemCancelled(item.id)) {
        const nextItem = { ...item, status: "retrying" as const, retryCount: retryCount + 1, detail: `[${recovery.category}] Retry ${retryCount + 1}/3 queued`, errorCategory: recovery.category };
        updateQueueItem(item.id, nextItem);
        window.setTimeout(() => { updateQueueItem(item.id, { status: "queued", detail: "Retry starting" }); void runQueuedDownloadSet({ ...nextItem, status: "queued" }); }, retryDelayMs(retryCount + 1));
        return;
      }
      updateQueueItem(item.id, { status: recovery.needsUserAction ? "needs_user_action" : "failed", detail: `[${recovery.category}] ${detail} (${completed}/${files.length} completed before failing)`, errorCategory: recovery.category });
      writeOperationLog("download", "failed", item.label, destinationLabel, `Queued download failed: ${detail}`, "ERROR");
    }
  };

  const findDefaultRemoteUploadPath = async (locationId: string) => {
    const rootResponse = await apiForLocation("/api/files?path=", locationId);
    if (!rootResponse.ok) throw new Error(await readError(rootResponse));
    const root = await rootResponse.json() as { files?: FileItem[] };
    const personal = (root.files || []).find((file) => file.isDirectory && file.name.toLowerCase() === "personal");
    if (!personal) return "";
    const personalResponse = await apiForLocation(`/api/files?path=${encodeURIComponent(personal.path)}`, locationId);
    if (!personalResponse.ok) return personal.path;
    const personalData = await personalResponse.json() as { files?: FileItem[] };
    const username = session.username.trim().toLowerCase();
    const userFolder = username
      ? (personalData.files || []).find((file) => file.isDirectory && file.name.toLowerCase() === username)
      : undefined;
    return userFolder?.path || personal.path;
  };

  const queueSavedLogUpload = (destinationPath: string, destinationSessionId: string = uploadSessionId) => {
    const managedSession = apiUploadSessions.find((item) => item.id === destinationSessionId);
    const sxpEntry = managedSession?.sxpEntries[0];
    const destination = managedSession && session.locationId
      ? {
          locationId: sxpEntry?.locationId || session.locationId,
          locationName: sxpEntry?.locationName || activeLocation?.displayName || session.locationId,
        }
      : null;
    if (!destination?.locationId) {
      setNotice("Select a Session with an API Remote destination before uploading the log.");
      setQueueOpen(true);
      return;
    }
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
    const item: TransferQueueItem = {
      id,
      label: "SSH log package",
      kind: "upload",
      paths: savedLogPaths,
      destinationPath,
      locationId: destination.locationId,
      locationName: destination.locationName || destination.locationId,
      status: "queued",
      detail: "Waiting to start",
    };
    setUploadDestinationOpen(false);
    setTransferQueue((current) => [...current, item]);
    setQueueOpen(true);
    void runQueuedUpload(item);
  };

  const uploadSavedLog = () => {
    const managedSession = apiUploadSessions.find((item) => item.id === uploadSessionId);
    const sxpEntry = managedSession?.sxpEntries[0];
    const remoteLocationId = sxpEntry?.locationId || session.locationId;
    if (!savedLogPaths.length) {
      setNotice("Save the completed SSH log package before uploading it.");
      return;
    }
    if (!remoteLocationId) {
      setNotice("Select a Session with an API Remote destination before uploading the log.");
      setQueueOpen(true);
      return;
    }
    void run(async () => {
      const defaultPath = sxpEntry?.remotePath || await findDefaultRemoteUploadPath(remoteLocationId);
      setUploadDestinationPath(defaultPath);
      setUploadDestinationOpen(true);
    });
  };

  const refreshStorageInfo = () => {
    void run(async () => {
      const info = await invoke<OperationStorageInfo>("operation_storage_info");
      setStorageInfo(info);
    });
  };

  const clearHistory = () => {
    if (!window.confirm("Clear undo history? This removes only the saved undo records and cannot be undone.")) return;
    void run(async () => {
      await invoke("clear_operation_history");
      refreshStorageInfo();
      notify("Undo history cleared.");
    });
  };

  const clearLogs = () => {
    if (!window.confirm("Clear operation logs? This removes only nFterm operation logs, not user files or transfer staging data.")) return;
    void run(async () => {
      await invoke("clear_operation_logs");
      refreshStorageInfo();
      notify("Operation logs cleared.");
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

  const enterOnlyTerminalMode = () => {
    setPassword("");
    setSession((current) => ({
      ...current,
      token: "only-terminal-mode",
      username: "only-terminal",
      userId: 0,
      role: "test",
      permissions: [],
      locationId: "",
      onlyTerminalMode: true,
    }));
    setNotice(
      "Only Terminal: skipped login and API server connection. Local Explorer and SSH Terminal are available; remote (REMOTE) features are disabled.",
    );
  };

  const sortedFiles = sortFileItems(files, remoteSortKey, remoteSortDirection);
  const sortedLocalFiles = sortFileItems(localFiles, localSortKey, localSortDirection);
  const selectedItems = files.filter((file) => selected.includes(file.path));
  const localSelectedItems = localFiles.filter((file) => localSelected.includes(file.path));
  const activeTransferQueue = transferQueue.filter((item) => ["queued", "running", "retrying", "needs_user_action"].includes(item.status));
  const transferHistory = transferQueue.filter((item) => ["completed", "failed", "cancelled"].includes(item.status));
  // Whether the REMOTE file list should show an in-list "../" entry to go up
  // one level, mirroring LOCAL's own in-list ".." row instead of a separate
  // toolbar button. Root differs by source: SSH browsing is always
  // absolute-path-rooted at "/", while API-backed Locations use "" as root.
  const showRemoteUp = remoteSshEntryId ? path !== "/" : Boolean(path);
  const workspaceSessions = managedSessions.filter((item) => item.sshEntries.length > 0);
  // A saved Workspace can predate the current Location metadata and have an
  // empty SXP locationId. The authenticated API session is still a valid
  // upload destination, so keep the Workspace selectable and fall back to
  // the current session.locationId when resolving its destination.
  const apiUploadSessions = managedSessions;
  useEffect(() => {
    if (!apiUploadSessions.some((item) => item.id === uploadSessionId)) {
      setUploadSessionId(apiUploadSessions[0]?.id || "");
    }
  }, [apiUploadSessions, uploadSessionId]);
  const activeWorkspaceSession = workspaceSessions.find((item) => item.id === workspaceSessionId);
  // The Sessions modal's Workspace panel shows this regardless of whether it
  // has any SSH entries yet (unlike `activeWorkspaceSession` above, which is
  // scoped to the SSH terminal selector and only considers workspaces that
  // already have at least one SSH entry).
  const activeManagedWorkspace = managedSessions.find((item) => item.id === workspaceSessionId);
  const toggle = (file: FileItem, checked: boolean) => {
    setActivePane("remote");
    selectionAnchorRef.current = file.path;
    setSelected((current) =>
      checked
        ? [...new Set([...current, file.path])]
        : current.filter((value) => value !== file.path),
    );
  };

  const selectFile = (file: FileItem, event: React.MouseEvent) => {
    setActivePane("remote");
    const index = sortedFiles.findIndex((item) => item.path === file.path);
    const anchorIndex = selectionAnchorRef.current
      ? sortedFiles.findIndex((item) => item.path === selectionAnchorRef.current)
      : -1;
    if (event.shiftKey && anchorIndex >= 0 && index >= 0) {
      const start = Math.min(anchorIndex, index);
      const end = Math.max(anchorIndex, index);
      setSelected(sortedFiles.slice(start, end + 1).map((item) => item.path));
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      selectionAnchorRef.current = file.path;
      setSelected((current) => current.includes(file.path)
        ? current.filter((value) => value !== file.path)
        : [...current, file.path]);
      return;
    }
    selectionAnchorRef.current = file.path;
    setSelected([file.path]);
  };

  // Mirrors `selectFile` above (Shift range-select, Ctrl/Cmd toggle
  // multi-select) for the LOCAL file list, which previously had no
  // multi-select at all -- every click replaced the whole selection with a
  // single item, so more than one LOCAL file could only ever be selected
  // via the "Select all" button.
  const selectLocalFile = (file: FileItem, event: React.MouseEvent) => {
    setActivePane("local");
    const index = sortedLocalFiles.findIndex((item) => item.path === file.path);
    const anchorIndex = localSelectionAnchorRef.current
      ? sortedLocalFiles.findIndex((item) => item.path === localSelectionAnchorRef.current)
      : -1;
    if (event.shiftKey && anchorIndex >= 0 && index >= 0) {
      const start = Math.min(anchorIndex, index);
      const end = Math.max(anchorIndex, index);
      setLocalSelected(sortedLocalFiles.slice(start, end + 1).map((item) => item.path));
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      localSelectionAnchorRef.current = file.path;
      setLocalSelected((current) => current.includes(file.path)
        ? current.filter((value) => value !== file.path)
        : [...current, file.path]);
      return;
    }
    localSelectionAnchorRef.current = file.path;
    setLocalSelected([file.path]);
  };

  // Rubber-band ("marquee") multi-select: click-drag on empty space inside
  // a file list/grid draws a selection box and selects every item it
  // intersects, mirroring the click-based Shift/Ctrl multi-select above.
  // Deliberately ignores clicks that start on an item, a button, or a
  // resize handle so it never fights with the existing row/tile
  // `draggable` HTML5 drag-and-drop.
  const beginMarqueeSelect = (
    event: React.MouseEvent,
    pane: "local" | "remote",
    container: HTMLElement | null,
  ) => {
    if (event.button !== 0 || !container) return;
    const target = event.target as HTMLElement;
    if (
      target.closest(
        ".file-row, .file-tile, .local-file, button, input, a, .column-resize-handle, .pane-resize-handle",
      )
    )
      return;
    // Without this, dragging from empty space also starts the browser's
    // native text/drag selection (since the mousedown lands on a text node
    // inside a row/header), highlighting filenames underneath the marquee
    // box instead of just drawing it. The CSS `user-select: none` on
    // .file-table/.file-grid/.local-file-list (see explorer-parity.css)
    // covers clicks that land exactly on text; this covers the drag itself.
    event.preventDefault();
    setActivePane(pane);
    const additive = event.ctrlKey || event.metaKey;
    marqueeStateRef.current = {
      pane,
      startX: event.clientX,
      startY: event.clientY,
      additive,
      baseSelection: additive ? (pane === "local" ? localSelected : selected) : [],
      container,
    };
    setMarqueeRect({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
  };

  useEffect(() => {
    const intersects = (a: DOMRect, b: { left: number; top: number; right: number; bottom: number }) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

    const handleMove = (event: MouseEvent) => {
      const state = marqueeStateRef.current;
      if (!state) return;
      const left = Math.min(state.startX, event.clientX);
      const top = Math.min(state.startY, event.clientY);
      const right = Math.max(state.startX, event.clientX);
      const bottom = Math.max(state.startY, event.clientY);
      setMarqueeRect({ left, top, width: right - left, height: bottom - top });
      const box = { left, top, right, bottom };
      const nodes = state.container.querySelectorAll<HTMLElement>("[data-path]");
      const hit: string[] = [];
      nodes.forEach((node) => {
        const path = node.getAttribute("data-path");
        if (path && intersects(node.getBoundingClientRect(), box)) hit.push(path);
      });
      const next = state.additive
        ? [...new Set([...state.baseSelection, ...hit])]
        : hit;
      if (state.pane === "local") setLocalSelected(next);
      else setSelected(next);
    };

    const handleUp = () => {
      if (!marqueeStateRef.current) return;
      marqueeStateRef.current = null;
      setMarqueeRect(null);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

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

  const canDropOnRemote = (destination: string) =>
    dragSource === "local"
      ? Boolean(dragItems.length && (remoteSshEntryId ? true : locationOnline && hasCapability("upload")))
      : dragSource === "remote" && isValidMoveTarget(dragItems, destination);

  // Whether the current REMOTE view (SSH or API) allows dragging its items
  // out to LOCAL. SSH always can (SFTP download); an API Remote can only if
  // it's online and the active Location grants read access.
  const canDragRemoteToLocal = Boolean(remoteSshEntryId) || (locationOnline && hasCapability("read"));
  // Mirror of the above for the opposite direction (LOCAL -> REMOTE
  // upload), used to gate drag-over/drop-target feedback consistently with
  // `canDropOnRemote`'s own "local" branch.
  const canDragLocalToRemote = Boolean(remoteSshEntryId) || (locationOnline && hasCapability("upload"));

  // Undo history is intentionally limited to operations that can be reliably
  // and verifiably reversed: rename and move (a move is just a rename that
  // also changes the parent folder). There is no remote Trash, so delete is
  // never recorded here -- the delete confirmation dialog makes that explicit
  // to the user instead.
  const MAX_UNDO_ENTRIES = 20;

  const recordUndoEntry = (entry: Omit<UndoEntry, "id">) => {
    if (!desktopSettings.undoHistoryEnabled) return;
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
    setUndoStack((current) => [...current, { ...entry, id }].slice(-MAX_UNDO_ENTRIES));
  };

  const recordUndoableRename = (options: { source: "api" | "ssh" | "local"; locationId?: string; entryId?: string; oldPath: string; newPath: string }) =>
    recordUndoEntry({
      description: `Rename ${options.oldPath.split("/").pop()} back to ${options.newPath.split("/").pop()}`,
      ...options,
    });

  const recordUndoableMove = (options: { source: "api" | "ssh" | "local"; locationId?: string; entryId?: string; oldPath: string; newPath: string }) =>
    recordUndoEntry({
      description: `Move ${options.newPath} back to ${options.oldPath}`,
      ...options,
    });

  const undoLastOperation = () =>
    run(async () => {
      const entry = undoStack[undoStack.length - 1];
      if (!entry) return;
      const sourceLabel =
        entry.source === "ssh" ? `SSH: ${entry.newPath}`
        : entry.source === "local" ? `LOCAL: ~/${entry.newPath}`
        : `${activeLocation?.displayName || entry.locationId || "Remote"}:${entry.newPath}`;
      const destinationLabel =
        entry.source === "ssh" ? `SSH: ${entry.oldPath}`
        : entry.source === "local" ? `LOCAL: ~/${entry.oldPath}`
        : `${activeLocation?.displayName || entry.locationId || "Remote"}:${entry.oldPath}`;
      try {
        if (entry.source === "ssh") {
          const profile = entry.entryId ? findSshProfileById(entry.entryId) : undefined;
          if (!profile) throw new Error("The SSH connection for this undo entry is no longer available.");
          await invoke("ssh_rename_path", { profile, oldPath: entry.newPath, newPath: entry.oldPath });
        } else if (entry.source === "local") {
          await invoke("local_rename_path", { oldPath: entry.newPath, newPath: entry.oldPath });
          await loadLocalFiles(localPath);
        } else {
          if (entry.locationId && entry.locationId !== session.locationId) {
            throw new Error("Switch LOCATION back to the Remote this operation happened on before undoing it.");
          }
          const oldName = entry.oldPath.split("/").pop() || entry.oldPath;
          const newParent = entry.newPath.split("/").slice(0, -1).join("/");
          const newName = entry.newPath.split("/").pop() || entry.newPath;
          const response = await api("/api/files/rename", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ oldName: newName, newName: oldName, currentPath: newParent }),
          });
          if (!response.ok) throw new Error(await readError(response));
        }
        setUndoStack((current) => current.slice(0, -1));
        // Only refresh the REMOTE listing for entries that actually
        // happened on REMOTE (ssh/api) -- the "local" branch above already
        // refreshed LOCAL itself via loadLocalFiles(). Calling loadFiles()
        // unconditionally here used to throw ("builder error: empty host")
        // whenever there was no active API-Remote session, which made a
        // LOCAL undo that had *already succeeded* get logged and reported
        // as "failed" purely because of this unrelated, unnecessary REMOTE
        // refresh.
        if (entry.source !== "local") await loadFiles(path);
        writeOperationLog("undo", "completed", sourceLabel, destinationLabel, `Undone: ${entry.description}`);
        notify(`Undone: ${entry.description}`);
      } catch (error) {
        writeOperationLog("undo", "failed", sourceLabel, destinationLabel, `Failed to undo "${entry.description}": ${describeError(error)}`, "ERROR");
        throw error;
      }
    });


  const moveItems = (items: FileItem[], destination: string, source = dragSourceRef.current) =>
    run(async () => {
      if (source === "local") {
        uploadLocalItemsToRemote(items, destination);
        return;
      }
      if (!isValidMoveTarget(items, destination))
        throw new Error(
          "Choose a folder other than the current folder or a folder inside a selected folder.",
        );
      const sourceLabel = `${items.length} item${items.length === 1 ? "" : "s"}`;
      if (remoteSshEntryId) {
        const profile = findSshProfileById(remoteSshEntryId);
        if (!profile) throw new Error("The SSH connection for this remote view is no longer available.");
        const destinationLabel = `SSH: ${profile.name}:${destination}`;
        try {
          for (const item of items) {
            const newPath = joinSshPath(destination, item.name);
            const finalPath = await invoke<string>("ssh_rename_path", { profile, oldPath: item.path, newPath });
            recordUndoableMove({ source: "ssh", entryId: remoteSshEntryId, oldPath: item.path, newPath: finalPath });
          }
          setDragItems([]);
          setDropTarget(null);
          setContextMenu(null);
          await loadFiles(path);
          writeOperationLog("move", "completed", sourceLabel, destinationLabel, `Moved ${items.length} item(s) through SFTP.`);
          notify(`Moved ${items.length} item${items.length === 1 ? "" : "s"}.`);
        } catch (error) {
          writeOperationLog("move", "failed", sourceLabel, destinationLabel, `Failed to move through SFTP: ${describeError(error)}`, "ERROR");
          throw error;
        }
        return;
      }
      const destinationLabel = `${activeLocation?.displayName || session.locationId || "Remote"}:${destination}`;
      try {
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
        for (const item of items) {
          recordUndoableMove({
            source: "api",
            locationId: session.locationId,
            oldPath: item.path,
            newPath: `${destination.replace(/\/+$/, "")}/${item.name}`,
          });
        }
        setDragItems([]);
        setDropTarget(null);
        setContextMenu(null);
        writeOperationLog("move", "completed", sourceLabel, destinationLabel, `Moved ${items.length} item(s) through the API Remote.`);
        notify(data.message || "Move complete.");
        setFolderTree({
          path: "",
          name: "/",
          expanded: true,
          loaded: false,
          children: [],
        });
        await Promise.all([loadFiles(path), loadTreeChildren("", true)]);
      } catch (error) {
        writeOperationLog("move", "failed", sourceLabel, destinationLabel, `Failed to move through the API Remote: ${describeError(error)}`, "ERROR");
        throw error;
      }
    });


  // LOCAL -> LOCAL move, mirroring `moveItems`'s REMOTE -> REMOTE branch:
  // dragging a LOCAL file/folder onto another LOCAL folder (in the file
  // list/grid) or onto a LOCAL folder-tree node renames it into that
  // folder. `local_rename_path` already avoids overwriting an existing
  // same-named item by auto-appending "_(n)".
  const moveLocalItems = (items: FileItem[], destination: string) =>
    run(async () => {
      if (!isValidMoveTarget(items, destination))
        throw new Error(
          "Choose a folder other than the current folder or a folder inside a selected folder.",
        );
      const sourceLabel = `${items.length} item${items.length === 1 ? "" : "s"} in LOCAL`;
      const destinationLabel = `LOCAL: ~/${destination || ""}`;
      try {
        let lastFinalName = "";
        for (const item of items) {
          const newPath = destination ? `${destination}/${item.name}` : item.name;
          const finalPath = await invoke<string>("local_rename_path", { oldPath: item.path, newPath });
          lastFinalName = finalPath.split("/").pop() || item.name;
          recordUndoableMove({ source: "local", oldPath: item.path, newPath: finalPath });
        }
        setDragItems([]);
        setDropTarget(null);
        setLocalSelected([]);
        writeOperationLog("move", "completed", sourceLabel, destinationLabel, `Moved ${items.length} item(s) in LOCAL.`);
        notify(
          items.length === 1
            ? `Moved ${lastFinalName} in LOCAL.`
            : `Moved ${items.length} items in LOCAL.`,
        );
        await loadLocalFiles(localPath);
        if (destination !== localPath) void loadLocalTreeChildren(destination, true);
      } catch (error) {
        writeOperationLog("move", "failed", sourceLabel, destinationLabel, `Failed to move in LOCAL: ${describeError(error)}`, "ERROR");
        throw error;
      }
    });

  const beginDrag = (event: React.DragEvent, file: FileItem) => {
    const items = selected.includes(file.path) ? selectedItems : [file];
    if (!selected.includes(file.path)) setSelected([file.path]);
    dragItemsRef.current = items;
    dragSourceRef.current = "remote";
    setDragItems(items);
    setDragSource("remote");
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("application/x-filetransfer-source", "remote");
  };

  const beginLocalDrag = (event: React.DragEvent, file: FileItem) => {
    const items = localSelected.includes(file.path) ? localFiles.filter((item) => localSelected.includes(item.path)) : [file];
    if (!localSelected.includes(file.path)) setLocalSelected([file.path]);
    dragItemsRef.current = items;
    dragSourceRef.current = "local";
    setDragItems(items);
    setDragSource("local");
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("application/x-filetransfer-source", "local");
  };

  const resolveDragIcon = () => {
    if (!dragIconPathRef.current) {
      dragIconPathRef.current = resolveResource("icons/32x32.png").catch(() => "");
    }
    return dragIconPathRef.current;
  };

  const beginRemoteDrag = (event: React.DragEvent, file: FileItem) => {
    beginDrag(event, file);
    // Windows native outbound drag is intentionally disabled. The inbound
    // native drop target remains enabled so Explorer -> App uploads continue
    // through Queue, while App -> Explorer uses the stable Download/Queue path
    // instead of the WebView2/OLE plugin that can terminate the window.
    if (!event.altKey) return;
    event.preventDefault();
    setNotice("External drag-out is disabled on Windows for stability. Use Download to save through the Queue.");
    writeOperationLog("drag_out", "skipped", file.name, "External file manager", "Windows outbound native drag is disabled; use Download/Queue instead.", "WARN");
  };

  const prepareRemoteDrag = (file: FileItem) => {
    const items = selected.includes(file.path) ? selectedItems : [file];
    const preparationKey = items.map((item) => item.path).join("\0");
    if (dragPreparationRef.current.has(preparationKey)) return;
    if (remoteSshEntryId) {
      const profile = findSshProfileById(remoteSshEntryId);
      if (!profile) return;
      setNotice(`Preparing ${items.length} selected item${items.length === 1 ? "" : "s"} for drag...`);
      const setId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
      const queueItem: TransferQueueItem = {
        id: setId,
        label: `${items.length} SSH remote item${items.length === 1 ? "" : "s"}`,
        kind: "download",
        paths: items.map((item) => item.path),
        destinationPath: localPath ? `~/${localPath}` : "~/",
        locationId: "",
        locationName: `SSH: ${profile.name}`,
        status: "queued",
        detail: "Waiting to prepare drag transfer.",
        sshEntryId: profile.id,
        sshItems: items,
        localDestinationFolder: localPath,
      };
      const preparation = queueDragPreparation(queueItem, async () => {
        let lastDestination = "";
        for (const item of items) {
          lastDestination = await invoke<string>("ssh_download_to_drag_staging", {
            profile,
            remotePath: item.path,
            isDirectory: item.isDirectory,
            setId,
          });
        }
        if (items.length === 1) return lastDestination;
        const suffixLength = items[items.length - 1].name.length + 1;
        return lastDestination.slice(0, lastDestination.length - suffixLength);
      });
      dragPreparationRef.current.set(preparationKey, preparation);
      return;
    }
    const singleFile = items.length === 1 && !items[0].isDirectory;
    const headers: [string, string][] = session.token
      ? [["Authorization", `Bearer ${session.token}`], ...(session.locationId ? [["X-Location-ID", session.locationId] as [string, string]] : [])]
      : [];
    if (singleFile) {
      const queueItem: TransferQueueItem = {
        id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`,
        label: items[0].name,
        kind: "download",
        paths: [items[0].path],
        destinationPath: localPath ? `~/${localPath}` : "~/",
        locationId: session.locationId,
        locationName: activeLocation?.displayName || session.locationId,
        status: "queued",
        detail: "Waiting to prepare drag transfer.",
        localDestinationFolder: localPath,
      };
      const preparation = queueDragPreparation(queueItem, () => invoke<string>("download_to_drag_staging", {
          url: `${serverUrl(session)}/api/files/download/${downloadPath(items[0].path)}`,
          method: "GET",
          headers,
          body: undefined,
          fileName: items[0].name,
          ignoreTlsErrors: session.ignoreTlsErrors,
        }));
      dragPreparationRef.current.set(preparationKey, preparation);
      return;
    }
    // Multiple files and/or folders: drag out "queue style" -- download each
    // file individually into a reconstructed folder tree in drag-staging,
    // then drag that assembled folder as a single native item, instead of
    // always forcing a tar.gz/zip archive step first.
    setNotice(`Preparing ${items.length} selected item${items.length === 1 ? "" : "s"} for drag...`);
    const setId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
    const setLabel = items.length === 1 ? items[0].name : `${items.length} selected items`;
    // A synthetic wrapper folder is only needed to bundle multiple
    // top-level selections under one draggable item. For a single
    // directory, `entry.relativePath` from /api/files/flatten already
    // starts with that directory's own name -- adding `setLabel` (the same
    // name) on top would nest it inside a duplicate copy of itself.
    const needsWrapper = items.length > 1;
    const queueItem: TransferQueueItem = {
      id: setId,
      label: setLabel,
      kind: "download-set",
      paths: items.map((item) => item.path),
      destinationPath: localPath ? `~/${localPath}` : "~/",
      locationId: session.locationId,
      locationName: activeLocation?.displayName || session.locationId,
      status: "queued",
      detail: "Waiting to prepare drag transfer.",
      localDestinationFolder: localPath,
    };
    const preparation = queueDragPreparation(queueItem, async () => {
      const response = await api("/api/files/flatten", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items.map(({ name, isDirectory, path: itemPath }) => ({ name, isDirectory, path: itemPath })),
          currentPath: path,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json() as { files?: { relativePath: string; remotePath: string }[] };
      const files = data.files || [];
      if (!files.length) throw new Error("The selection has no files to drag out.");
      let lastDestination = "";
      let lastRelativePath = "";
      for (const entry of files) {
        lastRelativePath = needsWrapper ? `${setLabel}/${entry.relativePath}` : entry.relativePath;
        lastDestination = await invoke<string>("download_to_drag_staging_at", {
          url: `${serverUrl(session)}/api/files/download/${downloadPath(entry.remotePath)}`,
          method: "GET",
          headers,
          body: undefined,
          setId,
          relativePath: lastRelativePath,
          ignoreTlsErrors: session.ignoreTlsErrors,
        });
      }
      const topName = needsWrapper ? setLabel : items[0].name;
      const suffixLength = lastRelativePath.length - topName.length;
      return lastDestination.slice(0, lastDestination.length - suffixLength);
    });
    dragPreparationRef.current.set(preparationKey, preparation);
  };

  const finishDrag = () => {
    dragItemsRef.current = [];
    dragSourceRef.current = "";
    setDragItems([]);
    setDragSource("");
    setDropTarget(null);
    setPaneDragHover("");
  };
  const finishDragAfterDrop = () => {
    // Windows WebView2 can emit dragend before React receives the target's
    // drop callback. Keep the source payload alive for one event-loop turn so
    // the drop handler can still start the SFTP transfer.
    window.setTimeout(finishDrag, 0);
  };

  // Pane-wide "drop here" highlighting must only turn on while the pointer
  // is actually over that pane, not just because a compatible drag started
  // somewhere else. `onDragLeave` fires for every child boundary crossed
  // inside the pane too, so it only clears the hover flag once the related
  // target (where the pointer is going) is no longer inside this pane's
  // container -- otherwise the highlight would flicker off while moving
  // over child elements.
  const enterPaneDragHover = (pane: "local" | "remote") => () => {
    setPaneDragHover((current) => (current === pane ? current : pane));
  };
  const leavePaneDragHover = (pane: "local" | "remote") => (event: React.DragEvent) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setPaneDragHover((current) => (current === pane ? "" : current));
  };

  const enqueueQueueDownload = () =>
    void run(async () => {
      if (!selectedItems.length) return;
      const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
      const setLabel = selectedItems.length === 1 ? selectedItems[0].name : `${selectedItems.length} selected items`;
      const response = await api("/api/files/flatten", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: selectedItems.map(({ name, isDirectory, path: itemPath }) => ({ name, isDirectory, path: itemPath })),
          currentPath: path,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json() as { files?: { relativePath: string; remotePath: string; size: number }[] };
      const files = data.files || [];
      if (!files.length) {
        setNotice("The selection has no files to download.");
        return;
      }
      const item: TransferQueueItem = {
        id,
        label: setLabel,
        kind: "download-set",
        paths: [],
        destinationPath: localPath ? `~/${localPath}` : "~",
        locationId: session.locationId,
        locationName: activeLocation?.displayName || session.locationId,
       status: "queued",
       detail: `Waiting to start (${files.length} files)`,
        progress: initialQueueProgress(files.length, files.reduce((sum, file) => sum + file.size, 0)),
        setFiles: files,
        setCompleted: 0,
        localDestinationFolder: localPath,
      };
      setArchiveFormatOpen(false);
      setTransferQueue((current) => [...current, item]);
      setQueueOpen(true);
      void runQueuedDownloadSet(item);
    });

  const enqueueDownload = (archiveFormat: "tar.gz" | "zip") => {
    if (!selectedItems.length) return;
    const singleFile = selectedItems.length === 1 && !selectedItems[0].isDirectory;
    const fileName = singleFile ? selectedItems[0].name : `archive.${archiveFormat}`;
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
    const headers: [string, string][] = session.token
      ? [
          ["Authorization", `Bearer ${session.token}`],
          ...(session.locationId ? [["X-Location-ID", session.locationId] as [string, string]] : []),
          ...(singleFile ? [] : [["Content-Type", "application/json"] as [string, string]]),
        ]
      : [];
    const body = singleFile ? undefined : Array.from(new TextEncoder().encode(JSON.stringify({
      items: selectedItems.map(({ name, isDirectory, path: itemPath }) => ({ name, isDirectory, path: itemPath })),
      currentPath: path,
      locationId: session.locationId,
      format: archiveFormat,
      sessionName: activeManagedWorkspace?.name || "nFterm",
    })));
    const item: TransferQueueItem = {
      id,
      label: singleFile ? selectedItems[0].name : `${selectedItems.length} selected items`,
      kind: "download",
      paths: [],
      destinationPath: localPath ? `~/${localPath}` : "~",
      locationId: session.locationId,
      locationName: activeLocation?.displayName || session.locationId,
       status: "queued",
       detail: "Waiting to start",
       progress: initialQueueProgress(1, singleFile ? selectedItems[0].size : null),
      downloadUrl: singleFile
        ? `${serverUrl(session)}/api/files/download/${downloadPath(selectedItems[0].path)}`
        : `${serverUrl(session)}/api/archive`,
      downloadMethod: singleFile ? "GET" : "POST",
      downloadHeaders: headers,
      downloadBody: body,
      downloadFileName: fileName,
       archiveFormat: singleFile ? undefined : archiveFormat,
      localDestinationFolder: localPath,
    };
    setArchiveFormatOpen(false);
    setTransferQueue((current) => [...current, item]);
    setQueueOpen(true);
    void runQueuedDownload(item);
  };

  const executeQueuedSshDownload = async (item: TransferQueueItem, profile: SshProfile, items: FileItem[]) => {
    const destinationLabel = `LOCAL: ~/${item.localDestinationFolder || ""}`;
    writeOperationLog("download", "started", item.label, destinationLabel, `SSH queued download of ${items.length} item(s) started.`, "DEBUG");
    updateQueueItem(item.id, { status: "running", detail: `Downloading 0/${items.length} items...` });
    let completed = 0;
    let lastDestination = "";
    try {
      for (const file of items) {
        if (isQueueItemCancelled(item.id)) return;
        lastDestination = await invoke<string>("ssh_download_path", {
          profile,
          remotePath: file.path,
          isDirectory: file.isDirectory,
          localDestinationFolder: item.localDestinationFolder || "",
        });
        completed += 1;
        updateQueueItem(item.id, { detail: `Downloading ${completed}/${items.length} items...` });
      }
      updateQueueItem(item.id, { status: "completed", detail: `Downloaded ${completed} item(s) to ${lastDestination.split("/").slice(0, -1).join("/") || destinationLabel}.` });
      writeOperationLog("download", "completed", item.label, destinationLabel, `Downloaded ${completed} item(s) via SFTP.`);
    } catch (error) {
      if (isQueueItemCancelled(item.id)) return;
      const recovery = classifyQueueError(error);
      const detail = recovery.message;
      updateQueueItem(item.id, { status: recovery.needsUserAction ? "needs_user_action" : "failed", detail: `[${recovery.category}] ${detail} (${completed}/${items.length} completed before failing)`, errorCategory: recovery.category });
      writeOperationLog("download", "failed", item.label, destinationLabel, `SSH queued download failed: ${detail}`, "ERROR");
    }
  };

  const queueSchedulerRef = useRef(new QueueScheduler());
  const runOnce = (id: string, execute: () => Promise<void>) => queueSchedulerRef.current.runExclusive(id, execute);
  const runQueuedSshUpload = (item: TransferQueueItem, profile: SshProfile) => runOnce(item.id, () => executeQueuedSshUpload(item, profile));
  const runQueuedUpload = (item: TransferQueueItem) => runOnce(item.id, () => executeQueuedUpload(item));
  const runQueuedDownload = (item: TransferQueueItem) => runOnce(item.id, () => executeQueuedDownload(item));
  const runQueuedDownloadSet = (item: TransferQueueItem) => runOnce(item.id, () => executeQueuedDownloadSet(item));
  const runQueuedSshDownload = (item: TransferQueueItem, profile: SshProfile, items: FileItem[]) => runOnce(item.id, () => executeQueuedSshDownload(item, profile, items));
  const retryDesktopQueueItem = (item: TransferQueueItem) => {
    if (!(["failed", "needs_user_action"] as string[]).includes(item.status)) return;
    cancelledQueueItemsRef.current.delete(item.id);
    const retryItem = { ...item, status: "queued" as const, detail: "Retry queued", finishedAt: undefined };
    updateQueueItem(item.id, retryItem);
    writeOperationLog(item.kind === "upload" ? "upload" : "download", "retry", item.label, item.destinationPath, `Manual retry requested (attempt ${(item.retryCount || 0) + 1}).`, "INFO");
    if (retryItem.sshEntryId) {
      const profile = findSshProfileById(retryItem.sshEntryId);
      if (!profile) {
        updateQueueItem(item.id, { status: "needs_user_action", detail: "The SSH connection for this transfer is no longer available." });
        return;
      }
      void (retryItem.kind === "download" ? runQueuedSshDownload(retryItem, profile, retryItem.sshItems || []) : runQueuedSshUpload(retryItem, profile));
      return;
    }
    void (retryItem.kind === "download" ? runQueuedDownload(retryItem) : retryItem.kind === "download-set" ? runQueuedDownloadSet(retryItem) : runQueuedUpload(retryItem));
  };
  const renderDesktopQueueItem = (item: TransferQueueItem) => (
    <div className="queue-item" key={item.id}>
      <strong>{item.label}</strong>
      <small>{item.locationName} {item.destinationPath || "/"}</small>
      <span className={`queue-status ${item.status}`}>{item.status}</span>
      <span>{item.detail}</span>
      {(item.status === "running" || item.status === "queued" || item.status === "retrying") && (
        <button type="button" onClick={() => cancelQueueItem(item.id)}>Cancel</button>
      )}
      {item.progress && (["running", "queued", "retrying"].includes(item.status)) && (
        <small>{item.progress.completedBytes ? `${formatSize(item.progress.completedBytes)}${item.progress.totalBytes ? ` / ${formatSize(item.progress.totalBytes)}` : ""}` : "Waiting for transfer data"}{formatQueueProgress(item.progress)}</small>
      )}
      {(item.status === "failed" || item.status === "needs_user_action") && (
        <button type="button" onClick={() => retryDesktopQueueItem(item)}>Retry</button>
      )}
      {(["completed", "failed", "cancelled"].includes(item.status)) && (
        <button type="button" onClick={() => removeQueueItem(item.id)}>Remove</button>
      )}
    </div>
  );
  const queueDragPreparation = (
    item: TransferQueueItem,
    prepare: () => Promise<string>,
  ) => {
    let resolvePreparation: (path: string) => void = () => {};
    let rejectPreparation: (error: unknown) => void = () => {};
    const preparation = new Promise<string>((resolve, reject) => {
      resolvePreparation = resolve;
      rejectPreparation = reject;
    });
    setTransferQueue((current) => [...current, item]);
    void runOnce(item.id, async () => {
      updateQueueItem(item.id, { status: "running", detail: "Preparing drag transfer..." });
      try {
        const destination = await prepare();
        resolvePreparation(destination);
        updateQueueItem(item.id, { status: "needs_user_action", detail: "Ready. Drop the file into the external application." });
      } catch (error) {
        rejectPreparation(error);
        updateQueueItem(item.id, { status: "failed", detail: describeError(error), errorCategory: classifyQueueError(error).category });
      }
    });
    return preparation;
  };

  const enqueueSshDownload = () => {
    if (!selectedItems.length) return;
    const profile = findSshProfileById(remoteSshEntryId);
    if (!profile) {
      setNotice("The SSH connection for this remote view is no longer available.");
      return;
    }
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
    const label = selectedItems.length === 1 ? selectedItems[0].name : `${selectedItems.length} selected items`;
    const item: TransferQueueItem = {
      id,
      label,
      kind: "download",
      paths: [],
      destinationPath: localPath ? `~/${localPath}` : "~",
      locationId: "",
      locationName: `SSH: ${profile.name}`,
      status: "queued",
      detail: "Waiting to start",
      sshEntryId: remoteSshEntryId,
      sshItems: selectedItems,
      localDestinationFolder: localPath,
    };
    setTransferQueue((current) => [...current, item]);
    setQueueOpen(true);
    void runQueuedSshDownload(item, profile, selectedItems);
  };

  const download = () => {
    if (remoteSshEntryId) {
      enqueueSshDownload();
      return;
    }
    if (!selectedItems.length) return;
    const singleFile = selectedItems.length === 1 && !selectedItems[0].isDirectory;
    if (!singleFile) {
      setArchiveFormatDraft("tar.gz");
      setArchiveFormatOpen(true);
      return;
    }
    enqueueDownload("tar.gz");
  };

  const openLocalViewer = (filePath: string) =>
    void run(async () => {
      const content = await invoke<string>("read_local_file", { path: filePath });
      setViewerTitle(filePath.split(/[\\/]/).pop() || filePath);
      setViewerContent(content);
      setViewerLocalPath(filePath);
      setViewerRemotePath("");
      setViewerOpen(true);
    });

  const openRemoteViewer = (file: FileItem) =>
    void run(async () => {
      if (file.isDirectory) return;
      const response = await api(`/api/files/content/${downloadPath(file.path)}`);
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as { content?: string };
      setViewerTitle(file.name);
      setViewerContent(data.content || "");
      setViewerLocalPath("");
      setViewerRemotePath(file.path);
      setViewerOpen(true);
    });

  const editViewerFile = () =>
    void run(async () => {
      let localPathForEdit = viewerLocalPath;
      if (!localPathForEdit && viewerRemotePath) {
        const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `edit-${Date.now()}`;
        const item: TransferQueueItem = {
          id,
          label: `Prepare ${viewerTitle} for editing`,
          kind: "download",
          paths: [],
          destinationPath: "~/Downloads",
          locationId: session.locationId,
          locationName: activeLocation?.displayName || session.locationId,
          status: "queued",
          detail: "Waiting to download editor copy",
          downloadUrl: `${serverUrl(session)}/api/files/download/${downloadPath(viewerRemotePath)}`,
          downloadMethod: "GET",
          downloadHeaders: session.token
            ? [["Authorization", `Bearer ${session.token}`], ...(session.locationId ? [["X-Location-ID", session.locationId] as [string, string]] : [])]
            : [],
          downloadFileName: viewerTitle,
          localDestinationFolder: "Downloads",
          progress: initialQueueProgress(1, null),
        };
        queueCompletionHandlersRef.current.set(id, async (destination) => {
          setViewerLocalPath(destination);
          await invoke("edit_local_file", { path: destination });
          notify(`Opened ${viewerTitle} in the default text editor.`);
        });
        if (isQueueItemCancelled(item.id)) return;
        setTransferQueue((current) => [...current, item]);
        setQueueOpen(true);
        void runQueuedDownload(item);
        return;
      }
      if (!localPathForEdit) throw new Error("No local file is available for editing.");
      await invoke("edit_local_file", { path: localPathForEdit });
      notify(`Opened ${viewerTitle} in the default text editor.`);
    });

  const uploadPaths = (paths: string[]) =>
    void run(async () => {
      if (!paths.length) return;
      const summary = await invoke<UploadSummary>("inspect_upload_paths", {
        paths,
      });
      const accepted = window.confirm(
        `Upload ${summary.files} file${summary.files === 1 ? "" : "s"} and ${summary.directories} folder${summary.directories === 1 ? "" : "s"} to ${path ? `/${path}` : "/"}?`,
      );
      if (!accepted) return;
      const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
      if (remoteSshEntryId) {
        const profile = findSshProfileById(remoteSshEntryId);
        if (!profile) throw new Error("The SSH connection for this remote view is no longer available.");
        const item: TransferQueueItem = {
          id,
          label: `${summary.files} files, ${summary.directories} folders`,
          kind: "upload",
          paths,
          destinationPath: path,
          locationId: "",
          locationName: `SSH: ${profile.name}`,
          status: "queued",
          detail: "Waiting to start",
          sshEntryId: remoteSshEntryId,
        };
        setTransferQueue((current) => [...current, item]);
        setQueueOpen(true);
        void runQueuedSshUpload(item, profile);
        return;
      }
      const item: TransferQueueItem = {
        id,
        label: `${summary.files} files, ${summary.directories} folders`,
        kind: "upload",
        paths,
        destinationPath: path,
        locationId: session.locationId,
        locationName: activeLocation?.displayName || session.locationId,
        status: "queued",
        detail: "Waiting to start",
      };
      setTransferQueue((current) => [...current, item]);
      setQueueOpen(true);
      void runQueuedUpload(item);
    });

  const downloadRemoteItemsToLocal = (items: FileItem[], destination: string = localPath) =>
    void run(async () => {
      if (!items.length) {
        writeOperationLog(
          "download",
          "skipped",
          "REMOTE",
          `LOCAL: ~/${destination || ""}`,
          "No items were detected in the drag payload; nothing was downloaded.",
          "WARN",
        );
        setNotice("No items were detected for this drag; nothing was downloaded.");
        return;
      }
      if (remoteSshEntryId) {
        const profile = findSshProfileById(remoteSshEntryId);
        if (!profile) throw new Error("The SSH connection for this remote view is no longer available.");
        writeOperationLog(
          "download",
          "started",
          `SSH: ${profile.name}`,
          `LOCAL: ~/${destination || ""}`,
          `Drag-downloading ${items.length} item(s) from SSH to LOCAL.`,
          "DEBUG",
        );
        const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
        const queueItem: TransferQueueItem = {
          id,
          label: `${items.length} selected items`,
          kind: "download",
          paths: [],
          destinationPath: destination ? `~/${destination}` : "~",
          locationId: remoteSshEntryId,
          locationName: profile.name,
          status: "queued",
          detail: "Waiting to start",
          localDestinationFolder: destination,
          sshEntryId: profile.id,
          sshItems: items,
        };
        setTransferQueue((current) => [...current, queueItem]);
        setQueueOpen(true);
        finishDrag();
        void runQueuedSshDownload(queueItem, profile, items).then(async () => {
          await loadLocalFiles(localPath);
          if (destination !== localPath) void loadLocalTreeChildren(destination, true);
        });
        return;
      }
      // API Remote (not SSH): reuse the same flatten + queued-download
      // machinery the "Download" button/queue already relies on
      // (`runQueuedDownload`/`runQueuedDownloadSet`), so single files,
      // folders, and multi-selects all preserve relative directory
      // structure and get the same progress/collision handling as a
      // button-triggered download, just targeting the drop destination
      // instead of whatever the LOCAL pane happens to be browsing.
      const destinationLabel = `LOCAL: ~/${destination || ""}`;
      if (!locationOnline || !hasCapability("read")) {
        writeOperationLog(
          "download",
          "skipped",
          `${activeLocation?.displayName || session.locationId || "Remote"}`,
          destinationLabel,
          "The active API Remote is offline or does not allow downloads.",
          "WARN",
        );
        setNotice("The active REMOTE is offline or doesn't allow downloads right now.");
        return;
      }
      const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
      const singleFile = items.length === 1 && !items[0].isDirectory;
      if (singleFile) {
        const headers: [string, string][] = session.token
          ? [["Authorization", `Bearer ${session.token}`], ...(session.locationId ? [["X-Location-ID", session.locationId] as [string, string]] : [])]
          : [];
        const queueItem: TransferQueueItem = {
          id,
          label: items[0].name,
          kind: "download",
          paths: [],
          destinationPath: destination ? `~/${destination}` : "~",
          locationId: session.locationId,
          locationName: activeLocation?.displayName || session.locationId,
          status: "queued",
          detail: "Waiting to start",
          downloadUrl: `${serverUrl(session)}/api/files/download/${downloadPath(items[0].path)}`,
          downloadMethod: "GET",
          downloadHeaders: headers,
          downloadFileName: items[0].name,
          localDestinationFolder: destination,
        };
        setTransferQueue((current) => [...current, queueItem]);
        setQueueOpen(true);
        finishDrag();
        writeOperationLog("download", "started", `${activeLocation?.displayName || session.locationId || "Remote"}`, destinationLabel, `Drag-downloading ${items[0].name} from the API Remote to LOCAL.`, "DEBUG");
        void runQueuedDownload(queueItem);
        return;
      }
      const setLabel = items.length === 1 ? items[0].name : `${items.length} selected items`;
      try {
        const response = await api("/api/files/flatten", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: items.map(({ name, isDirectory, path: itemPath }) => ({ name, isDirectory, path: itemPath })),
            currentPath: path,
          }),
        });
        if (!response.ok) throw new Error(await readError(response));
        const data = await response.json() as { files?: { relativePath: string; remotePath: string; size: number }[] };
        const files = data.files || [];
        if (!files.length) {
          setNotice("The selection has no files to download.");
          return;
        }
        const queueItem: TransferQueueItem = {
          id,
          label: setLabel,
          kind: "download-set",
          paths: [],
          destinationPath: destination ? `~/${destination}` : "~",
          locationId: session.locationId,
          locationName: activeLocation?.displayName || session.locationId,
          status: "queued",
          detail: `Waiting to start (${files.length} files)`,
          setFiles: files,
          setCompleted: 0,
          localDestinationFolder: destination,
        };
        setTransferQueue((current) => [...current, queueItem]);
        setQueueOpen(true);
        finishDrag();
        writeOperationLog("download", "started", `${activeLocation?.displayName || session.locationId || "Remote"}`, destinationLabel, `Drag-downloading ${files.length} file(s) from the API Remote to LOCAL.`, "DEBUG");
        void runQueuedDownloadSet(queueItem);
      } catch (error) {
        writeOperationLog(
          "download",
          "failed",
          `${activeLocation?.displayName || session.locationId || "Remote"}`,
          destinationLabel,
          `Failed to prepare drag download from the API Remote: ${describeError(error)}`,
          "ERROR",
        );
        throw error;
      }
    });

  const uploadLocalItemsToRemote = (items: FileItem[], destination: string) =>
    void run(async () => {
      if (!items.length) {
        writeOperationLog(
          "upload",
          "skipped",
          `LOCAL: ~/${localPath || ""}`,
          "REMOTE",
          "No items were detected in the drag payload; nothing was uploaded.",
          "WARN",
        );
        setNotice("No items were detected for this drag; nothing was uploaded.");
        return;
      }
      if (remoteSshEntryId) {
        const profile = findSshProfileById(remoteSshEntryId);
        if (!profile) throw new Error("The SSH connection for this remote view is no longer available.");
        writeOperationLog(
          "upload",
          "started",
          `LOCAL: ~/${localPath || ""}`,
          `SSH: ${profile.name}:${destination}`,
          `Drag-uploading ${items.length} item(s) from LOCAL to SSH.`,
          "DEBUG",
        );
        const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
        const queueItem: TransferQueueItem = {
          id,
          label: `${items.length} selected items`,
          kind: "upload",
          paths: items.map((item) => item.path),
          destinationPath: destination,
          locationId: remoteSshEntryId,
          locationName: profile.name,
          status: "queued",
          detail: "Waiting to start",
          sshEntryId: profile.id,
        };
        setTransferQueue((current) => [...current, queueItem]);
        setQueueOpen(true);
        finishDrag();
        void runQueuedSshUpload(queueItem, profile);
        return;
      }
      // API Remote (not SSH): reuse the exact same queued-upload machinery
      // the button-based Upload already relies on (`runQueuedUpload`) so
      // drag transfer gets the same multipart batching, progress polling,
      // and collision handling instead of a second, divergent code path.
      const destinationLabel = `${activeLocation?.displayName || session.locationId || "Remote"}:${destination || "/"}`;
      if (!locationOnline || !hasCapability("upload")) {
        writeOperationLog(
          "upload",
          "skipped",
          `LOCAL: ~/${localPath || ""}`,
          destinationLabel,
          "The active API Remote is offline or does not allow uploads.",
          "WARN",
        );
        setNotice("The active REMOTE is offline or doesn't allow uploads right now.");
        return;
      }
      const summary = await invoke<UploadSummary>("inspect_upload_paths", {
        paths: items.map((item) => item.path),
      });
      const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
      const queueItem: TransferQueueItem = {
        id,
        label: `${summary.files} files, ${summary.directories} folders`,
        kind: "upload",
        paths: items.map((item) => item.path),
        destinationPath: destination,
        locationId: session.locationId,
        locationName: activeLocation?.displayName || session.locationId,
        status: "queued",
        detail: "Waiting to start",
      };
      setTransferQueue((current) => [...current, queueItem]);
      setQueueOpen(true);
      finishDrag();
      writeOperationLog(
        "upload",
        "started",
        `LOCAL: ~/${localPath || ""}`,
        destinationLabel,
        `Drag-uploading ${items.length} item(s) from LOCAL to the API Remote.`,
        "DEBUG",
      );
      void runQueuedUpload(queueItem);
    });

  const upload = async () =>
    uploadPaths(await invoke<string[]>("pick_upload_files"));

  useEffect(() => {
    // Windows enables Tauri's native drop target through
    // tauri.windows.conf.json so Explorer drops arrive here and use the same
    // Queue upload path. Linux keeps the native target disabled because its
    // WebKitGTK integration can intercept the in-app HTML5 drag surface.
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
  }, [session.token, path, session.ignoreTlsErrors, remoteSshEntryId]);

  const createFolder = () =>
    run(async () => {
      const folderName = window.prompt("Folder name");
      if (!folderName?.trim()) return;
      const name = folderName.trim();
      if (splitMode && activePane === "local") {
        const fullPath = localPath ? `${localPath}/${name}` : name;
        try {
          await invoke("local_create_directory", { path: fullPath });
          await loadLocalFiles(localPath);
          writeOperationLog("create_folder", "completed", `LOCAL: ~/${localPath || ""}`, `LOCAL: ~/${fullPath}`, `Created folder ${name} in LOCAL.`);
          notify(`Created ${name} in LOCAL.`);
        } catch (error) {
          writeOperationLog("create_folder", "failed", `LOCAL: ~/${localPath || ""}`, `LOCAL: ~/${fullPath}`, `Failed to create folder ${name} in LOCAL: ${describeError(error)}`, "ERROR");
          throw error;
        }
        return;
      }
      if (remoteSshEntryId) {
        const profile = findSshProfileById(remoteSshEntryId);
        if (!profile) throw new Error("The SSH connection for this remote view is no longer available.");
        const fullPath = path ? joinSshPath(path, name) : `/${name}`;
        try {
          await invoke("ssh_create_directory", { profile, path: fullPath });
          await loadFiles(path);
          writeOperationLog("create_folder", "completed", `SSH: ${profile.name}:${path || "/"}`, `SSH: ${profile.name}:${fullPath}`, `Created folder ${name} through SFTP.`);
          notify(`Created ${name}.`);
        } catch (error) {
          writeOperationLog("create_folder", "failed", `SSH: ${profile.name}:${path || "/"}`, `SSH: ${profile.name}:${fullPath}`, `Failed to create folder ${name} through SFTP: ${describeError(error)}`, "ERROR");
          throw error;
        }
        return;
      }
      const destinationLabel = `${activeLocation?.displayName || session.locationId || "Remote"}:${path || "/"}`;
      try {
        const response = await api("/api/folders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            folderName: name,
            currentPath: path,
          }),
        });
        if (!response.ok) throw new Error(await readError(response));
        await loadFiles(path);
        writeOperationLog("create_folder", "completed", destinationLabel, `${destinationLabel}/${name}`, `Created folder ${name} through the API Remote.`);
        notify(`Created ${name}.`);
      } catch (error) {
        writeOperationLog("create_folder", "failed", destinationLabel, `${destinationLabel}/${name}`, `Failed to create folder ${name} through the API Remote: ${describeError(error)}`, "ERROR");
        throw error;
      }
    });


  const rename = () =>
    run(async () => {
      if (splitMode && activePane === "local") {
        if (localSelectedItems.length !== 1) return;
        const item = localSelectedItems[0];
        const newName = window.prompt("New name", item.name);
        if (!newName?.trim() || newName === item.name) return;
        const trimmedName = newName.trim();
        const parent = item.path.split("/").slice(0, -1).join("/");
        const newPath = parent ? `${parent}/${trimmedName}` : trimmedName;
        try {
          const finalPath = await invoke<string>("local_rename_path", { oldPath: item.path, newPath });
          recordUndoableRename({ source: "local", oldPath: item.path, newPath: finalPath });
          await loadLocalFiles(localPath);
          writeOperationLog("rename", "completed", `LOCAL: ~/${item.path}`, `LOCAL: ~/${finalPath}`, `Renamed ${item.name} to ${finalPath.split("/").pop()} in LOCAL.`);
          notify(`Renamed ${item.name} to ${finalPath.split("/").pop()} in LOCAL.`);
        } catch (error) {
          writeOperationLog("rename", "failed", `LOCAL: ~/${item.path}`, `LOCAL: ~/${newPath}`, `Failed to rename ${item.name} in LOCAL: ${describeError(error)}`, "ERROR");
          throw error;
        }
        return;
      }
      if (selectedItems.length !== 1) return;
      const item = selectedItems[0];
      const newName = window.prompt("New name", item.name);
      if (!newName?.trim() || newName === item.name) return;
      const trimmedName = newName.trim();
      if (remoteSshEntryId) {
        const profile = findSshProfileById(remoteSshEntryId);
        if (!profile) throw new Error("The SSH connection for this remote view is no longer available.");
        const newPath = joinSshPath(sshParentPath(item.path), trimmedName);
        try {
          const finalPath = await invoke<string>("ssh_rename_path", { profile, oldPath: item.path, newPath });
          recordUndoableRename({ source: "ssh", entryId: remoteSshEntryId, oldPath: item.path, newPath: finalPath });
          await loadFiles(path);
          writeOperationLog("rename", "completed", `SSH: ${profile.name}:${item.path}`, `SSH: ${profile.name}:${finalPath}`, `Renamed ${item.name} to ${finalPath.split("/").pop()} through SFTP.`);
          notify(`Renamed ${item.name} to ${finalPath.split("/").pop()}.`);
        } catch (error) {
          writeOperationLog("rename", "failed", `SSH: ${profile.name}:${item.path}`, `SSH: ${profile.name}:${newPath}`, `Failed to rename ${item.name} through SFTP: ${describeError(error)}`, "ERROR");
          throw error;
        }
        return;
      }
      const sourceLabel = `${activeLocation?.displayName || session.locationId || "Remote"}:${item.path}`;
      const newFullPath = path ? `${path}/${trimmedName}` : trimmedName;
      try {
        const response = await api("/api/files/rename", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            oldName: item.name,
            newName: trimmedName,
            currentPath: path,
          }),
        });
        if (!response.ok) throw new Error(await readError(response));
        recordUndoableRename({ source: "api", locationId: session.locationId, oldPath: item.path, newPath: newFullPath });
        await loadFiles(path);
        writeOperationLog("rename", "completed", sourceLabel, `${activeLocation?.displayName || session.locationId || "Remote"}:${newFullPath}`, `Renamed ${item.name} to ${trimmedName} through the API Remote.`);
        notify(`Renamed ${item.name}.`);
      } catch (error) {
        writeOperationLog("rename", "failed", sourceLabel, `${activeLocation?.displayName || session.locationId || "Remote"}:${newFullPath}`, `Failed to rename ${item.name} through the API Remote: ${describeError(error)}`, "ERROR");
        throw error;
      }
    });

  const remove = () =>
    run(async () => {
      if (splitMode && activePane === "local") {
        if (
          !localSelectedItems.length ||
          (desktopSettings.confirmations.delete && !window.confirm(
            `Delete ${localSelectedItems.length} selected LOCAL item${localSelectedItems.length === 1 ? "" : "s"}? This cannot be undone.`,
          ))
        )
          return;
        const sourceLabel = `${localSelectedItems.length} selected item${localSelectedItems.length === 1 ? "" : "s"}`;
        const destinationLabel = `LOCAL: ~/${localPath || ""}`;
        try {
          for (const item of localSelectedItems) {
            await invoke("local_delete_path", { path: item.path, isDirectory: item.isDirectory });
          }
          await loadLocalFiles(localPath);
          writeOperationLog("delete", "completed", sourceLabel, destinationLabel, "Deleted in LOCAL. This cannot be undone.");
          notify("Deleted selected LOCAL items. This cannot be undone.");
        } catch (error) {
          writeOperationLog("delete", "failed", sourceLabel, destinationLabel, `Failed to delete in LOCAL: ${describeError(error)}`, "ERROR");
          throw error;
        }
        return;
      }
      if (
        !selectedItems.length ||
        (desktopSettings.confirmations.delete && !window.confirm(
          `Delete ${selectedItems.length} selected item${selectedItems.length === 1 ? "" : "s"}? This cannot be undone.`,
        ))
      )
        return;
      const sourceLabel = `${selectedItems.length} selected item${selectedItems.length === 1 ? "" : "s"}`;
      if (remoteSshEntryId) {
        const profile = findSshProfileById(remoteSshEntryId);
        if (!profile) throw new Error("The SSH connection for this remote view is no longer available.");
        const destinationLabel = `SSH: ${profile.name}:${path || "/"}`;
        try {
          for (const item of selectedItems) {
            await invoke("ssh_delete_path", { profile, path: item.path, isDirectory: item.isDirectory });
          }
          await loadFiles(path);
          writeOperationLog("delete", "completed", sourceLabel, destinationLabel, "Deleted through SFTP. This cannot be undone.");
          notify("Deleted selected items. This cannot be undone.");
        } catch (error) {
          writeOperationLog("delete", "failed", sourceLabel, destinationLabel, `Failed to delete through SFTP: ${describeError(error)}`, "ERROR");
          throw error;
        }
        return;
      }
      const destinationLabel = `${activeLocation?.displayName || session.locationId || "Remote"}:${path || "/"}`;
      try {
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
        writeOperationLog("delete", "completed", sourceLabel, destinationLabel, "Deleted through the API Remote. This cannot be undone.");
        notify("Deleted selected items. This cannot be undone.");
      } catch (error) {
        writeOperationLog("delete", "failed", sourceLabel, destinationLabel, `Failed to delete through the API Remote: ${describeError(error)}`, "ERROR");
        throw error;
      }
    });

  const createShareLink = (password?: string) =>
    run(async () => {
      ensureApiRemote();
      if (selectedItems.length !== 1 || selectedItems[0].isDirectory) return;
      const item = selectedItems[0];
      const sourceLabel = `${activeLocation?.displayName || session.locationId || "Remote"}:${item.path}`;
      try {
        const expiresIn = desktopSettings.shareLinkExpirationDays > 0
          ? desktopSettings.shareLinkExpirationDays * 86400
          : undefined;
        const response = await api("/api/files/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            locationId: session.locationId,
            filePath: item.path,
            ...(expiresIn ? { expiresIn } : {}),
            ...(password ? { password } : {}),
          }),
        });
        if (!response.ok) throw new Error(await readError(response));
        const data = (await response.json()) as ShareResponse;
        // "direct" mode returns a plain URL that streams the file straight
        // from the server with no page in between and no Authorization/JWT
        // header required, for tools that only accept a bare link (e.g. a
        // BMC firmware page). "secure" mode returns the share.html page
        // link, which supports the optional password set above.
        const url =
          desktopSettings.shareLinkMode === "direct"
            ? data.data?.directDownloadFullUrl ||
              (data.data?.directDownloadUrl ? `${serverUrl(session)}${data.data.directDownloadUrl}` : "")
            : data.data?.fullUrl ||
              (data.data?.shareUrl ? `${serverUrl(session)}${data.data.shareUrl}` : "");
        if (!url) throw new Error("The server did not return a share link.");
        setShareUrl(url);
        setSharePasswordOpen(false);
        setSharePasswordDraft("");
        writeOperationLog("share", "completed", sourceLabel, "Public share link", `Created a share link for ${item.name}.`);
        notify("Share link created.");
      } catch (error) {
        writeOperationLog("share", "failed", sourceLabel, "Public share link", `Failed to create a share link for ${item.name}: ${describeError(error)}`, "ERROR");
        throw error;
      }
    });

  const loadShareLinks = async () => {
    if (!session.token || session.onlyTerminalMode) return;
    setShareLinksLoading(true);
    try {
      const response = await api("/api/files/shares");
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as { data?: ShareLink[] };
      setShareLinks(data.data || []);
    } finally {
      setShareLinksLoading(false);
    }
  };

  const openShareLinks = () => {
    setShareLinksOpen(true);
    void loadShareLinks();
  };

  const shareLinkUrl = (link: ShareLink, kind: "secure" | "direct") => {
    const relative = kind === "direct" ? link.directDownloadUrl : link.shareUrl;
    return relative ? `${serverUrl(session)}${relative}` : "";
  };

  const copyManagedShareLink = async (link: ShareLink, kind: "secure" | "direct") => {
    const url = shareLinkUrl(link, kind);
    if (!url) throw new Error("The server did not return this share link URL.");
    await navigator.clipboard.writeText(url);
    notify(`${kind === "direct" ? "Direct" : "Secure"} link copied.`);
  };

  const revokeManagedShareLink = (shareToken: string) =>
    run(async () => {
      if (!window.confirm("Revoke this share link? Existing downloads will stop working.")) return;
      const response = await api(`/api/files/share/${encodeURIComponent(shareToken)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      await loadShareLinks();
      notify("Share link revoked.");
    });

  const share = () => {
    if (selectedItems.length !== 1 || selectedItems[0].isDirectory) return;
    if (desktopSettings.shareLinkMode === "secure") {
      // The web UI's equivalent flow also lets the user set a password at
      // share time (it's per-link, not a global default), so ask here too
      // instead of always sharing without one.
      setSharePasswordDraft("");
      setSharePasswordOpen(true);
      return;
    }
    void createShareLink();
  };


  // .zip compression/extraction. LOCAL archives use the active Session name
  // and local timestamp; Rust adds the collision suffix without prompting.
  const compressLocalItems = () =>
    run(async () => {
      if (!localSelectedItems.length) return;
      const archiveName = sessionArchiveName(activeManagedWorkspace?.name || "nFterm");
      const sourceLabel = `${localSelectedItems.length} selected item${localSelectedItems.length === 1 ? "" : "s"} in LOCAL`;
      const destinationLabel = `LOCAL: ~/${localPath || ""}`;
      try {
        const finalName = await invoke<string>("local_compress_paths", {
          paths: localSelectedItems.map((item) => item.path),
          destinationFolder: localPath,
          archiveName,
        });
        await loadLocalFiles(localPath);
        writeOperationLog("compress", "completed", sourceLabel, destinationLabel, `Created ${finalName} in LOCAL.`);
        notify(`Created ${finalName} in LOCAL.`);
      } catch (error) {
        writeOperationLog("compress", "failed", sourceLabel, destinationLabel, `Failed to create archive in LOCAL: ${describeError(error)}`, "ERROR");
        throw error;
      }
    });

  const extractLocalArchive = () =>
    run(async () => {
      if (localSelectedItems.length !== 1) return;
      const item = localSelectedItems[0];
      const sourceLabel = `LOCAL: ~/${item.path}`;
      const destinationLabel = `LOCAL: ~/${localPath || ""}`;
      try {
        const finalName = await invoke<string>("local_extract_archive", {
          path: item.path,
          destinationFolder: localPath,
        });
        await loadLocalFiles(localPath);
        writeOperationLog("extract", "completed", sourceLabel, destinationLabel, `Extracted ${item.name} to ${finalName} in LOCAL.`);
        notify(`Extracted to ${finalName} in LOCAL.`);
      } catch (error) {
        writeOperationLog("extract", "failed", sourceLabel, destinationLabel, `Failed to extract ${item.name} in LOCAL: ${describeError(error)}`, "ERROR");
        throw error;
      }
    });

  const compressRemoteItems = () =>
    run(async () => {
      if (!selectedItems.length || !remoteSshEntryId) return;
      const profile = findSshProfileById(remoteSshEntryId);
      if (!profile) throw new Error("The SSH connection for this remote view is no longer available.");
      const defaultName = selectedItems.length === 1
        ? selectedItems[0].name.replace(/\.[^./]+$/, "")
        : "Archive";
      const archiveName = window.prompt("Archive name", defaultName);
      if (!archiveName?.trim()) return;
      const sourceLabel = `${selectedItems.length} selected item${selectedItems.length === 1 ? "" : "s"}`;
      const destinationLabel = `SSH: ${profile.name}:${path || "/"}`;
      try {
        const finalName = await invoke<string>("ssh_compress_paths", {
          profile,
          paths: selectedItems.map((item) => item.path),
          destinationFolder: path,
          archiveName: archiveName.trim(),
        });
        await loadFiles(path);
        writeOperationLog("compress", "completed", sourceLabel, destinationLabel, `Created ${finalName} through SFTP.`);
        notify(`Created ${finalName}.`);
      } catch (error) {
        writeOperationLog("compress", "failed", sourceLabel, destinationLabel, `Failed to create archive through SFTP: ${describeError(error)}`, "ERROR");
        throw error;
      }
    });

  const extractRemoteArchive = () =>
    run(async () => {
      if (selectedItems.length !== 1 || !remoteSshEntryId) return;
      const profile = findSshProfileById(remoteSshEntryId);
      if (!profile) throw new Error("The SSH connection for this remote view is no longer available.");
      const item = selectedItems[0];
      const sourceLabel = `SSH: ${profile.name}:${item.path}`;
      const destinationLabel = `SSH: ${profile.name}:${path || "/"}`;
      try {
        const finalName = await invoke<string>("ssh_extract_archive", {
          profile,
          path: item.path,
          destinationFolder: path,
        });
        await loadFiles(path);
        writeOperationLog("extract", "completed", sourceLabel, destinationLabel, `Extracted ${item.name} to ${finalName} through SFTP.`);
        notify(`Extracted to ${finalName}.`);
      } catch (error) {
        writeOperationLog("extract", "failed", sourceLabel, destinationLabel, `Failed to extract ${item.name} through SFTP: ${describeError(error)}`, "ERROR");
        throw error;
      }
    });


  const isZipFile = (item: FileItem) => !item.isDirectory && /\.zip$/i.test(item.name);

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
      onlyTerminalMode: false,
    }));
  };

  const renderTreeNode = (node: FolderNode) => (
    <div className="folder-tree" key={node.path}>
      <div
        className={`tree-node ${path === node.path ? "active" : ""} ${dropTarget === node.path ? "drop-target" : ""}`}
        onDragOver={(event) => {
          if (canDropOnRemote(node.path)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget(node.path);
            scheduleTreeExpand(node);
            handleDragAutoScroll(event, folderTreeRef.current);
          }
        }}
        onDragLeave={(event) => {
          // `dragleave` fires the instant the pointer crosses onto this
          // row's own child buttons (tree-toggle/tree-folder), which live
          // inside this same `tree-node` div -- without this check
          // `dropTarget` (and the "Move here" label) would flicker off
          // almost immediately while hovering, since the row is mostly
          // covered by those buttons.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDropTarget(null);
          window.clearTimeout(dragExpandTimerRef.current);
        }}
        onDropCapture={(event) => {
          event.preventDefault();
          event.stopPropagation();
          stopDragAutoScroll();
          const items = dragItemsRef.current;
          const source = dragSourceRef.current;
          finishDrag();
          void moveItems(items, node.path, source);
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

  const toggleSplitMode = () => {
    const nextMode = !splitMode;
    setSplitMode(nextMode);
    if (nextMode && !localTrees[0].loaded) {
      void run(() => loadLocalTreeChildren("", true));
    }
    if (!nextMode) {
      // The LOCAL pane (and its breadcrumb) only exists while split mode is
      // on; leaving split mode with activePane still "local" would strand
      // the top breadcrumb showing an now-invisible LOCAL path.
      setActivePane("remote");
    }
  };

  const renderLocalTreeNode = (node: FolderNode): React.ReactNode => (
    <div className="folder-tree" key={node.path}>
      <div
        className={`tree-node ${localPath === node.path ? "active" : ""} ${dropTarget === node.path ? "drop-target" : ""}`}
        onDragOver={(event) => {
          if (dragSourceRef.current === "remote" && canDragRemoteToLocal && dragItemsRef.current.length) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDropTarget(node.path);
            scheduleLocalTreeExpand(node);
            handleDragAutoScroll(event, localFolderTreeRef.current);
          } else if (dragSourceRef.current === "local" && isValidMoveTarget(dragItemsRef.current, node.path)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget(node.path);
            scheduleLocalTreeExpand(node);
            handleDragAutoScroll(event, localFolderTreeRef.current);
          }
        }}
        onDragLeave={(event) => {
          // Same fix as the REMOTE tree above: don't clear `dropTarget`
          // when the pointer only moved onto this row's own tree-toggle/
          // tree-folder buttons.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDropTarget(null);
          window.clearTimeout(dragExpandTimerRef.current);
        }}
        onDropCapture={(event) => {
          if (dragSourceRef.current === "remote" && canDragRemoteToLocal) {
            event.preventDefault();
            event.stopPropagation();
            stopDragAutoScroll();
            setDropTarget(null);
            const items = dragItemsRef.current;
            downloadRemoteItemsToLocal(items, node.path);
          } else if (dragSourceRef.current === "local") {
            event.preventDefault();
            event.stopPropagation();
            stopDragAutoScroll();
            setDropTarget(null);
            const items = dragItemsRef.current;
            void moveLocalItems(items, node.path);
          }
        }}
      >
        <button
          className="tree-toggle"
          aria-label={`${node.expanded ? "Collapse" : "Expand"} ${node.name}`}
          onClick={() => toggleLocalFolder(node)}
        >
          {node.expanded ? "−" : "+"}
        </button>
        <button
          className="tree-folder"
          onClick={() => void run(() => loadLocalFiles(node.path))}
        >
          <span className="folder-mini" />
          {node.name}
        </button>
        {dragItems.length > 0 && dropTarget === node.path && (
          <span className="drop-label">{dragSource === "remote" ? "Download here" : "Move here"}</span>
        )}
      </div>
      {node.expanded && (
        <div className="tree-children">
          {node.loaded ? (
            node.children.map(renderLocalTreeNode)
          ) : (
            <span className="tree-loading">Loading folders...</span>
          )}
        </div>
      )}
    </div>
  );

  const renderLocalPane = () => (
    <section
      className={`local-pane ${activePane === "local" ? "active-pane" : ""} ${isLocalElevated ? "privileged" : ""}`}
      aria-label="Local files"
      style={{ flexBasis: `${localPaneWidth}px` }}
      onMouseDownCapture={() => setActivePane("local")}
    >
      <div className="local-pane-heading">
        <span className="sidebar-label">
          LOCAL
          {isLocalElevated && (
            <span className="privileged-badge" title="Running elevated: LOCAL is not confined to your home directory.">
              {" "}⚠ ROOT
            </span>
          )}
        </span>
        <strong>{isAbsoluteLocalPath(localPath) ? localPath : localPath ? `~/${localPath}` : "~/"}</strong>
      </div>
      <div className="local-pane-actions">
        <button onClick={() => void run(refreshLocalFiles)} disabled={busy}>
          Refresh
        </button>
        <button onClick={() => void run(() => loadLocalFiles(""))} disabled={busy}>
          Home
        </button>
        <button
          className={`local-tree-toggle ${localTreeOpen ? "active" : ""}`}
          onClick={() => setLocalTreeOpen((open) => !open)}
          aria-pressed={localTreeOpen}
          aria-label={localTreeOpen ? "Hide folder tree" : "Show folder tree"}
          title={localTreeOpen ? "Hide folder tree" : "Show folder tree"}
        >
          {localTreeOpen ? "‹" : "›"}
        </button>
        <span className="view-switch">
          <button
            className={localViewMode === "details" ? "active" : ""}
            onClick={() => setLocalViewMode("details")}
          >
            Details
          </button>
          <button
            className={localViewMode === "grid" ? "active" : ""}
            onClick={() => setLocalViewMode("grid")}
          >
            Grid
          </button>
        </span>
      </div>
      <div
        className={`local-pane-body ${dragSource === "remote" && canDragRemoteToLocal && paneDragHover === "local" ? "drop-target" : ""}`}
        onDragEnter={enterPaneDragHover("local")}
        onDragOver={(event) => {
          if (dragSourceRef.current === "remote" && canDragRemoteToLocal && dragItemsRef.current.length) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDragLeave={leavePaneDragHover("local")}
        onDropCapture={(event) => {
          // If the drop landed on a folder-tree node inside the LOCAL tree
          // panel, let it fall through to that node's own onDropCapture
          // (which downloads into that specific folder) instead of always
          // downloading into the currently browsed `localPath` here.
          if ((event.target as HTMLElement).closest(".local-pane-tree")) return;
          if (dragSourceRef.current === "remote" && canDragRemoteToLocal) {
            event.preventDefault();
            event.stopPropagation();
            setPaneDragHover("");
            downloadRemoteItemsToLocal(dragItemsRef.current);
          }
        }}
      >
        {localTreeOpen && (
          <>
            <div
              className="local-pane-tree"
              ref={localFolderTreeRef}
              style={{ flexBasis: `${localTreeWidth}px` }}
              onDragLeave={stopDragAutoScroll}
              onDrop={stopDragAutoScroll}
            >
              {localTrees.map(renderLocalTreeNode)}
            </div>
            <div
              className="pane-resize-handle"
              onPointerDown={beginLocalTreeResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize LOCAL folder tree"
            />
          </>
        )}
        {localViewMode === "grid" ? (
          <div
            className="file-grid local-file-grid"
            ref={localFileListRef}
            onMouseDown={(event) => beginMarqueeSelect(event, "local", localFileListRef.current)}
          >
            {showLocalUp() && (
              <article
                className={`file-tile file-tile-dotdot ${dropTarget === localParentPath(localPath) ? "drop-target" : ""}`}
                onDragOver={(event) => {
                  if (dragSourceRef.current === "local" && isValidMoveTarget(dragItemsRef.current, localParentPath(localPath))) {
                    event.preventDefault();
                    setDropTarget(localParentPath(localPath));
                  }
                }}
                onDrop={(event) => {
                  if (dragSourceRef.current === "local") {
                    event.preventDefault();
                    event.stopPropagation();
                    const items = dragItemsRef.current;
                    finishDrag();
                    void moveLocalItems(items, localParentPath(localPath));
                  }
                }}
                onClick={() => void run(() => loadLocalFiles(localParentPath(localPath)))}
              >
                <span className="tile-icon glyph-folder" aria-hidden="true" />
                <strong>../</strong>
                <span>Parent folder</span>
              </article>
            )}

            {sortedLocalFiles.map((file) => (
              <article
                key={file.path}
                data-path={file.path}
                className={`file-tile ${localSelected.includes(file.path) ? "selected" : ""} ${dropTarget === file.path ? "drop-target" : ""}`}
                draggable
                onDragStart={(event) => beginLocalDrag(event, file)}
                onDragEnd={finishDragAfterDrop}
                onDragOver={(event) => {
                  if (file.isDirectory && dragSourceRef.current === "local" && isValidMoveTarget(dragItemsRef.current, file.path)) {
                    event.preventDefault();
                    setDropTarget(file.path);
                  }
                }}
                onDrop={(event) => {
                  if (file.isDirectory && dragSourceRef.current === "local") {
                    event.preventDefault();
                    event.stopPropagation();
                    const items = dragItemsRef.current;
                    finishDrag();
                    void moveLocalItems(items, file.path);
                  }
                }}
                onClick={(event) => selectLocalFile(file, event)}
                onDoubleClick={() => {
                  if (file.isDirectory) void run(() => loadLocalFiles(file.path));
                  else openLocalViewer(file.path);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setActivePane("local");
                  if (!localSelected.includes(file.path)) setLocalSelected([file.path]);
                  setContextMenu({ x: event.clientX, y: event.clientY });
                }}
              >
                <span className={`tile-icon ${file.isDirectory ? "glyph-folder" : "glyph-file"}`} aria-hidden="true" />
                <strong>{file.name}</strong>
                <span>{file.isDirectory ? "File folder" : "File"}</span>
                <small>{file.isDirectory ? "--" : formatSize(file.size)}</small>
              </article>
            ))}
            {!localFiles.length && !localPath && <span className="muted">This folder is empty.</span>}
          </div>
        ) : (
        <div
          className="local-file-list"
          ref={localFileListRef}
          onMouseDown={(event) => beginMarqueeSelect(event, "local", localFileListRef.current)}
        >
          {showLocalUp() && (
            <button
              className={`local-file local-file-dotdot ${dropTarget === localParentPath(localPath) ? "drop-target" : ""}`}
              onDragOver={(event) => {
                if (dragSourceRef.current === "local" && isValidMoveTarget(dragItemsRef.current, localParentPath(localPath))) {
                  event.preventDefault();
                  setDropTarget(localParentPath(localPath));
                }
              }}
              onDrop={(event) => {
                if (dragSourceRef.current === "local") {
                  event.preventDefault();
                  event.stopPropagation();
                  const items = dragItemsRef.current;
                  finishDrag();
                  void moveLocalItems(items, localParentPath(localPath));
                }
              }}
              onClick={() => void run(() => loadLocalFiles(localParentPath(localPath)))}
            >
              <span className="glyph-folder" aria-hidden="true" />
              <span className="local-file-name">../</span>
            </button>
          )}

          {sortedLocalFiles.map((file) => (
            <button
              key={file.path}
              data-path={file.path}
              className={`local-file ${localSelected.includes(file.path) ? "selected" : ""} ${dropTarget === file.path ? "drop-target" : ""}`}
              draggable
              onDragStart={(event) => beginLocalDrag(event, file)}
              onDragEnd={finishDragAfterDrop}
              onDragOver={(event) => {
                if (file.isDirectory && dragSourceRef.current === "local" && isValidMoveTarget(dragItemsRef.current, file.path)) {
                  event.preventDefault();
                  setDropTarget(file.path);
                }
              }}
              onDrop={(event) => {
                if (file.isDirectory && dragSourceRef.current === "local") {
                  event.preventDefault();
                  event.stopPropagation();
                  const items = dragItemsRef.current;
                  finishDrag();
                  void moveLocalItems(items, file.path);
                }
              }}
              onClick={(event) => selectLocalFile(file, event)}
              onDoubleClick={() => {
                if (file.isDirectory) void run(() => loadLocalFiles(file.path));
                else openLocalViewer(file.path);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setActivePane("local");
                if (!localSelected.includes(file.path)) setLocalSelected([file.path]);
                setContextMenu({ x: event.clientX, y: event.clientY });
              }}
            >
              <span className={file.isDirectory ? "glyph-folder" : "glyph-file"} aria-hidden="true" />
              <span className="local-file-name">{file.name}</span>
              <small>{file.isDirectory ? "Folder" : formatSize(file.size)}</small>
            </button>
          ))}
          {!localFiles.length && !localPath && <span className="muted">This folder is empty.</span>}
        </div>
        )}
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
          <h1>nFterm {appVersion && <small className="login-version">{appVersion}</small>}</h1>
          <p>Sign in to your API server over HTTPS.</p>
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
        </form>
        {onlyTerminalAvailable && (
          <button
            type="button"
            className="only-terminal-corner-button"
            disabled={busy}
            onClick={enterOnlyTerminalMode}
            title="Skip login and the API server. Local Explorer and SSH Terminal only."
          >
            <span className="status-glyph" aria-hidden="true">◆</span> Only Terminal
          </button>
        )}
      {sharePasswordOpen && (
        <div className="modal-cover" onMouseDown={() => setSharePasswordOpen(false)}>
          <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <h2>Secure share link</h2>
            <p className="muted">Optional: protect the link with a password. Leave blank to share without one.</p>
            <label>
              Password (optional)
              <input
                type="password"
                autoFocus
                value={sharePasswordDraft}
                onChange={(event) => setSharePasswordDraft(event.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="confirm" onClick={() => void createShareLink(sharePasswordDraft.trim() || undefined)}>
                Create link
              </button>
              <button type="button" onClick={() => setSharePasswordOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </main>

    );

  const autoDensity = viewport.width <= 1100 || viewport.height <= 760 ? "compact" : "standard";
  const densityLabel = desktopSettings.uiDensity === "auto"
    ? `Auto (${autoDensity})`
    : desktopSettings.uiDensity[0].toUpperCase() + desktopSettings.uiDensity.slice(1);
  const densitySliderValue = desktopSettings.uiDensity === "compact"
    ? "0"
    : desktopSettings.uiDensity === "comfortable"
      ? "2"
      : "1";

  return (
    <main className={`explorer ui-density-${desktopSettings.uiDensity}`}>
      <header className="titlebar">
        <span className="app-mark" />
        <span className="app-name">
          Nephom <span className="connection-status">File manager</span> cross <span className="connection-status">Terminal</span>
        </span>
        {(activeLocation || connectedSshBrowseOptions().length > 0) && (
          <div className="location-control" ref={locationControl}>
            <span className="location-label">Location</span>
            {(locations.length > 1 || connectedSshBrowseOptions().length > 0) ? (
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
                {remoteSshEntryId
                  ? `SSH: ${findSshProfileById(remoteSshEntryId)?.name || "Unknown"}`
                  : activeLocation ? activeLocation.displayName : "Browse via SSH"}
                <span className="location-chevron" aria-hidden="true">⌄</span>
              </button>
            ) : (
              <span className="location-single">
                {activeLocation!.displayName}
              </span>
            )}
            {(locations.length > 1 || connectedSshBrowseOptions().length > 0) && locationMenuOpen && (
              <div className="location-menu" role="listbox" aria-label="Locations">
                {locations.map((location) => (
                  <button
                    key={location.id}
                    className={!remoteSshEntryId && location.id === session.locationId ? "selected" : ""}
                    role="option"
                    aria-selected={!remoteSshEntryId && location.id === session.locationId}
                    onClick={() => {
                      setLocationMenuOpen(false);
                      void selectLocation(location.id);
                    }}
                  >
                    {location.displayName}
                  </button>
                ))}
                {connectedSshBrowseOptions().map((entry) => (
                  <button
                    key={entry.id}
                    className={entry.id === remoteSshEntryId ? "selected" : ""}
                    role="option"
                    aria-selected={entry.id === remoteSshEntryId}
                    onClick={() => {
                      setLocationMenuOpen(false);
                      selectSshBrowse(entry.id);
                    }}
                  >
                    {`SSH: ${entry.name}`}
                  </button>
                ))}
              </div>
            )}
            {activeLocation && (
              <span
                className={`health-dot ${activeLocation.status === "online" ? "online" : ""}`}
                title={activeLocation.status || "unknown"}
                aria-label={activeLocation.status || "unknown"}
              />
            )}
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
              {session.onlyTerminalMode ? "Only Terminal" : session.role === "admin" ? "Admin" : "User"}
            </span>
            <span className="account-chevron">⌄</span>
          </button>
          {accountOpen && (
            <div className="account-menu">
              <div className="account-summary">
                <strong>{session.username}</strong>
                <span>
                  {session.onlyTerminalMode
                    ? "Offline dev session — no API server connected"
                    : session.role === "admin"
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
                  Workspace Manager
               </button>
               <button
                 onClick={() => {
                   setAccountOpen(false);
                   setSettingsOpen(true);
                   refreshStorageInfo();
                 }}
               >
                 Settings
               </button>
               {!session.onlyTerminalMode && (
                 <button
                   onClick={() => {
                     setAccountOpen(false);
                     setChangePasswordOpen(true);
                   }}
                 >
                   Change password
                 </button>
               )}
              <hr />
              <button className="danger" onClick={signOut}>
                Log out
              </button>
            </div>
          )}
        </div>
      </header>
      <nav className="commandbar" aria-label="File actions">
        {splitMode && (
          <span className="active-pane-indicator" title="New folder/Rename/Delete/View/Select all act on this pane">
            Acting on: <strong>{activePane === "local" ? "LOCAL" : "REMOTE"}</strong>
          </span>
        )}
        <button
          className="primary"
          onClick={() => {
            // Desktop is used from the LOCAL side: while a split SSH view has
            // LOCAL active, Upload sends the LOCAL selection into the current
            // REMOTE folder (mirrors dragging LOCAL -> REMOTE); otherwise it
            // falls back to the plain file-picker upload.
            if (splitMode && remoteSshEntryId && activePane === "local" && localSelected.length) {
              uploadLocalItemsToRemote(localSelectedItems, path);
            } else {
              void upload();
            }
          }}
          disabled={
            busy ||
            (splitMode && remoteSshEntryId
              ? activePane !== "local"
              : !(remoteSshEntryId ? true : locationOnline && hasCapability("upload")))
          }
          title={splitMode && remoteSshEntryId ? "Send the LOCAL selection to the current REMOTE folder" : undefined}
        >
          Upload
        </button>
        <button
          onClick={createFolder}
          disabled={
            splitMode && activePane === "local"
              ? busy
              : busy || !(remoteSshEntryId ? true : locationOnline && hasCapability("mkdir"))
          }
        >
          New folder
        </button>
        <span className="divider" />
        <button
          disabled={
            busy ||
            (splitMode && remoteSshEntryId
              ? activePane !== "remote" || !selectedItems.length
              : !selectedItems.length || !(remoteSshEntryId ? true : locationOnline && hasCapability("read")))
          }
          onClick={() => {
            // Mirror the Upload button above: while a split SSH view has
            // REMOTE active, Download brings the REMOTE selection straight
            // into the current LOCAL folder (mirrors dragging REMOTE ->
            // LOCAL) instead of queuing it to the Downloads folder.
            if (splitMode && remoteSshEntryId && activePane === "remote" && selectedItems.length) {
              downloadRemoteItemsToLocal(selectedItems);
            } else {
              download();
            }
          }}
          title={splitMode && remoteSshEntryId ? "Bring the REMOTE selection into the current LOCAL folder" : undefined}
        >
          Download
        </button>
        <button
          disabled={
            splitMode && activePane === "local"
              ? busy || localSelectedItems.length !== 1 || localSelectedItems[0].isDirectory
              : busy ||
                !locationOnline ||
                selectedItems.length !== 1 ||
                selectedItems[0].isDirectory ||
                !!remoteSshEntryId ||
                !hasCapability("read")
          }
          onClick={() =>
            splitMode && activePane === "local"
              ? openLocalViewer(localSelectedItems[0].path)
              : openRemoteViewer(selectedItems[0])
          }
        >
          View
        </button>
        <button
          disabled={
            busy ||
            (splitMode && activePane === "local") ||
            !selectedItems.length ||
            !(remoteSshEntryId ? true : locationOnline && hasCapability("move"))
          }
          onClick={() =>
            notify("Drag selected files to a destination folder to move them.")
          }
        >
          Move
        </button>
        <button
          disabled={
            splitMode && activePane === "local"
              ? busy || localSelectedItems.length !== 1
              : busy ||
                selectedItems.length !== 1 ||
                !(remoteSshEntryId ? true : locationOnline && hasCapability("rename"))
          }
          onClick={rename}
        >
          Rename
        </button>
        <button
          disabled={
            busy ||
            (splitMode && activePane === "local") ||
            !locationOnline ||
            selectedItems.length !== 1 ||
            selectedItems[0].isDirectory ||
            !!remoteSshEntryId ||
            !hasCapability("share")
          }
          onClick={share}
        >
          Share
        </button>
        <button
          disabled={
            splitMode && activePane === "local"
              ? busy || !localSelectedItems.length
              : busy ||
                !selectedItems.length ||
                !(remoteSshEntryId ? true : locationOnline && hasCapability("delete"))
          }
          onClick={remove}
        >
          Delete
        </button>
        <button
          disabled={busy || !undoStack.length}
          onClick={undoLastOperation}
          title={undoStack.length ? `Undo: ${undoStack[undoStack.length - 1].description}` : "No operation to undo"}
        >
          Undo
        </button>
        <span className="divider" />
        <button
          onClick={() =>
            splitMode && activePane === "local"
              ? setLocalSelected(
                  localSelected.length === localFiles.length
                    ? []
                    : sortedLocalFiles.map((file) => file.path),
                )
              : setSelected(
                  selected.length === files.length
                    ? []
                    : sortedFiles.map((file) => file.path),
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
            onClick={toggleSplitMode}
            aria-pressed={splitMode}
          >
            Split
          </button>
        </span>
        <SortControls
          label={activePane === "local" ? "LOCAL sort" : "REMOTE sort"}
          sortKey={activePane === "local" ? localSortKey : remoteSortKey}
          direction={activePane === "local" ? localSortDirection : remoteSortDirection}
          onSortKeyChange={activePane === "local" ? setLocalSortKey : setRemoteSortKey}
          onDirectionChange={() => activePane === "local"
            ? setLocalSortDirection((current) => current === "asc" ? "desc" : "asc")
            : setRemoteSortDirection((current) => current === "asc" ? "desc" : "asc")}
        />
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
        <div className="crumbs">
          {activePane === "local" ? (
            <>
              <button onClick={() => void run(() => loadLocalFiles(""))}>~</button>
              {localBreadcrumbSegments(localPath).map((segment, index) => (
                <React.Fragment key={`local-${segment.target}-${index}`}>
                  <span className="crumb-separator">›</span>
                  <button onClick={() => void run(() => loadLocalFiles(segment.target))}>
                    {segment.label}
                  </button>
                </React.Fragment>
              ))}
            </>
          ) : (
            <>
              <button onClick={() => void run(() => loadFiles(remoteSshEntryId ? "/" : ""))}>/</button>
              {path
                .split("/")
                .filter(Boolean)
                .map((part, index, parts) => (
                  <React.Fragment key={`${part}-${index}`}>
                    <span className="crumb-separator">›</span>
                    <button
                      onClick={() =>
                        void run(() =>
                          loadFiles(remoteSshEntryId
                            ? `/${parts.slice(0, index + 1).join("/")}`
                            : parts.slice(0, index + 1).join("/")),
                        )
                      }
                    >
                      {part}
                    </button>
                  </React.Fragment>
                ))}
            </>
          )}
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
        {splitMode && (
          <div
            className="pane-resize-handle"
            onPointerDown={beginPaneResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize LOCAL and REMOTE panes"
          />
        )}
        <aside className="desktop-folder-tree" onMouseDownCapture={() => setActivePane("remote")}>
          <span className="sidebar-label">Folders</span>
          <div className="folder-pane">
            <div
              id="folders"
              ref={folderTreeRef}
              className="folder-tree-scroll"
              onDragOver={(event) => handleDragAutoScroll(event, folderTreeRef.current)}
              onDragLeave={stopDragAutoScroll}
              onDrop={stopDragAutoScroll}
            >
              {renderTreeNode(folderTree)}
            </div>
            <PersistentScrollbar targetRef={folderTreeRef} label="Folders" />
          </div>
        </aside>
        <section
          className={`desktop-content ${splitMode && activePane === "remote" ? "active-pane" : ""}`}
          onMouseDownCapture={() => setActivePane("remote")}
        >
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
            <div
              id="files"
              ref={fileAreaRef}
              className={`file-area ${dragSource === "local" && canDragLocalToRemote && paneDragHover === "remote" ? "drop-target" : ""}`}
              onDragEnter={enterPaneDragHover("remote")}
              onDragOver={(event) => {
                handleDragAutoScroll(event, fileAreaRef.current);
                if (dragSourceRef.current === "local" && canDragLocalToRemote && dragItemsRef.current.length) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }
              }}
              onDragLeave={(event) => {
                stopDragAutoScroll();
                leavePaneDragHover("remote")(event);
              }}
              onMouseDown={(event) => beginMarqueeSelect(event, "remote", fileAreaRef.current)}
              onDropCapture={(event) => {
                stopDragAutoScroll();
                if (dragSourceRef.current === "local" && canDragLocalToRemote) {
                  event.preventDefault();
                  event.stopPropagation();
                  setPaneDragHover("");
                  const items = dragItemsRef.current;
                  uploadLocalItemsToRemote(items, path);
                }
              }}
            >
              {viewMode === "grid" ? (
              <div className="file-grid">
                {showRemoteUp && (
                  <article
                    className={`file-tile file-tile-dotdot ${dropTarget === (remoteSshEntryId ? sshParentPath(path) : parentPath(path)) ? "drop-target" : ""}`}
                    onDragOver={(event) => {
                      const destination = remoteSshEntryId ? sshParentPath(path) : parentPath(path);
                      if (canDropOnRemote(destination)) {
                        event.preventDefault();
                        setDropTarget(destination);
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      const destination = remoteSshEntryId ? sshParentPath(path) : parentPath(path);
                      const items = dragItemsRef.current;
                      const source = dragSourceRef.current;
                      finishDrag();
                      void moveItems(items, destination, source);
                    }}
                    onClick={() => void run(() => loadFiles(remoteSshEntryId ? sshParentPath(path) : parentPath(path)))}
                  >
                    <span className="tile-icon glyph-folder" aria-hidden="true" />
                    <strong>../</strong>
                    <span>Parent folder</span>
                  </article>
                )}

                {sortedFiles.map((file) => (
                  <article
                    key={file.path}
                    data-path={file.path}
                    className={`file-tile ${selected.includes(file.path) ? "selected" : ""} ${dropTarget === file.path ? "drop-target" : ""}`}
                    draggable
                     onDragStart={(event) => beginRemoteDrag(event, file)}
                    onDragEnd={finishDragAfterDrop}
                    onDragOver={(event) => {
                      if (
                        file.isDirectory &&
                        canDropOnRemote(file.path)
                      ) {
                        event.preventDefault();
                        setDropTarget(file.path);
                      }
                    }}
                    onDrop={(event) => {
                      if (file.isDirectory) {
                        event.preventDefault();
                        event.stopPropagation();
                        const items = dragItemsRef.current;
                        const source = dragSourceRef.current;
                        finishDrag();
                        void moveItems(items, file.path, source);
                      }
                    }}
                     onClick={(event) => selectFile(file, event)}
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
                      <span className={file.isDirectory ? "glyph-folder" : "glyph-file"} aria-hidden="true" />
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
                  {showRemoteUp && (
                    <tr
                      className={`file-row file-row-dotdot ${dropTarget === (remoteSshEntryId ? sshParentPath(path) : parentPath(path)) ? "drop-target" : ""}`}
                      onDragOver={(event) => {
                        const destination = remoteSshEntryId ? sshParentPath(path) : parentPath(path);
                        if (canDropOnRemote(destination)) {
                          event.preventDefault();
                          setDropTarget(destination);
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const destination = remoteSshEntryId ? sshParentPath(path) : parentPath(path);
                        const items = dragItemsRef.current;
                        const source = dragSourceRef.current;
                        finishDrag();
                        void moveItems(items, destination, source);
                      }}
                      onClick={() => void run(() => loadFiles(remoteSshEntryId ? sshParentPath(path) : parentPath(path)))}
                    >
                      <td />
                      <td colSpan={3}><span className="glyph-folder" aria-hidden="true" /> ../</td>
                    </tr>
                  )}

                  {sortedFiles.map((file) => (
                    <tr
                      key={file.path}
                      data-path={file.path}
                      draggable
                      className={`file-row ${selected.includes(file.path) ? "selected" : ""} ${dropTarget === file.path ? "drop-target" : ""}`}
                           onDragStart={(event) => beginRemoteDrag(event, file)}
                      onDragEnd={finishDragAfterDrop}
                      onDragOver={(event) => {
                        if (
                          file.isDirectory &&
                          canDropOnRemote(file.path)
                        ) {
                          event.preventDefault();
                          setDropTarget(file.path);
                        }
                      }}
                      onDrop={(event) => {
                        if (file.isDirectory) {
                          event.preventDefault();
                          event.stopPropagation();
                          const items = dragItemsRef.current;
                          const source = dragSourceRef.current;
                          finishDrag();
                          void moveItems(items, file.path, source);
                        }
                      }}
                       onClick={(event) => selectFile(file, event)}
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
                          <span className={file.isDirectory ? "glyph-folder" : "glyph-file"} aria-hidden="true" /> {file.name}
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
      {marqueeRect && (
        <div
          className="marquee-select"
          style={{
            position: "fixed",
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
            pointerEvents: "none",
            zIndex: 9999,
          }}
        />
      )}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {splitMode && activePane === "local" ? (
            <>
              <button
                disabled={!canDragLocalToRemote || !localSelectedItems.length}
                onClick={() => {
                  setContextMenu(null);
                  uploadLocalItemsToRemote(localSelectedItems, path);
                }}
              >
                Upload to REMOTE
              </button>
              <button
                onClick={() => {
                  setContextMenu(null);
                  void createFolder();
                }}
              >
                New folder
              </button>
              <button
                disabled={localSelectedItems.length !== 1}
                onClick={() => {
                  setContextMenu(null);
                  void rename();
                }}
              >
                Rename
              </button>
              <hr />
              <button
                disabled={!localSelectedItems.length}
                onClick={() => {
                  setContextMenu(null);
                  void compressLocalItems();
                }}
              >
                Compress to .zip
              </button>
              <button
                disabled={localSelectedItems.length !== 1 || !isZipFile(localSelectedItems[0])}
                onClick={() => {
                  setContextMenu(null);
                  void extractLocalArchive();
                }}
              >
                Extract here
              </button>
              <hr />
              <button
                disabled={!localSelectedItems.length}
                onClick={() => {
                  setContextMenu(null);
                  void remove();
                }}
              >
                Delete
              </button>
            </>
          ) : (
            <>
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
                  selectedItems.length !== 1 || selectedItems[0].isDirectory || !!remoteSshEntryId
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
                disabled={!selectedItems.length || !remoteSshEntryId}
                title={!remoteSshEntryId ? "Compression is only available for an SSH REMOTE connection." : undefined}
                onClick={() => {
                  setContextMenu(null);
                  void compressRemoteItems();
                }}
              >
                Compress to .zip
              </button>
              <button
                disabled={selectedItems.length !== 1 || !remoteSshEntryId || !isZipFile(selectedItems[0])}
                title={!remoteSshEntryId ? "Extraction is only available for an SSH REMOTE connection." : undefined}
                onClick={() => {
                  setContextMenu(null);
                  void extractRemoteArchive();
                }}
              >
                Extract here
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
            </>
          )}
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
       {saveLogNameOpen && (
         <div className="modal-cover" onMouseDown={() => setSaveLogNameOpen(false)}>
           <div className="modal log-name-modal" onMouseDown={(event) => event.stopPropagation()}>
             <h2>Name SSH log package</h2>
             <p>Choose the base name for the raw output, text, command, and metadata files. The application removes unsafe filename characters and adds the file extensions automatically.</p>
             <form onSubmit={(event) => { event.preventDefault(); saveSshLogs(); }}>
               <label>
                 Log name
                 <input
                   autoFocus
                   value={saveLogNameDraft}
                   onChange={(event) => setSaveLogNameDraft(event.target.value)}
                   placeholder="Production console 2026-08-06"
                   maxLength={120}
                   required
                 />
               </label>
                <small className="field-help">Save location: LOCAL {isAbsoluteLocalPath(saveLogDestinationPath) ? saveLogDestinationPath : `~/${saveLogDestinationPath}`}</small>
               <div className="modal-actions">
                 <button type="button" onClick={() => setSaveLogNameOpen(false)}>Cancel</button>
                 <button className="confirm" type="submit">Save Log</button>
               </div>
             </form>
           </div>
         </div>
       )}
       {settingsOpen && (
         <div className="modal-cover" onMouseDown={() => setSettingsOpen(false)}>
            <div className="modal settings-modal" style={modalStyle("settings")} onMouseDown={(event) => event.stopPropagation()}>
               <h2 className="modal-drag-handle" onMouseDown={beginModalDrag("settings")}>Desktop Settings</h2>
              <p className="settings-intro">Safe defaults keep confirmations and security checks enabled. These preferences can hide prompts only; they never bypass permissions, read-only rules, path boundaries, destination validation, or transfer verification.</p>
              <section className="settings-section">
                <h3>Interface size</h3>
                <div className="settings-density">
                  <div className="settings-density-heading">
                    <strong>{densityLabel}</strong>
                    <small>Buttons and spacing adapt without cutting text.</small>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="1"
                    value={densitySliderValue}
                    aria-label="Interface size"
                    onChange={(event) => {
                      const values = ["compact", "standard", "comfortable"] as const;
                      setDesktopSettings((current) => ({ ...current, uiDensity: values[Number(event.target.value)] }));
                    }}
                  />
                  <div className="settings-density-scale"><span>Compact</span><span>Standard</span><span>Comfortable</span></div>
                  <button type="button" onClick={() => setDesktopSettings((current) => ({ ...current, uiDensity: "auto" }))}>Use automatic sizing</button>
                </div>
              </section>
              <section className="settings-section">
               <h3>Risk confirmations</h3>
               {([
                 ["delete", "Delete", "Deleting files or folders can permanently remove data."],
                 ["overwrite", "Overwrite", "Replacing an existing destination can destroy its current contents."],
                 ["recursive", "Recursive operations", "Applying an operation to a folder also affects its descendants."],
                 ["crossSourceMove", "Cross-source move", "Moving between sources uses copy and verification before source deletion."],
               ] as const).map(([key, label, description]) => (
                 <label className="settings-check" key={key}>
                   <input
                     type="checkbox"
                     checked={desktopSettings.confirmations[key]}
                     onChange={(event) => setDesktopSettings((current) => ({ ...current, confirmations: { ...current.confirmations, [key]: event.target.checked } }))}
                   />
                   <span><strong>{label}</strong><small>{description}</small></span>
                 </label>
               ))}
               <button type="button" onClick={() => setDesktopSettings((current) => ({ ...current, confirmations: { ...defaultDesktopSettings.confirmations } }))}>Restore safe confirmations</button>
             </section>
             <section className="settings-section">
               <h3>Sharing</h3>
               <label className="settings-check">
                 <input
                   type="radio"
                   name="shareLinkMode"
                   checked={desktopSettings.shareLinkMode === "secure"}
                   onChange={() => setDesktopSettings((current) => ({ ...current, shareLinkMode: "secure" }))}
                 />
                 <span><strong>Secure share (web page link)</strong><small>Opens the share.html page; supports an optional password. Use for sharing with people.</small></span>
               </label>
               <label className="settings-check">
                 <input
                   type="radio"
                   name="shareLinkMode"
                   checked={desktopSettings.shareLinkMode === "direct"}
                   onChange={() => setDesktopSettings((current) => ({ ...current, shareLinkMode: "direct" }))}
                 />
                 <span><strong>Direct link (for tools like BMC)</strong><small>A plain file URL with no page and no Authorization header, for pasting into tools that only accept a bare link. No password protection.</small></span>
               </label>
                <label className="settings-level">Default share link expiration
                 <select
                   value={desktopSettings.shareLinkExpirationDays}
                   onChange={(event) => setDesktopSettings((current) => ({ ...current, shareLinkExpirationDays: Number(event.target.value) }))}
                 >
                   <option value={0}>Server default</option>
                   <option value={1}>1 day</option>
                   <option value={7}>7 days</option>
                   <option value={30}>30 days</option>
                   <option value={90}>90 days</option>
                 </select>
                  <small>Applied to every new share link created from this desktop app. The server also enforces its own configured maximum, so longer values may be rejected.</small>
                </label>
                <div className="settings-inline-action">
                  <div><strong>Share link management</strong><small>Review, copy, or revoke links created by this desktop client.</small></div>
                  <button type="button" onClick={openShareLinks} disabled={!session.token || session.onlyTerminalMode}>Manage Share Links</button>
                </div>
              </section>
             <section className="settings-section">
               <h3>History and operation log</h3>
               <p>Both are enabled by default. Undo records are reserved for reliable, verifiable reversals. The operation log is append-only, excludes secrets, rotates at 10 MB, and retains at most three files total.</p>
               <label className="settings-check"><input type="checkbox" checked={desktopSettings.undoHistoryEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, undoHistoryEnabled: event.target.checked }))} /><span><strong>Enable undo history</strong><small>Disabling this stops new undo records; it does not delete files.</small></span></label>
                <label className="settings-check"><input type="checkbox" checked={desktopSettings.operationLogEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, operationLogEnabled: event.target.checked }))} /><span><strong>Enable operation log</strong><small>Disabling this stops new audit records; it does not delete unrelated data.</small></span></label>
                <label className="settings-level">Log detail level
                  <select value={desktopSettings.operationLogLevel} onChange={(event) => setDesktopSettings((current) => ({ ...current, operationLogLevel: event.target.value as DesktopSettings["operationLogLevel"] }))}>
                    <option value="DEBUG">DEBUG - diagnostics and operations</option>
                    <option value="INFO">INFO - normal operations</option>
                    <option value="WARN">WARN - warnings and failures</option>
                    <option value="ERROR">ERROR - failures only</option>
                  </select>
                  <small>DEBUG is enabled by default during development. Lower levels reduce diagnostic detail.</small>
                </label>
                {storageInfo && <div className="storage-info"><span>History: {storageInfo.historyPath} ({formatSize(storageInfo.historyBytes)})</span><span>Logs: {storageInfo.logPath} ({formatSize(storageInfo.logBytes)})</span><span>{storageInfo.logFiles.length} log file{storageInfo.logFiles.length === 1 ? "" : "s"} currently retained</span></div>}
               <div className="modal-actions settings-actions"><button type="button" onClick={clearHistory}>Clear undo history</button><button type="button" className="danger" onClick={clearLogs}>Clear operation logs</button></div>
             </section>
             <div className="modal-actions"><button type="button" className="confirm" onClick={() => setSettingsOpen(false)}>Close</button></div>
           </div>
         </div>
       )}
        {shareLinksOpen && (
          <div className="modal-cover modal-layer-top" onMouseDown={() => setShareLinksOpen(false)}>
             <div className="modal share-links-modal" style={modalStyle("share-links")} onMouseDown={(event) => event.stopPropagation()}>
               <div className="modal-heading-row modal-drag-handle" onMouseDown={beginModalDrag("share-links")}><div><h2>Share Links</h2><p>Links created by this desktop client.</p></div><button type="button" onClick={() => setShareLinksOpen(false)} aria-label="Close Share Links">×</button></div>
              <div className="share-links-toolbar"><span>{shareLinks.length} link{shareLinks.length === 1 ? "" : "s"}</span><button type="button" onClick={() => void loadShareLinks()} disabled={shareLinksLoading}>{shareLinksLoading ? "Refreshing..." : "Refresh"}</button></div>
              {shareLinksLoading && !shareLinks.length ? <p className="muted">Loading share links...</p> : !shareLinks.length ? <p className="muted">No share links created yet.</p> : (
                <div className="share-links-list">
                  {shareLinks.map((link) => {
                    const secureUrl = shareLinkUrl(link, "secure");
                    const directUrl = shareLinkUrl(link, "direct");
                    const status = link.isExpired ? "Expired" : link.isExhausted ? "Exhausted" : link.isActive ? "Active" : "Revoked";
                    return <article className="share-link-card" key={link.shareToken}>
                      <div className="share-link-card-heading"><strong>{link.fileName}</strong><span className={`share-link-status ${status.toLowerCase()}`}>{status}</span></div>
                      <small>Location: {link.locationId || "--"} · Created: {link.createdAt ? new Date(link.createdAt).toLocaleString() : "--"}</small>
                      <small>Downloads: {link.downloadCount || 0}{link.maxDownloads > 0 ? ` / ${link.maxDownloads}` : " / unlimited"} · Expires: {link.expiresAt ? new Date(link.expiresAt).toLocaleString() : "never"}</small>
                      <label>Secure link<input readOnly value={secureUrl} onFocus={(event) => event.currentTarget.select()} /></label>
                      <label>Direct download<input readOnly value={directUrl} onFocus={(event) => event.currentTarget.select()} /></label>
                      <div className="modal-actions"><button type="button" onClick={() => void copyManagedShareLink(link, "secure")} disabled={!secureUrl}>Copy secure</button><button type="button" onClick={() => void copyManagedShareLink(link, "direct")} disabled={!directUrl}>Copy direct</button><button type="button" className="danger" onClick={() => revokeManagedShareLink(link.shareToken)} disabled={!link.isActive}>Revoke</button></div>
                    </article>;
                  })}
                </div>
              )}
              <div className="modal-actions modal-actions-end"><button type="button" className="confirm" onClick={() => setShareLinksOpen(false)}>Close</button></div>
            </div>
          </div>
        )}
         {sessionsOpen && (
          <div className="modal-cover" onMouseDown={() => setSessionsOpen(false)}>
             <div className="modal sessions-modal" style={modalStyle("sessions")} onMouseDown={(event) => event.stopPropagation()}>
               <div className="workspace-manager-heading modal-drag-handle" onMouseDown={beginModalDrag("sessions")}>
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
                          </li>
                        ))}
                      </ol>
                    </section>
                    <section className="workspace-entry-section">
                      <h3>Session Entries</h3>
                      {!managedSession.sxpEntries.length && <span className="muted">No Session Entries yet.</span>}
                      <ol className="workspace-entry-list">
                        {managedSession.sxpEntries.map((entry) => (
                          <li key={entry.id}>
                            <button type="button" className="workspace-entry-button session-entry-summary" onClick={() => { setWorkspaceSessionId(managedSession.id); openEditSxpEntryDialog(entry); }}>
                              <strong>{entry.name}</strong>
                              <span>LOCAL: ~/{entry.localPath || ""}</span>
                              <span>LOCATIONID: {entry.locationName || entry.locationId}</span>
                              <span>REMOTE PATH: {entry.remotePath || "/"}</span>
                            </button>
                          </li>
                        ))}
                      </ol>
                    </section>
                    <div className="workspace-entry-actions">
                      <button type="button" className="confirm" onClick={() => { setWorkspaceSessionId(managedSession.id); openAddSshEntryDialog(); }}>Add SSH Entry</button>
                      <button type="button" className="confirm" onClick={() => { setWorkspaceSessionId(managedSession.id); openAddSxpEntryDialog(); }}>Add Session Entry</button>
                    </div>
                  </article>
                ))}
              </div>
              <div className="workspace-modal-footer">
                <button type="button" className="danger" disabled={!activeManagedWorkspace || managedSessions.length === 1} onClick={() => activeManagedWorkspace && removeSession(activeManagedWorkspace.id)}>Remove</button>
                <button type="button" className="confirm" onClick={() => setSessionsOpen(false)}>Close</button>
              </div>
            </div>
          </div>
        )}
        {workspaceNameDialogOpen && (
          <div className="modal-cover modal-layer-top" onMouseDown={() => setWorkspaceNameDialogOpen(false)}>
            <form className="modal workspace-name-modal" style={modalStyle("workspace-name")} onSubmit={(event) => { event.preventDefault(); saveWorkspaceName(event.currentTarget); }} onMouseDown={(event) => event.stopPropagation()}>
              <h2 className="modal-drag-handle" onMouseDown={beginModalDrag("workspace-name")}>{workspaceSessionId ? "Edit Workspace" : "Add Workspace"}</h2>
              {sessionFormError && <output className="form-error" role="alert">{sessionFormError}</output>}
              <label>
                Workspace name
                <input name="sessionName" value={sessionNameDraft} onChange={(event) => setSessionNameDraft(event.target.value)} placeholder="Default" required autoFocus />
              </label>
              <div className="modal-actions">
                <button type="button" onClick={() => setWorkspaceNameDialogOpen(false)}>Cancel</button>
                <button type="submit" className="confirm">Save</button>
              </div>
            </form>
          </div>
        )}
      {sshEntryDialogOpen && (
        <div
          className="modal-cover modal-layer-top"
          onMouseDown={() => setSshEntryDialogOpen(false)}
        >
          <div
            className="modal ssh-entry-modal"
            style={modalStyle("ssh-entry")}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 className="modal-drag-handle" onMouseDown={beginModalDrag("ssh-entry")}>{sshEntryDraftId ? "Edit SSH Entry" : "Add SSH Entry"}</h2>
            <p>Workspace: {activeManagedWorkspace?.name || "—"}</p>
            {sessionFormError && <output className="form-error" role="alert">{sessionFormError}</output>}
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
              <input type="password" name="sshPassword" value={sshProfileDraft.password} onChange={(event) => setSshProfileDraft((current) => ({ ...current, password: event.target.value }))} placeholder={sshPasswordSaved ? "Saved - leave blank to keep it" : "Not saved"} autoComplete="new-password" />
            </label>
            <small className="field-help">
              {sshPasswordSaved ? "A password is saved for this entry in the OS credential store (or a local fallback file outside the Session data)." : "No password saved yet. Add one here, or configure a private key, before connecting."}
              {" "}Used to authenticate and to auto-fill the terminal's password prompt; never written to Session data.
              {sshPasswordSaved && <> <button type="button" className="link-button" onClick={forgetSshPassword}>Forget saved password</button></>}
            </small>
             <small className="field-help">Connect authenticates automatically with the private key or saved password. Use "Install SSH key" to push a key to the server using the saved password.</small>
            <div className="modal-actions">
              <button type="button" onClick={() => setSshEntryDialogOpen(false)}>Cancel</button>
              {sshEntryDraftId && <button type="button" className="session-delete" onClick={removeSshEntry}>Remove</button>}
              <button type="button" className="confirm" onClick={saveSshEntry}>Save</button>
            </div>
          </div>
        </div>
      )}
      {sxpEntryDialogOpen && (
        <div
          className="modal-cover modal-layer-top"
          onMouseDown={() => setSxpEntryDialogOpen(false)}
        >
          <div
            className="modal sxp-entry-modal"
            style={modalStyle("sxp-entry")}
            onMouseDown={(event) => event.stopPropagation()}
          >
             <h2 className="modal-drag-handle" onMouseDown={beginModalDrag("sxp-entry")}>{sxpEntryDraftId ? "Edit Session Entry" : "Add Session Entry"}</h2>
            <p>Workspace: {activeManagedWorkspace?.name || "—"}</p>
            {sessionFormError && <output className="form-error" role="alert">{sessionFormError}</output>}
            <label>
              Preset name
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
            <small className="field-help">Saves the LOCAL and API Remote folders you are currently browsing, under these names.</small>
            <div className="modal-actions">
              <button type="button" onClick={() => setSxpEntryDialogOpen(false)}>Cancel</button>
              {sxpEntryDraftId && <button type="button" className="session-delete" onClick={removeSxpEntry}>Remove</button>}
              <button type="button" className="confirm" onClick={saveSxpEntry}>Save</button>
            </div>
          </div>
        </div>
      )}
      {terminalOpen && (
        <section className={`terminal-dock${terminalMaximized ? " terminal-maximized" : ""}`} style={{ height: `${terminalHeight}px` }} aria-label="Terminal panel">

          <div className="terminal-resize-handle" onPointerDown={beginTerminalResize} role="separator" aria-label="Resize terminal" />
          <header className="terminal-header">
            <div className="terminal-tabs">
              <button className={sshQuickListOpen ? "active" : ""} aria-pressed={sshQuickListOpen} onClick={() => setSshQuickListOpen((open) => !open)}>
                 Workspaces
              </button>
              {sshTabs.map((tab) => (
                <span className={`ssh-tab ${tab.id === activeSshTabId ? "active" : ""}`} key={tab.id}>
                  <button type="button" onClick={() => selectSshTab(tab)}>
                    <span
                      className={`ssh-tab-status ${tab.connected ? "connected" : "disconnected"}`}
                      aria-label={tab.connected ? "Connected" : "Disconnected"}
                      title={tab.connected ? "Connected" : "Disconnected"}
                    />
                    {tab.title}
                  </button>
                  <button type="button" className="ssh-tab-close" aria-label={`Close ${tab.title}`} onClick={() => closeSshTab(tab.id)}>×</button>
                </span>
              ))}
              <button type="button" aria-label="New SSH terminal tab" onClick={() => createSshTab()}>+</button>
            </div>
            <div className="terminal-actions">
               <button onClick={() => openSessionsModal()}>Workspace Manager</button>
               <button onClick={() => setQueueOpen(true)}>Transfer Queue ({transferQueue.filter((item) => ["queued", "running", "retrying", "needs_user_action"].includes(item.status)).length})</button>
              <button aria-label={terminalMaximized ? "Restore terminal size" : "Maximize terminal"} aria-pressed={terminalMaximized} onClick={toggleTerminalMaximized}>{terminalMaximized ? "⤡" : "⤢"}</button>
              <button aria-label="Collapse terminal" onClick={() => setTerminalOpen(false)}>⌄</button>
            </div>
          </header>
          <div className="terminal-body">
            {sshQuickListOpen && (
              <aside className="ssh-quick-list" aria-label="Saved SSH sessions">
                 <div className="ssh-quick-list-heading">Workspaces</div>
                 {workspaceSessions.length === 0 && <p className="terminal-inline-note">No saved SSH entries yet. Use Workspace Manager to add one.</p>}
                {workspaceSessions.map((workspace) => (
                  <div className="ssh-quick-list-group" key={workspace.id}>
                    <span className="ssh-quick-list-group-label">{workspace.name}</span>
                    {workspace.sshEntries.map((entry) => {
                      const connected = sshTabs.some((tab) => tab.workspaceId === workspace.id && tab.sshEntryId === entry.id && tab.connected);
                      const isActive = activeSshTab?.workspaceId === workspace.id && activeSshTab?.sshEntryId === entry.id;
                      return (
                        <button
                          type="button"
                          key={entry.id}
                          className={`ssh-quick-list-entry ${isActive ? "active" : ""}`}
                          onClick={() => quickConnectSsh(workspace.id, entry.id)}
                        >
                          <span className={`ssh-tab-status ${connected ? "connected" : "disconnected"}`} aria-hidden="true" />
                          {entry.name}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </aside>
            )}
            <div className="terminal-content ssh-terminal-content">
              <div className="ssh-controls">
                <PaletteSelect
                   label="Select a Workspace"
                  value={workspaceSessionId}
                  options={workspaceSessions.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
                  onChange={selectWorkspaceSession}
                />
                {activeWorkspaceSession && (
                  <PaletteSelect
                    label="Select an SSH entry"
                    value={selectedSshEntryId}
                    options={activeWorkspaceSession.sshEntries.map((entry) => ({ value: entry.id, label: entry.name }))}
                    onChange={(id) => {
                      const entry = activeWorkspaceSession.sshEntries.find((item) => item.id === id);
                      setSelectedSshEntryId(id);
                      if (entry) {
                        setSshProfileId(entry.id);
                        loadSshProfileDraft(entry);
                      }
                    }}
                  />
                )}
                {!activeSshTab?.connected ? (
                  <button className="confirm" onClick={connectSsh} disabled={activeSshTab?.connecting}>{activeSshTab?.connecting ? "Connecting…" : "Connect"}</button>
                ) : (
                  <button className="danger" onClick={disconnectSsh}>Disconnect</button>
                )}
                {activeSshTab?.connecting && (
                  <button className="danger" onClick={() => cancelSshConnect(activeSshTab.id)}>Cancel</button>
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
                     <button disabled={recording || !recordingHasOutput} onClick={openSaveLogDialog}>Save Log</button>
                    <div className="upload-session-select">
                      <span>Destination Session</span>
                      <PaletteSelect
                        label="Select Session"
                        value={uploadSessionId}
                        options={apiUploadSessions.map((managedSession) => ({ value: managedSession.id, label: managedSession.name }))}
                       onChange={setUploadSessionId}
                       menuPlacement="up"
                     />
                     </div>
                      <button disabled={!savedLogPaths.length || recording || !apiUploadSessions.length || !session.locationId} onClick={uploadSavedLog}>Upload Log</button>
                      {savedLogPaths.length > 0 && <details className="saved-log-paths"><summary>Saved log files</summary>{savedLogPaths.map((savedPath) => <button type="button" key={savedPath} onClick={() => openLocalViewer(savedPath)}><code>{savedPath}</code></button>)}</details>}
                     {recording && <span className="recording-indicator">Recording</span>}
              </div>
            </div>
          </div>
        </section>
      )}
      {!terminalOpen && (
        <button className="terminal-restore" onClick={() => setTerminalOpen(true)} aria-label="Restore terminal">
          Terminal ⌃
        </button>
      )}
      {archiveFormatOpen && (
        <div className="modal-cover" onMouseDown={() => setArchiveFormatOpen(false)}>
          <div className="modal archive-format-modal" onMouseDown={(event) => event.stopPropagation()}>
            <h2>Choose download mode</h2>
            <p className="muted">Download as a single archive, or queue every file individually (preserving the original folder structure) like the Transfer Queue already does for uploads.</p>
            <label className="archive-format-option">
              <input type="radio" name="archiveFormat" checked={archiveFormatDraft === "tar.gz"} onChange={() => setArchiveFormatDraft("tar.gz")} />
              <span><strong>tar.gz archive</strong><small>Common on Linux and available with the tar command.</small></span>
            </label>
            <label className="archive-format-option">
              <input type="radio" name="archiveFormat" checked={archiveFormatDraft === "zip"} onChange={() => setArchiveFormatDraft("zip")} />
              <span><strong>zip archive</strong><small>Widely supported by desktop archive tools and other operating systems.</small></span>
            </label>
            <label className="archive-format-option">
              <input type="radio" name="archiveFormat" checked={archiveFormatDraft === "queue"} onChange={() => setArchiveFormatDraft("queue")} />
              <span><strong>Queue (one file at a time)</strong><small>No archive step; each file is downloaded individually and tracked in the Transfer Queue.</small></span>
            </label>
            <div className="modal-actions">
              <button type="button" className="confirm" onClick={() => archiveFormatDraft === "queue" ? enqueueQueueDownload() : enqueueDownload(archiveFormatDraft)}>Add to Transfer Queue</button>
              <button type="button" onClick={() => setArchiveFormatOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {uploadDestinationOpen && (
        <div className="modal-cover" onMouseDown={() => setUploadDestinationOpen(false)}>
          <div className="modal destination-modal" onMouseDown={(event) => event.stopPropagation()}>
            <h2>Upload Log destination</h2>
            <p className="muted">Choose the API Remote folder for this log package. The default is Personal/{session.username || "username"} when available.</p>
            <label>
              Remote folder path
              <input
                value={uploadDestinationPath}
                onChange={(event) => setUploadDestinationPath(event.target.value.replace(/^\/+/, ""))}
                placeholder="Personal/username"
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="confirm" onClick={() => queueSavedLogUpload(uploadDestinationPath.trim(), uploadSessionId)}>Upload here</button>
              <button type="button" onClick={() => setUploadDestinationOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {queueOpen && (
        <div className="modal-cover" onMouseDown={() => setQueueOpen(false)}>
          <div className="modal queue-modal" style={modalStyle("queue")} onMouseDown={(event) => event.stopPropagation()}>
            <h2 className="modal-drag-handle" onMouseDown={beginModalDrag("queue")}>Transfer Queue</h2>
            {!transferQueue.length && <p className="muted">No transfers queued.</p>}
            {activeTransferQueue.length > 0 && <section className="queue-section"><h3>Active</h3>{activeTransferQueue.map(renderDesktopQueueItem)}</section>}
            {transferHistory.length > 0 && <section className="queue-section"><h3>History</h3>{transferHistory.map(renderDesktopQueueItem)}</section>}
            <div className="modal-actions">
              {transferQueue.some((item) => item.status === "completed") && <button type="button" onClick={() => clearQueueStatus("completed")}>Clear completed</button>}
              {transferQueue.some((item) => item.status === "failed") && <button type="button" onClick={() => clearQueueStatus("failed")}>Clear failed</button>}
              {transferQueue.some((item) => item.status === "cancelled") && <button type="button" onClick={() => clearQueueStatus("cancelled")}>Clear cancelled</button>}
              {transferQueue.some((item) => ["completed", "failed", "cancelled"].includes(item.status)) && <button type="button" onClick={clearFinishedQueue}>Clear history</button>}
              <button type="button" onClick={() => setQueueOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {viewerOpen && (
        <div className="modal-cover" onMouseDown={() => setViewerOpen(false)}>
          <div className="modal viewer-modal" style={modalStyle("viewer")} onMouseDown={(event) => event.stopPropagation()}>
            <h2 className="modal-drag-handle" onMouseDown={beginModalDrag("viewer")}>{viewerTitle}</h2>
            <p className="muted">Read-only viewer. Edit opens this file in the default text editor.</p>
            <textarea className="file-viewer" value={viewerContent} readOnly spellCheck={false} />
            <div className="modal-actions">
              <button type="button" onClick={editViewerFile}>Edit in text editor</button>
              <button type="button" onClick={() => void navigator.clipboard.writeText(viewerContent).then(() => notify("File content copied."))}>Copy</button>
              <button type="button" onClick={() => setViewerOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
