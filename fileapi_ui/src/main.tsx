import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import { selectActiveQueueItems, selectQueueHistory } from "./queue/selectors";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon, CloseIcon, CollapseIcon, DiamondIcon, ExpandIcon, SortAscIcon, SortDescIcon, WarningIcon } from "./ui/icons";
import { Dropdown } from "./ui/Dropdown";
// `@xterm/xterm`/`@xterm/addon-fit` (and their CSS) are dynamically
// imported inside the terminal-setup effect below instead of eagerly here:
// they're only ever needed once the user actually opens the SSH terminal
// panel, and eagerly bundling a terminal emulator into the app's critical
// startup path measurably delays first paint for no benefit to everyone who
// never opens a terminal in a given session. Only the *type* is imported
// here, which TypeScript/esbuild erases entirely at build time (no runtime
// cost, so it doesn't defeat the point of the dynamic import below).
import type { Terminal } from "@xterm/xterm";
import { themePresets, themeStyle, type ThemePreset } from "./styles/theme";
// Single ordered global-style entry point (T-018): tokens/base CSS first,
// feature-component CSS in the middle, override CSS (theme-overrides.css,
// surface-overrides.css) always last. See styles/index.css for the full
// contract and why the previous 18 separate imports here were consolidated.
import "./styles/index.css";
import { helpPages, helpSections } from "./help/help-content";
import type { OperationLogRecord } from "./log-view";
import type { RestApiEntry, RestApiSecret } from "./rest-api";
import type { ProxmoxVncEntry, ProxmoxVncSecret } from "./proxmox-vnc";
import { PaneResizeHandle } from "./resizable-pane";
import { ContextPicker, type ContextPickerGroup } from "./context-picker";
import { AppShell } from "./app/AppShell";
import { DesktopTitlebar } from "./app/DesktopTitlebar";
import { FloatingWindow } from "./ui/FloatingWindow";
import { useTerminalLifecycle } from "./features/terminal/useTerminalLifecycle";
import { useSshEventBridge } from "./features/terminal/useSshEventBridge";
import { isMobileViewport } from "./styles/breakpoints";

const RestApiWorkspace = lazy(() => import("./rest-api").then(({ RestApiWorkspace: component }) => ({ default: component })));
const VncWorkspaceController = lazy(() => import("./features/vnc/VncWorkspaceController").then(({ VncWorkspaceController: component }) => ({ default: component })));
const QueueModal = lazy(() => import("./features/queue/QueueModal").then(({ QueueModal: component }) => ({ default: component })));
const ViewerModal = lazy(() => import("./features/viewer/ViewerModal").then(({ ViewerModal: component }) => ({ default: component })));
const HelpModal = lazy(() => import("./features/help/HelpModal").then(({ HelpModal: component }) => ({ default: component })));
const LogView = lazy(() => import("./log-view").then(({ LogView: component }) => ({ default: component })));

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
  saveUserInformation: boolean;
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
  userId?: number | string;
  creatorUsername?: string;
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
type NativeApiResponse = { status: number; body: number[]; headers?: [string, string][] };
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
type LocalDirectoryChildren = {
  path: string;
  directories: { name: string; path: string }[];
};
type ManagedSession = {
  id: string;
  name: string;
  sshEntries: SshProfile[];
  restApiEntries: RestApiEntry[];
  proxmoxVncEntries: ProxmoxVncEntry[];
};
type ColumnKey = "name" | "modified" | "size";
type SortKey = ColumnKey;
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
  operationId?: string;
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
  uiProfile: "auto" | "mobile";
  theme: ThemePreset;
  accentColor: string;
  proxmoxVncModeEnabled: boolean;
  collapseMainPaneEnabled: boolean;
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
type SettingsPanel = "theme" | "features" | "confirmations" | "sharing" | "history";

type ModalDragId =
  | "log-view"
  | "help"
  | "settings"
  | "sessions"
  | "workspace-name"
  | "ssh-entry"
  | "rest-entry"
  | "vnc-entry"
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
    const item = raw as Partial<ManagedSession> & { entries?: Array<{ kind?: string; sshProfile?: SshProfile }> };
    const entries = Array.isArray(item.entries) ? item.entries : [];
    const sshEntries = Array.isArray(item.sshEntries)
      ? item.sshEntries
      : entries.filter((entry) => entry.kind === "SSH").map((entry) => entry.sshProfile).filter(Boolean) as SshProfile[];
    const restApiEntries = Array.isArray(item.restApiEntries)
      ? item.restApiEntries.map((rawEntry) => {
        const entry = rawEntry as RestApiEntry;
        const vendor = entry.vendor === "hpe" || entry.vendor === "openbmc" || entry.vendor === "none"
          ? entry.vendor
          : "none";
        return { ...entry, vendor };
      })
      : [];
    const proxmoxVncEntries = Array.isArray(item.proxmoxVncEntries) ? item.proxmoxVncEntries : [];
    return {
      id: item.id || crypto.randomUUID(),
      name: item.name || "Default",
      sshEntries,
      restApiEntries,
      proxmoxVncEntries,
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

type CommandBarOverflowAction = {
  key: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
};

// Narrow commandbars cannot show every action at full label width (see
// styles/commandbar.css); rather than truncating every button into an
// unreadable "…", secondary actions collapse behind this one trigger.
// Portaled to document.body (mirrors ContextPicker) because .commandbar
// has overflow:hidden, which would otherwise clip a normally-positioned
// popover before it ever became visible.
function CommandBarOverflowMenu({ label, actions }: { label: string; actions: CommandBarOverflowAction[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({ visibility: "hidden" });

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !(event.target as HTMLElement).closest(".commandbar-overflow-options")) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const reposition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.max(190, rect.width);
      const maxHeight = Math.min(420, Math.max(140, window.innerHeight - 24));
      const gap = 6;
      const belowTop = rect.bottom + gap;
      const aboveTop = rect.top - gap - maxHeight;
      const top = belowTop + maxHeight <= window.innerHeight - 12
        ? belowTop
        : aboveTop >= 12
          ? aboveTop
          : Math.max(12, Math.min(belowTop, window.innerHeight - maxHeight - 12));
      const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
      setPopoverStyle({ top, left, width, maxHeight, visibility: "visible" });
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`mobile-choice-menu commandbar-overflow${open ? " open" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="mobile-choice-trigger commandbar-overflow-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <span>{label}</span>
        <span aria-hidden="true">{open ? <ChevronLeftIcon /> : <ChevronRightIcon />}</span>
      </button>
      {open && createPortal(
        <div className="mobile-choice-options commandbar-overflow-options" style={popoverStyle} role="menu" aria-label={label}>
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              title={action.title}
              onClick={() => {
                action.onClick();
                setOpen(false);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>,
        document.body,
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
  saveUserInformation: false,
  onlyTerminalMode: false,
};
const sessionRegistryKey = "fileapi-session-registry";
const desktopSettingsKey = "nfterm-settings";
const queueStorageKey = "nfterm-transfer-queue";
const apiCredentialEntryId = "api-login";

const readPersistedQueue = (): TransferQueueItem[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(queueStorageKey) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is TransferQueueItem => Boolean(item && typeof item.id === "string" && typeof item.status === "string"))
      .map((item) => {
        const withOperationId = { ...item, operationId: item.operationId || item.id };
        if (!["queued", "running", "retrying"].includes(item.status)) return withOperationId;
        const requiresRequeue = item.kind === "download" && !item.sshEntryId;
        return {
          ...withOperationId,
          status: "needs_user_action",
          errorCategory: "unknown",
          detail: requiresRequeue
            ? "Transfer was interrupted when nFterm closed. Re-add it to authenticate again."
            : "Transfer was interrupted when nFterm closed. Review and retry it.",
          error: {
            category: "unknown",
            message: "Transfer was interrupted when nFterm closed.",
            itemId: item.id,
            path: item.paths?.[0],
            attempt: item.retryCount || 0,
            timestamp: Date.now(),
          },
        };
      });
  } catch {
    return [];
  }
};
const defaultDesktopSettings: DesktopSettings = {
  uiProfile: "auto",
  theme: "bridge",
  accentColor: "#63e6ff",
  proxmoxVncModeEnabled: false,
  collapseMainPaneEnabled: false,
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
  directoriesFirst = false,
) => {
  if (directoriesFirst && left.isDirectory !== right.isDirectory) {
    return left.isDirectory ? -1 : 1;
  }
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
const sortFileItems = (
  items: FileItem[],
  sortKey: SortKey,
  direction: SortDirection,
  directoriesFirst = false,
) => [...items].sort((left, right) =>
  compareFileItems(left, right, sortKey, direction, directoriesFirst));
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

type DesktopAppProps = {
  session: Session;
  setSession: React.Dispatch<React.SetStateAction<Session>>;
  password: string;
  setPassword: React.Dispatch<React.SetStateAction<string>>;
  busy: boolean;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  notice: string;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
};

type LoginScreenProps = {
  session: Session;
  setSession: React.Dispatch<React.SetStateAction<Session>>;
  password: string;
  setPassword: React.Dispatch<React.SetStateAction<string>>;
  busy: boolean;
  notice: string;
  uiProfile: "auto" | "mobile";
  onUiProfileChange: (profile: "auto" | "mobile") => void;
  onSubmit: (event: React.FormEvent) => void;
  onOnlyTerminal: () => void;
};

function LoginScreen({ session, setSession, password, setPassword, busy, notice, uiProfile, onUiProfileChange, onSubmit, onOnlyTerminal }: LoginScreenProps) {
  // Auto profile sizing must flip to Mobile at the exact same threshold as
  // DesktopApp's own mobileLayout check, via the one shared resolver --
  // not a hand-copied CSS media query mirroring the same numbers (T-027).
  const [loginViewport, setLoginViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const updateViewport = () => setLoginViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);
  const loginMobileLayout = uiProfile === "mobile" || (uiProfile === "auto" && isMobileViewport(loginViewport));
  const updateSaveUserInformation = (enabled: boolean) => {
    setSession((current) => ({ ...current, saveUserInformation: enabled }));
    if (!enabled) {
      void Promise.all([
        invoke("rest_forget_secret", { entryId: apiCredentialEntryId, kind: "username" }),
        invoke("rest_forget_secret", { entryId: apiCredentialEntryId, kind: "password" }),
      ]).catch(() => undefined);
    }
  };

  return (
    <main className={`login ui-profile-${uiProfile} ui-layout-${loginMobileLayout ? "mobile" : "desktop"}`}>
      <form onSubmit={onSubmit}>
        <div className="login-mark" aria-hidden="true"><span /></div>
        <h1>nFterm {appVersion && <small className="login-version">{appVersion}</small>}</h1>
        <p>Sign in to your API server over HTTPS.</p>
        <label>Server address<input placeholder="files.example.internal" value={session.host} onChange={(event) => setSession((current) => ({ ...current, host: event.target.value }))} /></label>
        <label>HTTPS port<input inputMode="numeric" value={session.port} onChange={(event) => setSession((current) => ({ ...current, port: event.target.value }))} /></label>
        <label>Username<input value={session.username} onChange={(event) => setSession((current) => ({ ...current, username: event.target.value }))} /></label>
        <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <div className="login-toggle-row" role="group" aria-label="Login options">
          <button type="button" className={`login-toggle-button${session.ignoreTlsErrors ? " enabled" : ""}`} aria-pressed={session.ignoreTlsErrors} onClick={() => setSession((current) => ({ ...current, ignoreTlsErrors: !current.ignoreTlsErrors }))} title="Disable HTTPS certificate verification for this API server">
            <span className="mode-switch-dot" aria-hidden="true" /><span>IGNORE SSL</span>
          </button>
          <button type="button" className={`login-toggle-button${session.saveUserInformation ? " enabled" : ""}`} aria-pressed={session.saveUserInformation} onClick={() => updateSaveUserInformation(!session.saveUserInformation)} title="Save the API username and password in the OS credential store">
            <span className="mode-switch-dot" aria-hidden="true" /><span>SAVE USER INFO</span>
          </button>
          <Dropdown
            className="login-profile-menu"
            label="Interface profile"
            value={uiProfile}
            onChange={(profile) => onUiProfileChange(profile as "auto" | "mobile")}
            options={[
              { value: "auto", label: "Auto" },
              { value: "mobile", label: "Large" },
            ]}
          />
        </div>
        <p className="login-toggle-help">Ignore SSL disables certificate verification. Save User Information stores the username and password in the OS credential store.</p>
        <button disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
        {notice && <output role="alert">{notice}</output>}
      </form>
      {onlyTerminalAvailable && <button type="button" className="only-terminal-corner-button" disabled={busy} onClick={onOnlyTerminal} title="Skip login and the API server. Local Explorer and SSH Terminal only."><DiamondIcon className="status-glyph" size={10} /> Only Terminal</button>}
    </main>
  );
}

function App() {
  const [session, setSession] = useState<Session>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("nfterm-session") || "null") as Partial<Session> | null;
      return {
        ...initialSession,
        host: saved?.host || defaultHost,
        port: saved?.port || defaultPort,
        username: saved?.saveUserInformation === true ? saved?.username || "" : "",
        ignoreTlsErrors: saved?.ignoreTlsErrors === true,
        saveUserInformation: saved?.saveUserInformation === true,
      };
    } catch {
      return initialSession;
    }
  });
  const [password, setPassword] = useState("");
  useEffect(() => {
    if (!session.saveUserInformation) return undefined;
    let cancelled = false;
    void Promise.all([
      invoke<string | null>("rest_load_secret", { entryId: apiCredentialEntryId, kind: "username" }),
      invoke<string | null>("rest_load_secret", { entryId: apiCredentialEntryId, kind: "password" }),
    ])
      .then(([username, storedPassword]) => {
        if (cancelled) return;
        if (username !== null) setSession((current) => ({ ...current, username }));
        if (storedPassword !== null) setPassword(storedPassword);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [session.saveUserInformation]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [uiProfile, setUiProfile] = useState<DesktopSettings["uiProfile"]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(desktopSettingsKey) || "null");
      return saved?.uiProfile === "mobile" ? "mobile" : "auto";
    } catch {
      return "auto";
    }
  });
  const changeUiProfile = (profile: DesktopSettings["uiProfile"]) => {
    setUiProfile(profile);
    try {
      const saved = JSON.parse(localStorage.getItem(desktopSettingsKey) || "null");
      localStorage.setItem(desktopSettingsKey, JSON.stringify({ ...(saved || {}), uiProfile: profile }));
    } catch {
      localStorage.setItem(desktopSettingsKey, JSON.stringify({ uiProfile: profile }));
    }
  };

  useEffect(() => {
    localStorage.setItem("nfterm-session", JSON.stringify({
      host: session.host,
      port: session.port,
      username: session.saveUserInformation ? session.username : "",
      ignoreTlsErrors: session.ignoreTlsErrors,
      saveUserInformation: session.saveUserInformation,
      token: "",
    }));
  }, [session.host, session.port, session.username, session.ignoreTlsErrors, session.saveUserInformation]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      validateServer(session);
      const responseValue = await invoke<NativeApiResponse>("api_request", {
        url: `${serverUrl(session)}/auth/login`,
        method: "POST",
        headers: [["Content-Type", "application/json"]],
        body: Array.from(new TextEncoder().encode(JSON.stringify({ username: session.username, password }))),
        ignoreTlsErrors: session.ignoreTlsErrors,
      });
      const response = new ApiResponse(responseValue.status, responseValue.body);
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json();
      const authenticatedUsername = data.user.username || session.username;
      setSession((current) => ({ ...current, token: data.token, username: authenticatedUsername, userId: data.user.id ?? null, role: data.user.role ?? "user", permissions: data.user.permissions ?? [] }));
      if (session.saveUserInformation) {
        await Promise.all([
          invoke("rest_save_secret", { entryId: apiCredentialEntryId, kind: "username", value: authenticatedUsername }),
          invoke("rest_save_secret", { entryId: apiCredentialEntryId, kind: "password", value: password }),
        ]);
      } else {
        await Promise.all([
          invoke("rest_forget_secret", { entryId: apiCredentialEntryId, kind: "username" }),
          invoke("rest_forget_secret", { entryId: apiCredentialEntryId, kind: "password" }),
        ]);
      }
      setPassword("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const enterOnlyTerminalMode = () => {
    setPassword("");
    setSession((current) => ({ ...current, token: "only-terminal-mode", username: "only-terminal", userId: 0, role: "test", permissions: [], locationId: "", onlyTerminalMode: true }));
    setNotice("Only Terminal: skipped login and API server connection. Local Explorer and SSH Terminal are available; remote (REMOTE) features are disabled.");
  };

  if (!session.token) return <LoginScreen session={session} setSession={setSession} password={password} setPassword={setPassword} busy={busy} notice={notice} uiProfile={uiProfile} onUiProfileChange={changeUiProfile} onSubmit={login} onOnlyTerminal={enterOnlyTerminalMode} />;
  return <DesktopApp session={session} setSession={setSession} password={password} setPassword={setPassword} busy={busy} setBusy={setBusy} notice={notice} setNotice={setNotice} />;
}

function DesktopApp({ session, setSession, password, setPassword, busy, setBusy, notice, setNotice }: DesktopAppProps) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [localFiles, setLocalFiles] = useState<FileItem[]>([]);
  const [localPath, setLocalPath] = useState("");
  const [localSelected, setLocalSelected] = useState<string[]>([]);
  const localTreeCacheRef = useRef(new Map<string, FolderNode[]>());
  const localRequestGenerationRef = useRef(0);
  const localFilesFingerprintRef = useRef("");
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
  const [appMode, setAppMode] = useState<"location" | "rest" | "vnc">(() => {
    const saved = localStorage.getItem("fileapi-app-mode");
    let vncEnabled = false;
    try {
      vncEnabled = JSON.parse(localStorage.getItem(desktopSettingsKey) || "null")?.proxmoxVncModeEnabled === true;
    } catch {
      vncEnabled = false;
    }
    return saved === "rest" || (saved === "vnc" && vncEnabled) ? saved : "location";
  });
  const [path, setPath] = useState("");
  const [remoteSshEntryId, setRemoteSshEntryId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const selectionAnchorRef = useRef<string | null>(null);
  const localSelectionAnchorRef = useRef<string | null>(null);
  const [shareUrl, setShareUrl] = useState("");
  const [shareLinksOpen, setShareLinksOpen] = useState(false);
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [shareLinksLoading, setShareLinksLoading] = useState(false);
  const [sharePasswordOpen, setSharePasswordOpen] = useState(false);
  const [sharePasswordDraft, setSharePasswordDraft] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountMenuStyle, setAccountMenuStyle] = useState<React.CSSProperties>({});
  const [helpOpen, setHelpOpen] = useState(false);
  const [logViewOpen, setLogViewOpen] = useState(false);
  const [operationLogRecords, setOperationLogRecords] = useState<OperationLogRecord[]>([]);
  const [selectedHelpPageId, setSelectedHelpPageId] = useState("login");
  const [expandedHelpSections, setExpandedHelpSections] = useState<string[]>(["getting-started"]);
  const [locationMenuOpen, setLocationMenuOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState<SettingsPanel | null>(null);
  useEffect(() => { if (!settingsOpen) setSettingsPanel(null); }, [settingsOpen]);
  const [saveLogNameOpen, setSaveLogNameOpen] = useState(false);
  const [saveLogNameDraft, setSaveLogNameDraft] = useState("");
  const [saveLogDestinationPath, setSaveLogDestinationPath] = useState("");
  const [desktopSettings, setDesktopSettings] = useState<DesktopSettings>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(desktopSettingsKey) || "null");
      const uiProfile = ["auto", "mobile"].includes(saved?.uiProfile)
        ? saved.uiProfile
        : defaultDesktopSettings.uiProfile;
      const theme = Object.prototype.hasOwnProperty.call(themePresets, saved?.theme)
        ? saved.theme as ThemePreset
        : defaultDesktopSettings.theme;
      const accentColor = typeof saved?.accentColor === "string" && /^#[0-9a-f]{6}$/i.test(saved.accentColor)
        ? saved.accentColor
        : defaultDesktopSettings.accentColor;
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
      const proxmoxVncModeEnabled = typeof saved?.proxmoxVncModeEnabled === "boolean"
        ? saved.proxmoxVncModeEnabled
        : defaultDesktopSettings.proxmoxVncModeEnabled;
      const collapseMainPaneEnabled = typeof saved?.collapseMainPaneEnabled === "boolean"
        ? saved.collapseMainPaneEnabled
        : defaultDesktopSettings.collapseMainPaneEnabled;
      return {
        ...defaultDesktopSettings,
        ...saved,
        uiProfile,
        theme,
        accentColor,
        operationLogLevel,
        shareLinkExpirationDays,
        shareLinkMode,
        proxmoxVncModeEnabled,
        collapseMainPaneEnabled,
        confirmations: { ...defaultDesktopSettings.confirmations, ...(saved?.confirmations || {}) },
      };
    } catch {
      return defaultDesktopSettings;
    }
  });
  useEffect(() => {
    const variables = themeStyle(desktopSettings.theme, desktopSettings.accentColor);
    Object.entries(variables).forEach(([name, value]) => {
      if (typeof value === "string") document.documentElement.style.setProperty(name, value);
    });
  }, [desktopSettings.theme, desktopSettings.accentColor]);
  useEffect(() => {
    if (!desktopSettings.proxmoxVncModeEnabled && appMode === "vnc") setAppMode("location");
  }, [desktopSettings.proxmoxVncModeEnabled, appMode]);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const [storageInfo, setStorageInfo] = useState<OperationStorageInfo | null>(null);
  useEffect(() => {
    if (!logViewOpen) return undefined;
    const refresh = () => {
      void invoke<OperationLogRecord[]>("read_operation_logs")
        .then(setOperationLogRecords)
        .catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 1_000);
    return () => window.clearInterval(timer);
  }, [logViewOpen]);
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
  const [locationPaneCollapsed, setLocationPaneCollapsed] = useState<"left" | "right" | null>(null);
  useEffect(() => { setLocationPaneCollapsed(null); }, [splitMode, appMode]);
  const [managedSessions, setManagedSessions] = useState<ManagedSession[]>(() => {
    try {
      const saved = localStorage.getItem(sessionRegistryKey);
      const parsed = saved ? JSON.parse(saved) : [];
      return normalizeManagedSessions(parsed);
    } catch {
      return [];
    }
  });
  const [activeRestEntryId, setActiveRestEntryId] = useState("");
  const [restSecrets, setRestSecrets] = useState<Record<string, RestApiSecret>>({});
  const [restSessionHeaders, setRestSessionHeaders] = useState<Record<string, string>>({});
  const [activeVncEntryId, setActiveVncEntryId] = useState("");
  const [vncSecrets, setVncSecrets] = useState<Record<string, ProxmoxVncSecret>>({});
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
  const [folderPaneWidth, setFolderPaneWidth] = useState(() =>
    Number(localStorage.getItem("fileapi-folder-pane-width")) || 250,
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
  const [remoteDirectoriesFirst, setRemoteDirectoriesFirst] = useState(false);
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
  const [transferQueue, setTransferQueue] = useState<TransferQueueItem[]>(readPersistedQueue);
  const queueStoreRef = useRef(new QueueStore<TransferQueueItem>((items) => pruneQueueHistory(items, Date.now())));
  useEffect(() => {
    queueStoreRef.current.replace(transferQueue);
  }, [transferQueue]);
  useEffect(() => {
    // Persist queue visibility/history, but never persist request headers or
    // bodies because they may contain bearer tokens, cookies, or passwords.
    const persisted = transferQueue.map(({ downloadHeaders: _headers, downloadBody: _body, downloadUrl: _url, ...item }) => item);
    localStorage.setItem(queueStorageKey, JSON.stringify(persisted));
  }, [transferQueue]);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [archiveFormatOpen, setArchiveFormatOpen] = useState(false);
  const [archiveFormatDraft, setArchiveFormatDraft] = useState<"tar.gz" | "zip" | "queue">("tar.gz");
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
  const sshWriteQueuesRef = useRef(new Map<string, Promise<void>>());
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
  // Session Manager only shows the Workspace list/summary; adding or
  // editing an SSH entry happens in its own floating dialog on top of the
  // Sessions modal. REST API and Proxmox VNC entries use the exact same
  // pattern (see openAddRestEntryDialog/openAddVncEntryDialog below) --
  // their own mode's sidebar is read-only, just for selecting among
  // already-created entries, same as the SSH terminal panel's own sidebar.
  const [sshEntryDialogOpen, setSshEntryDialogOpen] = useState(false);
  const [restEntryDialogOpen, setRestEntryDialogOpen] = useState(false);
  const [restEntryDraft, setRestEntryDraft] = useState<RestApiEntry | null>(null);
  const [vncEntryDialogOpen, setVncEntryDialogOpen] = useState(false);
  const [vncEntryDraft, setVncEntryDraft] = useState<ProxmoxVncEntry | null>(null);
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
  // APP-internal file dragging is intentionally kept on the WebView HTML5
  // drag/drop path. Do not enable Tauri's Windows native drop target here:
  // WebView2 intercepts the same gesture before HTML5 dragover/drop, which
  // breaks LOCAL <-> API Remote and LOCAL <-> SFTP Remote transfers. External
  // Explorer drops are intentionally not supported unless a future Windows
  // implementation can provide separate native and in-app drag channels.
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
  const contextMenuRef = useRef<HTMLDivElement>(null);
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
      "log-view": logViewOpen,
      help: helpOpen,
      settings: settingsOpen,
      sessions: sessionsOpen,
      "workspace-name": workspaceNameDialogOpen,
      "ssh-entry": sshEntryDialogOpen,
      "rest-entry": restEntryDialogOpen,
      "vnc-entry": vncEntryDialogOpen,
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
  }, [helpOpen, logViewOpen, queueOpen, restEntryDialogOpen, sessionsOpen, settingsOpen, shareLinksOpen, sshEntryDialogOpen, vncEntryDialogOpen, viewerOpen, workspaceNameDialogOpen]);

  useEffect(() => {
    const closeTopmostOverlay = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;

      if (sshEntryDialogOpen) {
        setSshEntryDialogOpen(false);
      } else if (restEntryDialogOpen) {
        setRestEntryDialogOpen(false);
      } else if (vncEntryDialogOpen) {
        setVncEntryDialogOpen(false);
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
      } else if (helpOpen) {
        setHelpOpen(false);
      } else if (logViewOpen) {
        setLogViewOpen(false);
      } else if (archiveFormatOpen) {
        setArchiveFormatOpen(false);
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
    helpOpen,
    logViewOpen,
    locationMenuOpen,
    queueOpen,
    restEntryDialogOpen,
    saveLogNameOpen,
    sessionsOpen,
    settingsOpen,
    shareLinksOpen,
    sharePasswordOpen,
    sshEntryDialogOpen,
    vncEntryDialogOpen,
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

  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

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
    localStorage.setItem("fileapi-folder-pane-width", String(folderPaneWidth));
  }, [folderPaneWidth]);

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
      if (document.hidden) return;
      void refreshLocalFiles().catch((error) => {
        setNotice(error instanceof Error ? error.message : String(error));
      });
    }, 5000);
    return () => window.clearInterval(refreshTimer);
  }, [splitMode, localPath]);

  useEffect(() => {
    localStorage.setItem(sessionRegistryKey, JSON.stringify(managedSessions));
  }, [managedSessions]);

  useEffect(() => {
    localStorage.setItem("fileapi-app-mode", appMode);
  }, [appMode]);

  useEffect(() => {
    if (activeRestEntryId) return;
    const firstEntry = managedSessions.find((workspace) => workspace.restApiEntries.length)?.restApiEntries[0];
    if (firstEntry) setActiveRestEntryId(firstEntry.id);
  }, [activeRestEntryId, managedSessions]);

  useEffect(() => {
    if (activeVncEntryId) return;
    const firstEntry = managedSessions.find((workspace) => workspace.proxmoxVncEntries.length)?.proxmoxVncEntries[0];
    if (firstEntry) setActiveVncEntryId(firstEntry.id);
  }, [activeVncEntryId, managedSessions]);

  useEffect(() => {
    const entries = managedSessions.flatMap((workspace) => workspace.restApiEntries);
    let cancelled = false;
    void Promise.all(entries.flatMap((entry) => (["username", "password", "token", "apiKey", "cookie"] as const).map(async (kind) => {
      const value = await invoke<string | null>("rest_load_secret", { entryId: entry.id, kind }).catch(() => null);
      if (cancelled || value === null) return;
      setRestSecrets((current) => ({ ...current, [entry.id]: { ...current[entry.id], [kind]: value } }));
    })));
    return () => { cancelled = true; };
  }, [managedSessions.map((workspace) => workspace.restApiEntries.map((entry) => entry.id).join(",")).join("|")]);

  useEffect(() => {
    const entries = managedSessions.flatMap((workspace) => workspace.proxmoxVncEntries);
    void Promise.all(entries.map(async (entry) => {
      const value = await invoke<string | null>("proxmox_load_secret", { entryId: entry.id, kind: "password" }).catch(() => null);
      if (value !== null) setVncSecrets((current) => ({ ...current, [entry.id]: { ...current[entry.id], password: value } }));
    }));
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
      }).catch(() => {});
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
      sshEntries: [profile],
      restApiEntries: [],
      proxmoxVncEntries: [],
    }));
    setManagedSessions(migrated);
    setWorkspaceSessionId(migrated[0]?.id || "");
  }, [managedSessions.length, sshProfiles]);

  useSshEventBridge({
    tabsRef: sshTabsRef,
    pendingRequestsRef: pendingSshConnectRequestsRef,
    onOutput: (tabId, payload) => {
      const data = payload.data;
      const tab = sshTabsRef.current.find((item) => item.id === tabId);
      if (!tab) return;
      if (tab.sessionId !== payload.sessionId) setSshTabs((current) => current.map((item) => item.id === tabId ? { ...item, sessionId: payload.sessionId, connected: true } : item));
      setSshTabs((current) => current.map((item) => item.id === tabId ? { ...item, output: item.output + data, rawLog: item.recording ? item.rawLog + data : item.rawLog, plainLog: item.recording ? item.plainLog + stripAnsi(data) : item.plainLog } : item));
      if (tabId === activeSshTabIdRef.current) { sshOutputRef.current += data; terminalInstanceRef.current?.write(data); const promptText = stripAnsi(sshOutputRef.current.slice(-240)).replace(/\r/g, "").trimEnd(); sshSecretPromptRef.current = /(password|passphrase|verification code|token)[^\n:]*[:?]\s*$/i.test(promptText); }
    },
    onExit: (tabId, payload) => {
      setSshTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, connected: false, sessionId: "", output: `${item.output}${VT_SESSION_BOUNDARY_GUARD}\n${payload.data}\n` }));
      if (tabId === activeSshTabIdRef.current) { setSshConnected(false); sshConnectingRef.current = false; }
    },
  });

  useTerminalLifecycle({
    enabled: terminalOpen,
    hostRef: terminalHostRef,
    terminalRef: terminalInstanceRef,
    replayOutput: sshTabsRef.current.find((item) => item.id === activeSshTabId)?.output || "Select a saved SSH session or open the Session manager to add one.\r\n",
    boundaryGuard: VT_SESSION_BOUNDARY_GUARD,
    onResize: (cols, rows) => {
      const tab = sshTabsRef.current.find((item) => item.id === activeSshTabId);
      if (tab?.sessionId) void invoke("ssh_resize", { sessionId: tab.sessionId, cols, rows });
    },
    onData: (data, replaying) => {
      if (replaying) return;
      const tab = sshTabsRef.current.find((item) => item.id === activeSshTabId);
      if (!tab?.sessionId) return;
      const previous = sshWriteQueuesRef.current.get(tab.sessionId) || Promise.resolve();
      const next = previous.catch(() => undefined).then(() => invoke<void>("ssh_write", { sessionId: tab.sessionId, data }));
      sshWriteQueuesRef.current.set(tab.sessionId, next.catch(() => undefined));
      if (recordingRef.current && !sshSecretPromptRef.current) {
        if (data === "\r" || data === "\n") {
          if (shellInputRef.current.trim()) {
            const command = `[${new Date().toISOString()}] ${shellInputRef.current}\n`;
            commandLogRef.current += command;
            setSshTabs((current) => current.map((item) => item.id === tab.id ? { ...item, commandLog: item.commandLog + command } : item));
          }
          shellInputRef.current = "";
        } else if (data === "\u007f") shellInputRef.current = shellInputRef.current.slice(0, -1);
        else if (!data.startsWith("\u001b")) shellInputRef.current += data;
      }
    },
  });
  useEffect(() => {
    const closeAccountMenu = (event: MouseEvent) => {
      if (!accountControl.current?.contains(event.target as Node) && !(event.target as HTMLElement).closest(".account-menu"))
        setAccountOpen(false);
      if (!locationControl.current?.contains(event.target as Node))
        setLocationMenuOpen(false);
      if (!(event.target as HTMLElement).closest(".context-menu, .account-menu, .context-picker-popover"))
        setContextMenu(null);
    };
    window.addEventListener("click", closeAccountMenu);
    return () => window.removeEventListener("click", closeAccountMenu);
  }, []);

  useEffect(() => {
    if (!accountOpen) return;
    const reposition = () => {
      const rect = accountControl.current?.getBoundingClientRect();
      if (!rect) return;
       const top = rect.bottom + 10;
       setAccountMenuStyle({
         top,
         right: Math.max(12, window.innerWidth - rect.right),
         minWidth: 240,
         maxHeight: Math.max(160, window.innerHeight - top - 12),
       });
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [accountOpen]);

  useEffect(() => {
    if (accountOpen) accountControl.current?.querySelector<HTMLButtonElement>(".account-menu button:not(:disabled)")?.focus();
    if (locationMenuOpen) locationControl.current?.querySelector<HTMLButtonElement>(".location-menu button[aria-selected=\"true\"], .location-menu button:not(:disabled)")?.focus();
    if (contextMenu) contextMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [accountOpen, contextMenu, locationMenuOpen]);

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
    const operationId = crypto.randomUUID();
    const started = performance.now();
    const operation = sshEntryId ? "ssh_browse" : "api_browse";
    const source = sshEntryId ? `SSH: ${sshEntryId}` : "API Remote";
    writeOperationLog(operation, "started", source, nextPath, JSON.stringify({ operationId, path: nextPath, sshEntryId, locationId: session.locationId }), "DEBUG");
    try {
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
        writeOperationLog(operation, "completed", source, data.path || nextPath, JSON.stringify({ operationId, path: data.path || nextPath, fileCount: data.files?.length || 0, durationMs: Math.round(performance.now() - started), sshEntryId }), "INFO");
        return;
      }
      const response = await api(
        `/api/files?path=${encodeURIComponent(nextPath)}&sort=${remoteSortKey}&order=${remoteSortDirection}&directoriesFirst=${remoteDirectoriesFirst}`,
      );
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json();
      const files = data.files || [];
      setFiles(files);
      setPath(data.currentPath || "");
      setSearching(false);
      selectionAnchorRef.current = null;
      setSelected([]);
      writeOperationLog(operation, "completed", source, data.currentPath || nextPath, JSON.stringify({ operationId, path: data.currentPath || nextPath, fileCount: files.length, durationMs: Math.round(performance.now() - started), locationId: session.locationId, httpStatus: response.status }), "INFO");
    } catch (error) {
      writeOperationLog(operation, "failed", source, nextPath, JSON.stringify({ operationId, path: nextPath, durationMs: Math.round(performance.now() - started), failureType: "browse", errorMessage: describeError(error), locationId: session.locationId, sshEntryId }), "ERROR");
      throw error;
    }
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

  const updateLocalTreeNode = (data: LocalDirectory) => {
    const children = (data.files || [])
      .filter((file) => file.isDirectory)
      .map((file) => ({ path: file.path, name: file.name, expanded: false, loaded: false, children: [] }))
      .sort((left, right) => compareFileNames(left.name, right.name));
    setLocalTrees((trees) =>
      trees.map((tree) => tree.path === data.path
        ? { ...tree, expanded: true, loaded: true, children }
        : tree),
    );
  };

  const applyLocalFiles = (data: LocalDirectory) => {
    const files = data.files || [];
    const fingerprint = files.map((file) => `${file.path}\u0000${file.isDirectory ? "d" : "f"}\u0000${file.size}\u0000${file.modified}`).join("\u0001");
    if (fingerprint !== localFilesFingerprintRef.current) {
      localFilesFingerprintRef.current = fingerprint;
      setLocalFiles(files);
      setLocalSelected((current) => current.filter((item) => files.some((file) => file.path === item)));
    }
    setLocalPath(data.path || "");
    updateLocalTreeNode(data);
  };

  const loadLocalFiles = async (nextPath = localPath) => {
    const generation = ++localRequestGenerationRef.current;
    localTreeCacheRef.current.delete(nextPath);
    const operationId = crypto.randomUUID();
    const started = performance.now();
    writeOperationLog("local_browse", "started", `LOCAL: ~/${localPath || ""}`, `LOCAL: ~/${nextPath || ""}`, JSON.stringify({ operationId, path: nextPath }), "DEBUG");
    try {
      const data = await invoke<LocalDirectory>("local_list_directory", {
        path: nextPath,
      });
      if (generation !== localRequestGenerationRef.current) return;
      applyLocalFiles(data);
      writeOperationLog("local_browse", "completed", `LOCAL: ~/${localPath || ""}`, `LOCAL: ~/${data.path || nextPath || ""}`, JSON.stringify({ operationId, path: data.path || nextPath, fileCount: data.files?.length || 0, durationMs: Math.round(performance.now() - started) }), "INFO");
    } catch (error) {
      writeOperationLog("local_browse", "failed", `LOCAL: ~/${localPath || ""}`, `LOCAL: ~/${nextPath || ""}`, JSON.stringify({ operationId, path: nextPath, durationMs: Math.round(performance.now() - started), failureType: "list", errorMessage: describeError(error) }), "ERROR");
      throw error;
    }
  };

  const refreshLocalFiles = async () => {
    const generation = ++localRequestGenerationRef.current;
    const operationId = crypto.randomUUID();
    const started = performance.now();
    writeOperationLog("local_browse", "started", `LOCAL: ~/${localPath || ""}`, `LOCAL: ~/${localPath || ""}`, JSON.stringify({ operationId, path: localPath, action: "refresh" }), "DEBUG");
    try {
      const data = await invoke<LocalDirectory>("local_list_directory", {
        path: localPath,
      });
      if (generation !== localRequestGenerationRef.current) return;
      applyLocalFiles(data);
      writeOperationLog("local_browse", "completed", `LOCAL: ~/${localPath || ""}`, `LOCAL: ~/${data.path || localPath || ""}`, JSON.stringify({ operationId, path: data.path || localPath, fileCount: data.files?.length || 0, durationMs: Math.round(performance.now() - started), action: "refresh" }), "INFO");
    } catch (error) {
      writeOperationLog("local_browse", "failed", `LOCAL: ~/${localPath || ""}`, `LOCAL: ~/${localPath || ""}`, JSON.stringify({ operationId, path: localPath, durationMs: Math.round(performance.now() - started), failureType: "refresh", errorMessage: describeError(error) }), "ERROR");
      throw error;
    }
  };

  const loadLocalTreeChildren = async (treePath: string, force = false) => {
    const cachedChildren = !force ? localTreeCacheRef.current.get(treePath) : undefined;
    if (cachedChildren) {
      setLocalTrees((trees) => trees.map((tree) => updateTreeNode(tree, treePath, (node) => ({ ...node, expanded: true, loaded: true, children: cachedChildren }))));
      return;
    }
    const generation = ++localRequestGenerationRef.current;
    const operationId = crypto.randomUUID();
    const started = performance.now();
    writeOperationLog("local_folder_tree", "started", "LOCAL folder tree", `LOCAL: ~/${treePath || ""}`, JSON.stringify({ operationId, path: treePath }), "DEBUG");
    try {
      const data = await invoke<LocalDirectoryChildren>("local_list_directories", { path: treePath });
      if (generation !== localRequestGenerationRef.current) return;
      const children = (data.directories || [])
        .map((directory) => ({ path: directory.path, name: directory.name, expanded: false, loaded: false, children: [] }))
        .sort((left, right) => compareFileNames(left.name, right.name));
      localTreeCacheRef.current.set(treePath, children);
      setLocalTrees((trees) =>
        trees.map((tree) => updateTreeNode(tree, treePath, (node) => ({ ...node, expanded: true, loaded: true, children }))),
      );
      writeOperationLog("local_folder_tree", "completed", "LOCAL folder tree", `LOCAL: ~/${treePath || ""}`, JSON.stringify({ operationId, path: treePath, fileCount: children.length, durationMs: Math.round(performance.now() - started) }), "INFO");
    } catch (error) {
      // `force` is used for background/prefetch expansion where a failure
      // (e.g. a permission-denied subfolder) is tolerated and the tree node
      // is just left collapsed - but it must still be logged, not silently
      // dropped, so ERROR-level browse failures always show up somewhere.
      writeOperationLog("local_folder_tree", "failed", "LOCAL folder tree", `LOCAL: ~/${treePath || ""}`, JSON.stringify({ operationId, path: treePath, durationMs: Math.round(performance.now() - started), failureType: "tree", errorMessage: describeError(error) }), "ERROR");
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
    if (!session.token && !session.onlyTerminalMode) return undefined;
    void (async () => {
      try {
        await loadLocalFiles("");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    })();
    return undefined;
  }, [session.token, session.onlyTerminalMode]);

  useEffect(() => {
    if (!session.token && !session.onlyTerminalMode) return undefined;
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
      } catch {
        // Not fatal -- the LOCAL pane just stays confined to HOME as usual.
      }
    })();
    return undefined;
  }, [session.token, session.onlyTerminalMode]);

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
    writeOperationLog("location", "selected", session.locationId || "none", locationId || "none", "Location selected.", "INFO");
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
    writeOperationLog("ssh_browse", "selected", remoteSshEntryId || "none", entryId, "SSH browse entry selected.", "INFO");
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

  // Creates or renames a Workspace. SSH entries are added or edited
  // afterwards in their own floating dialog.
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
      : { id: makeId(), name, sshEntries: [], restApiEntries: [], proxmoxVncEntries: [] };
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
    const nextWidth = Math.max(220, Math.min(maxWidth, start.startWidth + (event.clientX - start.startX)));
    if (splitMode) setLocalPaneWidth(nextWidth);
    else setFolderPaneWidth(nextWidth);
  };
  const beginPaneResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    paneResizeRef.current = { startX: event.clientX, startWidth: splitMode ? localPaneWidth : folderPaneWidth };
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
    window.requestAnimationFrame(() => terminalInstanceRef.current?.focus());
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
      const workspace = managedSessions.find((item) => item.id === requestedWorkspaceId);
      if (workspace) {
        setWorkspaceSessionId(workspace.id);
        const profile = workspace.sshEntries[0] || sshProfiles.find((item) => item.id === sshProfileId);
        setSessionNameDraft(workspace.name);
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

  // REST API and Proxmox VNC entries follow the exact same add/edit/remove
  // shape as SSH above: the dialog lives here, keyed to whichever Workspace
  // card it was opened from (setWorkspaceSessionId right before opening).
  // RestApiWorkspace/ProxmoxVncWorkspace's own sidebar only lists and
  // selects entries -- it has no add/edit UI of its own, same as the SSH
  // terminal panel's sidebar.
  const emptyRestEntry = (): RestApiEntry => ({
    id: crypto.randomUUID(),
    name: "New REST API",
    baseUrl: "",
    defaultPath: "/rest/v1",
    query: [],
    ignoreTlsErrors: false,
    authMode: "none",
    vendor: "none",
    username: "",
    loginPath: "/auth/login",
    loginMethod: "POST",
    loginBody: '{"username":"{{username}}","password":"{{password}}"}',
    tokenPath: "data.token",
    tokenHeader: "X-Auth-Token",
    tokenSendAs: "X-Auth-Token",
  });

  const openAddRestEntryDialog = (workspaceId: string) => {
    setWorkspaceSessionId(workspaceId);
    setRestEntryDraft(emptyRestEntry());
    setSessionFormError("");
    setRestEntryDialogOpen(true);
  };

  const openEditRestEntryDialog = (workspaceId: string, entry: RestApiEntry) => {
    setWorkspaceSessionId(workspaceId);
    setRestEntryDraft(entry);
    setSessionFormError("");
    setRestEntryDialogOpen(true);
  };

  const isEditingRestEntry = (workspace: ManagedSession | undefined, draft: RestApiEntry | null) =>
    Boolean(workspace && draft && workspace.restApiEntries.some((item) => item.id === draft.id));

  const saveRestEntry = () => {
    const workspace = managedSessions.find((item) => item.id === workspaceSessionId);
    const draft = restEntryDraft;
    if (!workspace) {
      setSessionFormError("Save the Workspace name first, then add a REST API entry to it.");
      return;
    }
    if (!draft || !draft.name.trim() || !draft.baseUrl.trim()) {
      setSessionFormError("Connection name and base URL are required.");
      return;
    }
    const wasEditing = isEditingRestEntry(workspace, draft);
    setManagedSessions((current) => current.map((item) => item.id !== workspace.id ? item : {
      ...item,
      restApiEntries: wasEditing
        ? item.restApiEntries.map((candidate) => candidate.id === draft.id ? draft : candidate)
        : [...item.restApiEntries, draft],
    }));
    setActiveRestEntryId(draft.id);
    setRestEntryDraft(null);
    setSessionFormError("");
    setRestEntryDialogOpen(false);
    notify(`${wasEditing ? "Updated" : "Added"} REST API entry: ${draft.name}`);
  };

  const removeRestEntry = () => {
    const workspace = managedSessions.find((item) => item.id === workspaceSessionId);
    const draft = restEntryDraft;
    if (!workspace || !draft || !isEditingRestEntry(workspace, draft)) return;
    if (!window.confirm(`Remove REST API entry "${draft.name}"?`)) return;
    setManagedSessions((current) => current.map((item) => item.id !== workspace.id ? item : { ...item, restApiEntries: item.restApiEntries.filter((candidate) => candidate.id !== draft.id) }));
    localStorage.removeItem(`rest-api-history:${draft.id}`);
    setRestEntryDraft(null);
    setRestEntryDialogOpen(false);
  };

  const emptyVncEntry = (): ProxmoxVncEntry => ({
    id: crypto.randomUUID(),
    name: "New Proxmox VNC",
    baseUrl: "https://:8006",
    username: "root@pam",
    node: "",
    vmid: null,
    guestType: "qemu",
    proxmoxVersion: "auto",
    ignoreTlsErrors: false,
  });

  const openAddVncEntryDialog = (workspaceId: string) => {
    setWorkspaceSessionId(workspaceId);
    setVncEntryDraft(emptyVncEntry());
    setSessionFormError("");
    setVncEntryDialogOpen(true);
  };

  const openEditVncEntryDialog = (workspaceId: string, entry: ProxmoxVncEntry) => {
    setWorkspaceSessionId(workspaceId);
    setVncEntryDraft(entry);
    setSessionFormError("");
    setVncEntryDialogOpen(true);
  };

  const isEditingVncEntry = (workspace: ManagedSession | undefined, draft: ProxmoxVncEntry | null) =>
    Boolean(workspace && draft && workspace.proxmoxVncEntries.some((item) => item.id === draft.id));

  const vncEndpointParts = (baseUrl: string) => {
    const match = baseUrl.match(/^https:\/\/(\[[0-9a-fA-F:]*\]|[^/:]*)(?::(\d*))?/i);
    return { host: match?.[1] ?? "", port: match?.[2] ?? "" };
  };
  const vncUsernameParts = (username: string) => {
    const [account = "root", realm = "pam"] = username.split("@", 2);
    return { account, realm: realm === "pve" ? "pve" : "pam" };
  };

  const saveVncEntry = () => {
    const workspace = managedSessions.find((item) => item.id === workspaceSessionId);
    const draft = vncEntryDraft;
    const endpoint = draft ? vncEndpointParts(draft.baseUrl) : null;
    const port = endpoint ? Number(endpoint.port) : 0;
    const username = draft ? vncUsernameParts(draft.username) : null;
    if (!workspace) {
      setSessionFormError("Save the Workspace name first, then add a Proxmox VNC entry to it.");
      return;
    }
    if (!draft || !draft.name.trim() || !endpoint?.host || !port || port < 1 || port > 65535 || !username?.account.trim()) {
      setSessionFormError("Connection name, Proxmox host, and a valid port are required.");
      return;
    }
    const wasEditing = isEditingVncEntry(workspace, draft);
    setManagedSessions((current) => current.map((item) => item.id !== workspace.id ? item : {
      ...item,
      proxmoxVncEntries: wasEditing
        ? item.proxmoxVncEntries.map((candidate) => candidate.id === draft.id ? draft : candidate)
        : [...item.proxmoxVncEntries, draft],
    }));
    setActiveVncEntryId(draft.id);
    setVncEntryDraft(null);
    setSessionFormError("");
    setVncEntryDialogOpen(false);
    notify(`${wasEditing ? "Updated" : "Added"} Proxmox VNC entry: ${draft.name}`);
  };

  const removeVncEntry = () => {
    const workspace = managedSessions.find((item) => item.id === workspaceSessionId);
    const draft = vncEntryDraft;
    if (!workspace || !draft || !isEditingVncEntry(workspace, draft)) return;
    if (!window.confirm(`Remove Proxmox VNC entry "${draft.name}"?`)) return;
    setManagedSessions((current) => current.map((item) => item.id !== workspace.id ? item : { ...item, proxmoxVncEntries: item.proxmoxVncEntries.filter((candidate) => candidate.id !== draft.id) }));
    void invoke("proxmox_forget_secret", { entryId: draft.id, kind: "password" }).catch(() => {});
    setVncEntryDraft(null);
    setVncEntryDialogOpen(false);
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
    writeOperationLog("ssh_recording", "started", activeSshTab.sessionId || activeSshTab.id, "LOCAL recording buffer", JSON.stringify({ operationId: activeSshTab.id, recordingId: activeSshTab.id, sessionId: activeSshTab.sessionId, startedAt: new Date(startedAt).toISOString() }), "INFO");
    notify("SSH output recording started.");
  };

  const stopRecording = () => {
    if (!activeSshTab) return;
    setSshTabs((current) => current.map((item) => item.id === activeSshTab.id ? { ...item, recording: false } : item));
    writeOperationLog("ssh_recording", "stopped", activeSshTab.sessionId || activeSshTab.id, "LOCAL recording buffer", JSON.stringify({ operationId: activeSshTab.id, recordingId: activeSshTab.id, sessionId: activeSshTab.sessionId, startedAt: activeSshTab.recordingStartedAt ? new Date(activeSshTab.recordingStartedAt).toISOString() : null, endedAt: new Date().toISOString(), rawBytes: new TextEncoder().encode(activeSshTab.rawLog).length, commandCount: activeSshTab.commandLog.split("\n").filter(Boolean).length, durationMs: activeSshTab.recordingStartedAt ? Date.now() - activeSshTab.recordingStartedAt : undefined }), "INFO");
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
       const operationId = tab.id;
       const started = performance.now();
       try {
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
        writeOperationLog("ssh_recording", "saved", logName, `LOCAL: ~/${saveLogDestinationPath || ""}`, JSON.stringify({ operationId, recordingId: tab.id, sessionId: tab.sessionId, packagePaths: [paths.raw, paths.plain, paths.commands, paths.metadata], durationMs: Math.round(performance.now() - started), rawBytes: new TextEncoder().encode(tab.rawLog).length, commandCount: tab.commandLog.split("\n").filter(Boolean).length }), "INFO");
       setSaveLogNameOpen(false);
       notify(`Saved SSH logs to ${paths.raw}`);
       } catch (error) {
         writeOperationLog("ssh_recording", "save_failed", logName, `LOCAL: ~/${saveLogDestinationPath || ""}`, JSON.stringify({ operationId, recordingId: tab.id, durationMs: Math.round(performance.now() - started), failureType: "save", errorMessage: describeError(error) }), "ERROR");
         throw error;
       }
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

  const operationIds = useRef(new Map<string, { id: string; lastAt: number; startedAt: number }>());
  const writeOperationLog = (operation: string, status: string, sourceLabel: string, destinationLabel: string, detail: string, level: DesktopSettings["operationLogLevel"] = "INFO") => {
    if (!desktopSettings.operationLogEnabled) return;
    const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
    const lifecycleKey = `${operation}|${sourceLabel}|${destinationLabel}`;
    const now = Date.now();
    const previous = operationIds.current.get(lifecycleKey);
    const operationId = previous && now - previous.lastAt < 60_000 ? previous.id : crypto.randomUUID();
    const startedAt = previous && now - previous.lastAt < 60_000 ? previous.startedAt : now;
    operationIds.current.set(lifecycleKey, { id: operationId, lastAt: now, startedAt });
    if (levels[level] < levels[desktopSettings.operationLogLevel]) return;
    const structuredDetail = (() => {
      try {
        const parsed = JSON.parse(detail) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      } catch {
        return {};
      }
    })();
    const errorMessage = typeof structuredDetail.errorMessage === "string"
      ? structuredDetail.errorMessage
      : level === "ERROR" ? detail : undefined;
    const isFailure = level === "ERROR" || ["failed", "retry_exhausted", "save_failed"].includes(status);
    const itemCount = detail.match(/(\d+)\s+(?:item|file)s?/i)?.[1];
    const completedCount = detail.match(/(?:moved|uploaded|downloaded|deleted|extracted|created)\s+(\d+)\s+(?:item|file|folder)/i)?.[1];
    const archiveFormat = detail.match(/\b(zip|tar\.gz|tgz)\b/i)?.[1]?.toLowerCase();
    const archiveName = detail.match(/(?:created|extracted)\s+([^\s.]+(?:\.[a-z0-9.]+)?)/i)?.[1];
    const sourceType = /\b(local|ssh|remote|api)\b/i.exec(sourceLabel)?.[1]?.toUpperCase();
    const destinationType = /\b(local|ssh|remote|api|external)\b/i.exec(destinationLabel)?.[1]?.toUpperCase();
    void invoke("append_structured_operation_log", {
      level,
      mode: "desktop",
      operation,
      event: status,
      status,
      source: sourceLabel,
      destination: destinationLabel,
      detail,
      ...structuredDetail,
      timestamp: new Date().toISOString(),
      operationId: structuredDetail.operationId || operationId,
      correlationId: crypto.randomUUID(),
      ...(errorMessage ? { errorMessage } : {}),
      ...(structuredDetail.sourcePath === undefined ? { sourcePath: sourceLabel } : {}),
      ...(structuredDetail.destinationPath === undefined ? { destinationPath: destinationLabel } : {}),
      ...(itemCount && structuredDetail.itemCount === undefined ? { itemCount: Number(itemCount) } : {}),
      ...(completedCount && structuredDetail.completedCount === undefined ? { completedCount: Number(completedCount) } : {}),
      ...(["move", "rename", "undo"].includes(operation) ? { oldPath: structuredDetail.oldPath || sourceLabel, newPath: structuredDetail.newPath || destinationLabel } : {}),
      ...(sourceType && structuredDetail.sourceType === undefined ? { sourceType } : {}),
      ...(destinationType && structuredDetail.destinationType === undefined ? { destinationType } : {}),
      ...(archiveFormat && structuredDetail.archiveFormat === undefined ? { archiveFormat } : {}),
      ...(["compress", "extract"].includes(operation) ? { archiveName: structuredDetail.archiveName || archiveName || destinationLabel, collisionAttempt: structuredDetail.collisionAttempt ?? 0 } : {}),
      ...(["completed", "failed", "cancelled", "retry_exhausted", "save_failed"].includes(status) && structuredDetail.durationMs === undefined ? { durationMs: now - startedAt } : {}),
      ...(isFailure && !structuredDetail.failureType ? { failureType: "operation_failed" } : {}),
      ...(isFailure && !structuredDetail.errorCategory ? { errorCategory: "unknown" } : {}),
      ...(isFailure && structuredDetail.recoverable === undefined ? { recoverable: false } : {}),
      ...(isFailure && structuredDetail.needsUserAction === undefined ? { needsUserAction: true } : {}),
    }).catch(() => {});
  };
  const logQueueEvent = (item: TransferQueueItem, event: string, fields: Record<string, unknown> = {}, level: DesktopSettings["operationLogLevel"] = "INFO") => {
    const destination = item.kind === "upload"
      ? `${item.locationName}:${item.destinationPath || "/"}`
      : `LOCAL: ~/${item.localDestinationFolder || ""}`;
    writeOperationLog(
      item.kind === "upload" ? "upload" : "download",
      event,
      item.label,
      destination,
      JSON.stringify({
        sourceType: item.kind === "upload" ? "LOCAL" : "REMOTE",
        destinationType: item.kind === "upload" ? "REMOTE" : "LOCAL",
        itemCount: item.setFiles?.length || item.paths.length || 1,
        retryCount: item.retryCount || 0,
        bytesCompleted: item.progress?.completedBytes || 0,
        bytesTotal: item.progress?.totalBytes || undefined,
        completedItems: item.setCompleted || 0,
        totalItems: item.setFiles?.length || item.paths.length || 1,
        ...fields,
      }),
      level,
    );
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
    void invoke("cancel_transfer", { transferId: id })
      .then(() => logQueueEvent(current, "cancel_requested", { backendCancelSucceeded: true, alreadyRunning: current.status === "running" }))
      .catch((error) => logQueueEvent(current, "cancel_requested", { backendCancelSucceeded: false, alreadyRunning: current.status === "running", failureType: "cancel_command", errorMessage: describeError(error) }, "WARN"));
    updateQueueItem(id, { status: "cancelled", detail: "Cancelled by user." });
    logQueueEvent(current, "cancelled", { finalCancelledState: true });
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
        logQueueEvent(nextItem, "retrying", { attempt: retryCount + 1, maximumAttempts: 3, reason: recovery.category }, "WARN");
        logQueueEvent(nextItem, "retry_scheduled", { attempt: retryCount + 1, maximumAttempts: 3, reason: recovery.category, delayMs: retryDelayMs(retryCount + 1) }, "INFO");
        window.setTimeout(() => { logQueueEvent(nextItem, "retry_started", { attempt: retryCount + 1, maximumAttempts: 3 }); updateQueueItem(item.id, { status: "queued", detail: "Retry starting" }); void runQueuedUpload({ ...nextItem, status: "queued" }); }, retryDelayMs(retryCount + 1));
        return;
      }
      if (recovery.retryable) logQueueEvent(item, "retry_exhausted", { attempt: retryCount, maximumAttempts: 3, reason: recovery.category }, "ERROR");
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
        logQueueEvent(nextItem, "retrying", { attempt: retryCount + 1, maximumAttempts: 3, reason: recovery.category }, "WARN");
        logQueueEvent(nextItem, "retry_scheduled", { attempt: retryCount + 1, maximumAttempts: 3, reason: recovery.category, delayMs: retryDelayMs(retryCount + 1) });
        window.setTimeout(() => { logQueueEvent(nextItem, "retry_started", { attempt: retryCount + 1, maximumAttempts: 3 }); updateQueueItem(item.id, { status: "queued", detail: "Retry starting" }); void runQueuedDownload({ ...nextItem, status: "queued" }); }, retryDelayMs(retryCount + 1));
        return;
      }
      if (recovery.retryable) logQueueEvent(item, "retry_exhausted", { attempt: retryCount, maximumAttempts: 3, reason: recovery.category }, "ERROR");
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
        logQueueEvent(nextItem, "retrying", { attempt: retryCount + 1, maximumAttempts: 3, reason: recovery.category }, "WARN");
        logQueueEvent(nextItem, "retry_scheduled", { attempt: retryCount + 1, maximumAttempts: 3, reason: recovery.category, delayMs: retryDelayMs(retryCount + 1) });
        window.setTimeout(() => { logQueueEvent(nextItem, "retry_started", { attempt: retryCount + 1, maximumAttempts: 3 }); updateQueueItem(item.id, { status: "queued", detail: "Retry starting" }); void runQueuedDownloadSet({ ...nextItem, status: "queued" }); }, retryDelayMs(retryCount + 1));
        return;
      }
      if (recovery.retryable) logQueueEvent(item, "retry_exhausted", { attempt: retryCount, maximumAttempts: 3, reason: recovery.category }, "ERROR");
      updateQueueItem(item.id, { status: recovery.needsUserAction ? "needs_user_action" : "failed", detail: `[${recovery.category}] ${detail} (${completed}/${files.length} completed before failing)`, errorCategory: recovery.category });
      writeOperationLog("download", "failed", item.label, destinationLabel, `Queued download failed: ${detail}`, "ERROR");
    }
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

  const selectRestWorkspace = (id: string) => {
    selectWorkspaceSession(id);
    const workspace = managedSessions.find((item) => item.id === id);
    if (workspace?.restApiEntries[0]) setActiveRestEntryId(workspace.restApiEntries[0].id);
  };

  const selectVncWorkspace = (id: string) => {
    selectWorkspaceSession(id);
    const workspace = managedSessions.find((item) => item.id === id);
    if (workspace?.proxmoxVncEntries[0]) setActiveVncEntryId(workspace.proxmoxVncEntries[0].id);
  };

  const toggleSort = (
    column: ColumnKey,
    currentKey: SortKey,
    setKey: React.Dispatch<React.SetStateAction<SortKey>>,
    setDirection: React.Dispatch<React.SetStateAction<SortDirection>>,
    currentDirection: SortDirection,
  ) => {
    if (currentKey === column) {
      setDirection(currentDirection === "asc" ? "desc" : "asc");
      return;
    }
    setKey(column);
    setDirection("asc");
  };

  const sortedFiles = sortFileItems(files, remoteSortKey, remoteSortDirection, remoteDirectoriesFirst);
  const sortedLocalFiles = sortFileItems(localFiles, localSortKey, localSortDirection);
  const selectedItems = files.filter((file) => selected.includes(file.path));
  const localSelectedItems = localFiles.filter((file) => localSelected.includes(file.path));
  const activeTransferQueue = selectActiveQueueItems(transferQueue);
  const transferHistory = selectQueueHistory(transferQueue);
  // Whether the REMOTE file list should show an in-list "../" entry to go up
  // one level, mirroring LOCAL's own in-list ".." row instead of a separate
  // toolbar button. Root differs by source: SSH browsing is always
  // absolute-path-rooted at "/", while API-backed Locations use "" as root.
  const showRemoteUp = remoteSshEntryId ? path !== "/" : Boolean(path);
  const workspaceSessions = managedSessions.filter((item) => item.sshEntries.length > 0);
  const activeWorkspaceSession = workspaceSessions.find((item) => item.id === workspaceSessionId);
  // The Sessions modal's Workspace panel shows this regardless of whether it
  // has any SSH entries yet (unlike `activeWorkspaceSession` above, which is
  // scoped to the SSH terminal selector and only considers workspaces that
  // already have at least one SSH entry).
  const activeManagedWorkspace = managedSessions.find((item) => item.id === workspaceSessionId);
  const restWorkspace = activeManagedWorkspace || managedSessions.find((item) => item.restApiEntries.length) || managedSessions[0];
  const vncWorkspace = activeManagedWorkspace || managedSessions.find((item) => item.proxmoxVncEntries.length) || managedSessions[0];
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
        ".file-row, .file-tile, .local-file, .file-table th, button, input, a, .column-resize-handle, .pane-resize-handle",
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
    if (!additive) {
      if (pane === "local") {
        localSelectionAnchorRef.current = null;
        setLocalSelected([]);
      } else {
        selectionAnchorRef.current = null;
        setSelected([]);
      }
    }
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

  const canSearchRemote = Boolean(session.token && session.locationId && !session.onlyTerminalMode && !remoteSshEntryId);

  const searchFiles = () => {
    if (!canSearchRemote) return;
    return run(async () => {
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
  };

  const clearSearch = () => {
    setSearch("");
    if (searching) void run(() => loadFiles(pathBeforeSearch));
  };

  const renderSearchControl = () => (
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
        <button className="clear-search" onClick={clearSearch} aria-label="Clear search">
          <CloseIcon size={12} />
        </button>
      )}
    </div>
  );

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
      writeOperationLog("drag", "dropped", source === "local" ? "LOCAL" : "REMOTE", destination, JSON.stringify({ itemCount: items.length, sourceType: source === "local" ? "LOCAL" : "REMOTE", destinationType: source === "local" ? "REMOTE" : "LOCAL" }), "INFO");
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
    writeOperationLog("drag", "started", "REMOTE", file.path, JSON.stringify({ fileCount: items.length, source: "remote" }), "DEBUG");
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
    writeOperationLog("drag", "started", "LOCAL", file.path, JSON.stringify({ fileCount: items.length, source: "local" }), "DEBUG");
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
    // Windows native outbound drag is intentionally disabled. A failed drop
    // outside the app is reported by finishDragAfterDrop, which points the
    // user to the stable Download/Queue path instead.
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
    const source = dragSourceRef.current;
    window.setTimeout(() => {
      if (source === "remote" && dragSourceRef.current === "remote") {
        setNotice("Remote files cannot be dragged to Explorer. Use Download to save through the Queue.");
        writeOperationLog("drag", "cancelled", "REMOTE", "External file manager", JSON.stringify({ itemCount: dragItemsRef.current.length, sourceType: "REMOTE", destinationType: "EXTERNAL", reason: "unsupported_target" }), "WARN");
      }
      finishDrag();
    }, 0);
  };

  // Pane-wide "drop here" highlighting must only turn on while the pointer
  // is actually over that pane, not just because a compatible drag started
  // somewhere else. `onDragLeave` fires for every child boundary crossed
  // inside the pane too, so it only clears the hover flag once the related
  // target (where the pointer is going) is no longer inside this pane's
  // container -- otherwise the highlight would flicker off while moving
  // over child elements.
  const isExternalFileDrag = (event: React.DragEvent) =>
    dragSourceRef.current === "" && Array.from(event.dataTransfer.types).includes("Files");
  const notifyExternalFileDrag = (event: React.DragEvent) => {
    if (!isExternalFileDrag(event)) return false;
    setNotice("External files cannot be dropped directly. Use Upload to choose files for the current Remote.");
    return true;
  };
  const enterPaneDragHover = (pane: "local" | "remote") => (event: React.DragEvent) => {
    if (notifyExternalFileDrag(event)) return;
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
    if (item.kind === "download" && !item.sshEntryId && !item.downloadUrl) {
      setNotice("This restored download no longer contains its request credentials. Re-add the download to retry it safely.");
      return;
    }
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
      <div className="queue-item-header">
        <strong className="queue-item-label">{item.label}</strong>
        <span className={`queue-status ${item.status}`}>{item.status.replaceAll("_", " ")}</span>
      </div>
      <div className="queue-item-route">
        <span>{item.locationName}</span>
        <code>{item.destinationPath || "/"}</code>
      </div>
      <div className="queue-item-detail">{item.detail}</div>
      {item.progress && (["running", "queued", "retrying"].includes(item.status)) && (
        <div className="queue-item-progress"><small>{item.progress.completedBytes ? `${formatSize(item.progress.completedBytes)}${item.progress.totalBytes ? ` / ${formatSize(item.progress.totalBytes)}` : ""}` : "Waiting for transfer data"}{formatQueueProgress(item.progress)}</small></div>
      )}
      <div className="queue-item-actions">
        {(item.status === "running" || item.status === "queued" || item.status === "retrying") && (
          <button type="button" onClick={() => cancelQueueItem(item.id)}>Cancel</button>
        )}
        {(item.status === "failed" || item.status === "needs_user_action") &&
          (item.kind !== "download" || Boolean(item.sshEntryId) || Boolean(item.downloadUrl)) && (
          <button type="button" onClick={() => retryDesktopQueueItem(item)}>Retry</button>
        )}
        {(["completed", "failed", "cancelled"].includes(item.status)) && (
          <button type="button" onClick={() => removeQueueItem(item.id)}>Remove</button>
        )}
      </div>
    </div>
  );
  const queueDragPreparation = (
    item: TransferQueueItem,
    prepare: () => Promise<string>,
  ) => {
    const started = performance.now();
    writeOperationLog("drag", "started", item.locationName, item.destinationPath, JSON.stringify({ operationId: item.id, itemCount: item.paths.length || 1, sourceType: item.sshEntryId ? "SSH" : "API", destinationType: "LOCAL" }), "DEBUG");
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
        writeOperationLog("drag", "prepared", item.locationName, destination, JSON.stringify({ operationId: item.id, itemCount: item.paths.length || 1, stagingPath: destination, durationMs: Math.round(performance.now() - started) }), "INFO");
      } catch (error) {
        rejectPreparation(error);
        updateQueueItem(item.id, { status: "failed", detail: describeError(error), errorCategory: classifyQueueError(error).category });
        writeOperationLog("drag", "failed", item.locationName, item.destinationPath, JSON.stringify({ operationId: item.id, itemCount: item.paths.length || 1, durationMs: Math.round(performance.now() - started), failureType: "preparation", errorMessage: describeError(error) }), "ERROR");
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

  const openLocalFile = (filePath: string) =>
    void run(async () => {
      if (filePath.toLowerCase().endsWith(".pdf")) {
        await invoke("open_local_file", { path: filePath });
        notify("Opened the PDF in the default application.");
        return;
      }
      const content = await invoke<string>("read_local_file", { path: filePath });
      setViewerTitle(filePath.split(/[\\/]/).pop() || filePath);
      setViewerContent(content);
      setViewerLocalPath(filePath);
      setViewerRemotePath("");
      setViewerOpen(true);
    });

  const openLocalViewer = (filePath: string) => openLocalFile(filePath);

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
      const operationId = crypto.randomUUID();
      const started = performance.now();
      writeOperationLog("share", "started", sourceLabel, "Public share link", JSON.stringify({ operationId, locationId: session.locationId, filePath: item.path, mode: desktopSettings.shareLinkMode, expiration: desktopSettings.shareLinkExpirationDays, passwordConfigured: Boolean(password) }), "DEBUG");
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
         writeOperationLog("share", "completed", sourceLabel, "Public share link", JSON.stringify({ operationId, locationId: session.locationId, filePath: item.path, mode: desktopSettings.shareLinkMode, expiration: desktopSettings.shareLinkExpirationDays, passwordConfigured: Boolean(password), durationMs: Math.round(performance.now() - started) }));
        notify("Share link created.");
      } catch (error) {
         writeOperationLog("share", "failed", sourceLabel, "Public share link", JSON.stringify({ operationId, locationId: session.locationId, filePath: item.path, mode: desktopSettings.shareLinkMode, expiration: desktopSettings.shareLinkExpirationDays, passwordConfigured: Boolean(password), durationMs: Math.round(performance.now() - started), failureType: "share_request", errorMessage: describeError(error) }), "ERROR");
        throw error;
      }
    });

  const loadShareLinks = async () => {
    if (!session.token || session.onlyTerminalMode) return;
    setShareLinksLoading(true);
    try {
      const response = await api(session.role === "admin" ? "/api/admin/share-links" : "/api/files/shares");
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
      const response = await api(`${session.role === "admin" ? "/api/admin/share-links" : "/api/files/share"}/${encodeURIComponent(shareToken)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      await loadShareLinks();
      notify("Share link revoked.");
    });

  const deleteExpiredShareLink = (shareToken: string) =>
    run(async () => {
      const response = await api(`${session.role === "admin" ? "/api/admin/share-links" : "/api/files/share"}/${encodeURIComponent(shareToken)}/history`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      await loadShareLinks();
      notify("Expired share link removed from history.");
    });

  const deleteRevokedShareLink = (shareToken: string) =>
    run(async () => {
      const response = await api(`${session.role === "admin" ? "/api/admin/share-links" : "/api/files/share"}/${encodeURIComponent(shareToken)}/history/revoked`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      await loadShareLinks();
      notify("Revoked share link removed from history.");
    });

  const shareLinkStatus = (link: ShareLink) =>
    link.isExpired ? "Expired" : link.isExhausted ? "Exhausted" : link.isActive ? "Active" : "Revoked";
  const shareLinkGroups = [
    { key: "active", label: "Active", links: shareLinks.filter((link) => shareLinkStatus(link) === "Active") },
    { key: "revoked", label: "Revoked", links: shareLinks.filter((link) => shareLinkStatus(link) === "Revoked") },
    { key: "expired", label: "Expired", links: shareLinks.filter((link) => shareLinkStatus(link) === "Expired") },
    { key: "exhausted", label: "Exhausted", links: shareLinks.filter((link) => shareLinkStatus(link) === "Exhausted") },
  ].filter((group) => group.links.length > 0);

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

  const selectedHelpPage = helpPages.find((page) => page.id === selectedHelpPageId) || helpPages[0];
  const selectedHelpSection = helpSections.find((section) => section.pages.some((page) => page.id === selectedHelpPage.id)) || helpSections[0];
  const selectedHelpIndex = helpPages.findIndex((page) => page.id === selectedHelpPage.id);

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

  const renderLocalBreadcrumbs = () => {
    const segments = localBreadcrumbSegments(localPath);
    const absolute = isAbsoluteLocalPath(localPath);
    const rootLabel = absolute ? (segments[0]?.label || "/") : "~";
    const visibleSegments = absolute ? segments.slice(1) : segments;
    return (
      <div className="pane-breadcrumbs crumbs" aria-label="LOCAL path">
        <button onClick={() => void run(() => loadLocalFiles(absolute ? segments[0]?.target || "/" : ""))}>
          {rootLabel}
        </button>
        {visibleSegments.map((segment, index) => (
          <React.Fragment key={`local-pane-${segment.target}-${index}`}>
            <span className="crumb-separator">›</span>
            <button onClick={() => void run(() => loadLocalFiles(segment.target))}>
              {segment.label}
            </button>
          </React.Fragment>
        ))}
      </div>
    );
  };

  const renderRemoteBreadcrumbs = () => {
    const parts = path.split("/").filter(Boolean);
    return (
      <div className="pane-breadcrumbs crumbs" aria-label="REMOTE path">
        <button onClick={() => void run(() => loadFiles(remoteSshEntryId ? "/" : ""))}>/</button>
        {parts.map((part, index) => (
          <React.Fragment key={`remote-pane-${part}-${index}`}>
            <span className="crumb-separator">›</span>
            <button
              onClick={() => void run(() => loadFiles(remoteSshEntryId
                ? `/${parts.slice(0, index + 1).join("/")}`
                : parts.slice(0, index + 1).join("/")))}
            >
              {part}
            </button>
          </React.Fragment>
        ))}
      </div>
    );
  };
  const remoteSourceLabel = remoteSshEntryId
    ? `REMOTE (SSH: ${findSshProfileById(remoteSshEntryId)?.name || "Unknown"})`
    : `REMOTE (${activeLocation?.id || session.locationId || "Unknown"})`;

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
              {" "}<WarningIcon size={12} /> ROOT
            </span>
          )}
        </span>
        {renderLocalBreadcrumbs()}
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
          {localTreeOpen ? <ChevronLeftIcon /> : <ChevronRightIcon />}
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
          if (notifyExternalFileDrag(event)) return;
          if (dragSourceRef.current === "remote" && canDragRemoteToLocal && dragItemsRef.current.length) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDragLeave={leavePaneDragHover("local")}
        onDropCapture={(event) => {
          if (isExternalFileDrag(event)) {
            event.preventDefault();
            event.stopPropagation();
            notifyExternalFileDrag(event);
            return;
          }
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

  const mobileLayout = desktopSettings.uiProfile === "mobile"
    || (desktopSettings.uiProfile === "auto" && isMobileViewport(viewport));
  const contextLabel = appMode === "location" ? "LocationID" : appMode === "rest" ? "REST Entry" : "VNC Entry";
  const contextValue = appMode === "location"
    ? remoteSshEntryId ? `SSH: ${findSshProfileById(remoteSshEntryId)?.name || "Unknown"}` : activeLocation?.id || session.locationId || "No Location"
    : appMode === "rest"
      ? restWorkspace?.restApiEntries.find((entry) => entry.id === activeRestEntryId)?.name || "No REST Entry"
      : vncWorkspace?.proxmoxVncEntries.find((entry) => entry.id === activeVncEntryId)?.name || "No VNC Entry";
  const contextGroups: ContextPickerGroup[] = appMode === "location"
    ? [{ label: "Locations", options: [...locations.map((location) => ({ id: `location:${location.id}`, label: location.displayName, detail: location.id, selected: !remoteSshEntryId && location.id === session.locationId })), ...connectedSshBrowseOptions().map((entry) => ({ id: `ssh:${entry.id}`, label: `SSH: ${entry.name}`, selected: entry.id === remoteSshEntryId }))] }]
    : managedSessions.map((workspace) => ({ label: workspace.name, options: (appMode === "rest" ? workspace.restApiEntries : workspace.proxmoxVncEntries).map((entry) => ({ id: entry.id, label: entry.name, detail: entry.baseUrl, selected: entry.id === (appMode === "rest" ? activeRestEntryId : activeVncEntryId) })) })).filter((group) => group.options.length);
  const selectContext = (id: string) => {
    if (appMode === "location") {
      if (id.startsWith("location:")) void selectLocation(id.slice("location:".length));
      else if (id.startsWith("ssh:")) selectSshBrowse(id.slice("ssh:".length));
      return;
    }
    const workspace = managedSessions.find((item) => (appMode === "rest" ? item.restApiEntries : item.proxmoxVncEntries).some((entry) => entry.id === id));
    if (!workspace) return;
    setWorkspaceSessionId(workspace.id);
    if (appMode === "rest") setActiveRestEntryId(id);
    else setActiveVncEntryId(id);
  };

  const openLogView = () => {
    setAccountOpen(false);
    void run(async () => {
      const records = await invoke<OperationLogRecord[]>("read_operation_logs");
      setOperationLogRecords(records);
      setLogViewOpen(true);
    });
  };

  const exportOperationLog = () => {
    const content = operationLogRecords.map((record) => JSON.stringify(record)).join("\n");
    void invoke<string | null>("save_text_file", { name: "nfterm-operations.jsonl", content })
      .then((savedPath) => { if (savedPath) notify(`Operation log exported to ${savedPath}`); })
      .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  };

      return (
    <AppShell style={themeStyle(desktopSettings.theme, desktopSettings.accentColor)} className={`explorer ui-profile-${desktopSettings.uiProfile} ui-layout-${mobileLayout ? "mobile" : "desktop"} ${appMode !== "location" ? "rest-mode" : ""} ${appMode === "vnc" ? "vnc-mode" : ""}`}>
      <Suspense fallback={null}>
      <DesktopTitlebar
        appMode={appMode}
        vncEnabled={desktopSettings.proxmoxVncModeEnabled}
        session={session}
        accountOpen={accountOpen}
        accountControl={accountControl}
        accountMenuStyle={accountMenuStyle}
        mobileLayout={mobileLayout}
        onModeChange={setAppMode}
        onAccountToggle={(event) => {
          event.stopPropagation();
          setAccountOpen((open) => !open);
        }}
        onOpenSessions={() => { setAccountOpen(false); openSessionsModal(); }}
        onOpenSettings={() => { setAccountOpen(false); setSettingsOpen(true); refreshStorageInfo(); }}
        onChangePassword={() => { setAccountOpen(false); setChangePasswordOpen(true); }}
        onOpenLogView={openLogView}
        onOpenHelp={() => { setAccountOpen(false); setHelpOpen(true); }}
        onSignOut={signOut}
      />
      <nav className="commandbar" aria-label={appMode === "rest" ? "REST API actions" : "File actions"}>
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
        {mobileLayout ? (
          <CommandBarOverflowMenu
            label="More actions"
            actions={[
              {
                key: "view",
                label: "View",
                disabled: splitMode && activePane === "local"
                  ? busy || localSelectedItems.length !== 1 || localSelectedItems[0].isDirectory
                  : busy ||
                    !locationOnline ||
                    selectedItems.length !== 1 ||
                    selectedItems[0].isDirectory ||
                    !!remoteSshEntryId ||
                    !hasCapability("read"),
                onClick: () =>
                  splitMode && activePane === "local"
                    ? openLocalViewer(localSelectedItems[0].path)
                    : openRemoteViewer(selectedItems[0]),
              },
              {
                key: "move",
                label: "Move",
                disabled:
                  busy ||
                  (splitMode && activePane === "local") ||
                  !selectedItems.length ||
                  !(remoteSshEntryId ? true : locationOnline && hasCapability("move")),
                onClick: () => notify("Drag selected files to a destination folder to move them."),
              },
              {
                key: "rename",
                label: "Rename",
                disabled: splitMode && activePane === "local"
                  ? busy || localSelectedItems.length !== 1
                  : busy ||
                    selectedItems.length !== 1 ||
                    !(remoteSshEntryId ? true : locationOnline && hasCapability("rename")),
                onClick: rename,
              },
              {
                key: "share",
                label: "Share",
                disabled:
                  busy ||
                  (splitMode && activePane === "local") ||
                  !locationOnline ||
                  selectedItems.length !== 1 ||
                  selectedItems[0].isDirectory ||
                  !!remoteSshEntryId ||
                  !hasCapability("share"),
                onClick: share,
              },
              {
                key: "delete",
                label: "Delete",
                disabled: splitMode && activePane === "local"
                  ? busy || !localSelectedItems.length
                  : busy ||
                    !selectedItems.length ||
                    !(remoteSshEntryId ? true : locationOnline && hasCapability("delete")),
                onClick: remove,
              },
              {
                key: "undo",
                label: "Undo",
                disabled: busy || !undoStack.length,
                title: undoStack.length ? `Undo: ${undoStack[undoStack.length - 1].description}` : "No operation to undo",
                onClick: undoLastOperation,
              },
              {
                key: "select-all",
                label: "Select all",
                onClick: () =>
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
                      ),
              },
            ]}
          />
        ) : (
          <>
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
          </>
        )}
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
        <button
          onClick={() => {
            void loadLocations();
            void run(() => loadFiles(path));
          }}
          disabled={busy}
        >
          Refresh
        </button>
         <ContextPicker label={contextLabel} value={contextValue} groups={contextGroups} onSelect={selectContext} disabled={busy} />
      </nav>
       <div className={appMode === "location" ? `desktop-workspace${splitMode ? " split-workspace" : ""}${locationPaneCollapsed ? ` pane-collapse-${locationPaneCollapsed}` : ""}` : "mode-workspace"}>
         {appMode === "rest" ? (
          <RestApiWorkspace
            workspaceName={restWorkspace?.name || "No Workspace"}
            entries={restWorkspace?.restApiEntries || []}
             activeEntryId={activeRestEntryId}
             secrets={restSecrets}
             sessionHeaders={restSessionHeaders}
             collapseMainPaneEnabled={desktopSettings.collapseMainPaneEnabled}
            onSelectEntry={setActiveRestEntryId}
            onChangeEntries={(entries) => {
              if (restWorkspace) {
                setManagedSessions((current) => current.map((workspace) => workspace.id === restWorkspace.id ? { ...workspace, restApiEntries: entries } : workspace));
                return;
              }
              const id = crypto.randomUUID();
      setManagedSessions([{ id, name: "Default", sshEntries: [], restApiEntries: entries, proxmoxVncEntries: [] }]);
              setWorkspaceSessionId(id);
            }}
            onChangeSecret={(entryId, secret) => {
              setRestSecrets((current) => ({ ...current, [entryId]: secret }));
              (Object.keys(secret) as (keyof RestApiSecret)[]).forEach((kind) => {
                const value = secret[kind];
                if (value) {
                  void invoke("rest_save_secret", { entryId, kind, value });
                } else {
                  void invoke("rest_forget_secret", { entryId, kind });
                }
              });
            }}
            onChangeSessionHeaders={(entryId, headers) => {
              const token = headers["X-Auth-Token"] || "";
              setRestSessionHeaders((current) => ({ ...current, [entryId]: token }));
              if (token) void invoke("rest_save_secret", { entryId, kind: "token", value: token });
              else void invoke("rest_forget_secret", { entryId, kind: "token" });
            }}
          />
         ) : appMode === "vnc" ? (
            <VncWorkspaceController
              key={vncWorkspace?.id || "default-vnc-workspace"}
              workspaceName={vncWorkspace?.name || "No Workspace"}
             entries={vncWorkspace?.proxmoxVncEntries || []}
              activeEntryId={activeVncEntryId}
              secrets={vncSecrets}
              collapseMainPaneEnabled={desktopSettings.collapseMainPaneEnabled}
              onSelectEntry={setActiveVncEntryId}
             onChangeEntries={(entries) => {
               if (vncWorkspace) {
                 setManagedSessions((current) => current.map((workspace) => workspace.id === vncWorkspace.id ? { ...workspace, proxmoxVncEntries: entries } : workspace));
                 return;
               }
               const id = crypto.randomUUID();
               setManagedSessions([{ id, name: "Default", sshEntries: [], restApiEntries: [], proxmoxVncEntries: entries }]);
               setWorkspaceSessionId(id);
             }}
             onChangeSecret={(entryId, secret) => {
               setVncSecrets((current) => ({ ...current, [entryId]: secret }));
               if (secret.password) void invoke("proxmox_save_secret", { entryId, kind: "password", value: secret.password });
               else void invoke("proxmox_forget_secret", { entryId, kind: "password" });
             }}
           />
         ) : <>
        {splitMode && renderLocalPane()}
         {desktopSettings.collapseMainPaneEnabled ? (
           <div className="location-main-pane-collapse-controls" role="group" aria-label="Location pane visibility">
             <button type="button" onClick={() => setLocationPaneCollapsed(locationPaneCollapsed === "right" ? null : "left")} disabled={locationPaneCollapsed === "left"} aria-label={locationPaneCollapsed === "right" ? "Restore REMOTE pane" : "Collapse left Location pane"}><ChevronLeftIcon /></button>
             <button type="button" onClick={() => setLocationPaneCollapsed(locationPaneCollapsed === "left" ? null : "right")} disabled={!splitMode && locationPaneCollapsed !== "left" || locationPaneCollapsed === "right"} aria-label={locationPaneCollapsed === "left" ? "Restore LOCAL pane" : "Collapse right Location pane"}><ChevronRightIcon /></button>
           </div>
         ) : splitMode ? (
           <PaneResizeHandle ariaLabel="Resize LOCAL and REMOTE panes" onStart={beginPaneResize} onMove={(event) => resizePane(event.nativeEvent)} onEnd={stopPaneResize} />
         ) : null}
        <aside className="desktop-folder-tree" style={!splitMode ? { flexBasis: `${folderPaneWidth}px`, width: `${folderPaneWidth}px` } : undefined} onMouseDownCapture={() => setActivePane("remote")}>
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
         {!splitMode && !desktopSettings.collapseMainPaneEnabled && <PaneResizeHandle ariaLabel="Resize Folders and REMOTE panes" onStart={beginPaneResize} onMove={(event) => resizePane(event.nativeEvent)} onEnd={stopPaneResize} />}
        <section
          className={`desktop-content ${splitMode && activePane === "remote" ? "active-pane" : ""}`}
          onMouseDownCapture={() => setActivePane("remote")}
        >
          <div className="content-heading">
            <div>
              <span className="eyebrow">{remoteSourceLabel}</span>
              <div className="remote-navigation-row">
                {searching ? <h1>Search results for "{search}"</h1> : renderRemoteBreadcrumbs()}
                {canSearchRemote && renderSearchControl()}
              </div>
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
                if (notifyExternalFileDrag(event)) return;
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
                if (isExternalFileDrag(event)) {
                  event.preventDefault();
                  event.stopPropagation();
                  notifyExternalFileDrag(event);
                  return;
                }
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
                      <th
                        key={column}
                        className={`resizable-column sortable-column${remoteSortKey === column ? " active" : ""}`}
                        aria-sort={remoteSortKey === column
                          ? remoteSortDirection === "asc" ? "ascending" : "descending"
                          : "none"}
                      >
                        {column === "name" && (
                          <button
                            type="button"
                            className={`directory-first-toggle${remoteDirectoriesFirst ? " active" : ""}`}
                            aria-label="Keep folders first"
                            aria-pressed={remoteDirectoriesFirst}
                            title={remoteDirectoriesFirst ? "Folders first: on" : "Folders first: off"}
                            onClick={() => setRemoteDirectoriesFirst((current) => !current)}
                          >
                            <span aria-hidden="true" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleSort(
                            column,
                            remoteSortKey,
                            setRemoteSortKey,
                            setRemoteSortDirection,
                            remoteSortDirection,
                          )}
                          aria-label={`Sort by ${column}`}
                        >
                          <span>{column[0].toUpperCase() + column.slice(1)}</span>
                          {remoteSortKey === column && (
                            <span className="sort-indicator" aria-hidden="true">
                              {remoteSortDirection === "asc" ? <SortAscIcon size={11} /> : <SortDescIcon size={11} />}
                            </span>
                          )}
                        </button>
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
        </>}
      </div>
      <footer className="statusbar">
        <span>
          {appMode === "rest" ? `${restWorkspace?.restApiEntries.length || 0} REST entr${restWorkspace?.restApiEntries.length === 1 ? "y" : "ies"}` : `${files.length} item${files.length === 1 ? "" : "s"}`}
        </span>
        <span>{appMode === "rest" ? "REST API reader" : searching ? "Search results" : path ? `/${path}` : "/"}</span>
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
          ref={contextMenuRef}
          className="context-menu"
          role="menu"
          aria-label="File actions"
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
        {sharePasswordOpen && (
          <div className="modal-cover modal-layer-top" onMouseDown={() => setSharePasswordOpen(false)}>
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
          <FloatingWindow ariaLabel="Desktop Settings" className={`settings-modal settings-panel-${settingsPanel || "menu"}`} style={modalStyle("settings")} onClose={() => setSettingsOpen(false)} onDragStart={beginModalDrag("settings")} header={<div className="settings-floating-heading"><h2 className="modal-drag-handle">Desktop Settings</h2><button type="button" className="settings-floating-close" onClick={() => setSettingsOpen(false)} aria-label="Close Desktop Settings"><CloseIcon /></button></div>} footer={<div className="settings-floating-footer"><button type="button" className="confirm" onClick={() => { localStorage.setItem(desktopSettingsKey, JSON.stringify(desktopSettings)); notify("Desktop settings saved."); }}>Save</button><button type="button" onClick={() => settingsPanel === null ? setSettingsOpen(false) : setSettingsPanel(null)}>Close</button></div>}>
                <p className="settings-intro">Safe defaults keep confirmations and security checks enabled. These preferences can hide prompts only; they never bypass permissions, read-only rules, path boundaries, destination validation, or transfer verification.</p>
                {settingsPanel !== null && <button type="button" className="settings-subpanel-back" onClick={() => setSettingsPanel(null)}><ChevronLeftIcon size={12} /> Settings</button>}
                {settingsPanel === null && <label className="settings-global-collapse"><input type="checkbox" checked={desktopSettings.collapseMainPaneEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, collapseMainPaneEnabled: event.target.checked }))} /><span><strong>Collapse main split panes</strong><small>Use the collapse/restore pane controls instead of the main resizebar in Location, REST API, and VNC.</small></span></label>}
                {settingsPanel === null && <div className="settings-panel-menu"><button type="button" className="settings-panel-card" onClick={() => setSettingsPanel("theme")}><strong>Color theme</strong><span>{themePresets[desktopSettings.theme].label}</span><small>Choose palette and accent color.</small><b><ChevronRightIcon size={12} /></b></button><button type="button" className="settings-panel-card" onClick={() => setSettingsPanel("features")}><strong>Interface features</strong><span>{desktopSettings.proxmoxVncModeEnabled ? "Proxmox VNC enabled" : "Proxmox VNC disabled"}</span><small>Enable optional workspaces.</small><b><ChevronRightIcon size={12} /></b></button><button type="button" className="settings-panel-card" onClick={() => setSettingsPanel("confirmations")}><strong>Risk confirmations</strong><span>Safety prompts</span><small>Choose destructive-action confirmations.</small><b><ChevronRightIcon size={12} /></b></button><button type="button" className="settings-panel-card" onClick={() => setSettingsPanel("sharing")}><strong>Sharing</strong><span>{desktopSettings.shareLinkMode === "secure" ? "Secure links" : "Direct links"}</span><small>Configure link defaults.</small><b><ChevronRightIcon size={12} /></b></button><button type="button" className="settings-panel-card" onClick={() => setSettingsPanel("history")}><strong>History and operation log</strong><span>{desktopSettings.operationLogEnabled ? "Enabled" : "Disabled"}</span><small>Configure history and logs.</small><b><ChevronRightIcon size={12} /></b></button></div>}
               <section className="settings-section">
                 <h3>Color theme</h3>
                 <div className="settings-check settings-theme-row">
                   <span><strong>Application palette</strong><small>Changes the shared colors used by the main view, overlays, buttons, and status states.</small></span>
                   <select value={desktopSettings.theme} onChange={(event) => { const theme = event.target.value as ThemePreset; setDesktopSettings((current) => ({ ...current, theme, accentColor: themePresets[theme].variables.cyan })); }}>
                     {(Object.entries(themePresets) as [ThemePreset, { label: string }][]) .map(([value, theme]) => <option key={value} value={value}>{theme.label}</option>)}
                   </select>
                   <label className="theme-accent-control">Accent <input type="color" value={desktopSettings.accentColor} onChange={(event) => setDesktopSettings((current) => ({ ...current, accentColor: event.target.value }))} /></label>
                 </div>
               </section>
               <section className="settings-section">
                <h3>Interface features</h3>
                 <label className="settings-check">
                   <input type="checkbox" checked={desktopSettings.proxmoxVncModeEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, proxmoxVncModeEnabled: event.target.checked }))} />
                   <span><strong>Enable Proxmox VNC mode</strong><small>Show the Proxmox VNC workspace and its mode switcher.</small></span>
                 </label>
                 <label className="settings-check">
                   <input type="checkbox" checked={desktopSettings.collapseMainPaneEnabled} onChange={(event) => setDesktopSettings((current) => ({ ...current, collapseMainPaneEnabled: event.target.checked }))} />
                   <span><strong>Use collapse controls instead of split resizebars</strong><small>Apply the main collapse/restore pane controls globally in Location, REST API, and VNC. LOCAL's internal tree controls are unchanged.</small></span>
                 </label>
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
          </FloatingWindow>
       )}
        {shareLinksOpen && (
          <div className="modal-cover modal-layer-top" onMouseDown={() => setShareLinksOpen(false)}>
             <div className="modal share-links-modal" style={modalStyle("share-links")} onMouseDown={(event) => event.stopPropagation()}>
               <div className="modal-heading-row modal-drag-handle" onMouseDown={beginModalDrag("share-links")}><div><h2>Share Links</h2><p>Links created by this desktop client.</p></div><button type="button" onClick={() => setShareLinksOpen(false)} aria-label="Close Share Links"><CloseIcon /></button></div>
              <div className="share-links-toolbar"><span>{shareLinks.length} link{shareLinks.length === 1 ? "" : "s"}</span><button type="button" onClick={() => void loadShareLinks()} disabled={shareLinksLoading}>{shareLinksLoading ? "Refreshing..." : "Refresh"}</button></div>
               {shareLinksLoading && !shareLinks.length ? <p className="muted">Loading share links...</p> : !shareLinks.length ? <p className="muted">No share links created yet.</p> : (
                 <div className="share-link-groups">
                   {shareLinkGroups.map((group) => (
                     <section className="share-link-group" key={group.key}>
                       <div className="share-link-group-heading"><h3>{group.label}</h3><span>{group.links.length}</span></div>
                       <div className="share-links-list">
                         {group.links.map((link) => {
                           const secureUrl = shareLinkUrl(link, "secure");
                           const directUrl = shareLinkUrl(link, "direct");
                           const status = shareLinkStatus(link);
                           return <article className="share-link-card" key={link.shareToken}>
                             <div className="share-link-card-heading"><strong>{link.fileName}</strong><span className={`share-link-status ${status.toLowerCase()}`}>{status}</span></div>
                             {session.role === "admin" && <small>Created by: {link.creatorUsername || link.userId || "--"}</small>}
                             <small>Location: {link.locationId || "--"} · Created: {link.createdAt ? new Date(link.createdAt).toLocaleString() : "--"}</small>
                             <small>Downloads: {link.downloadCount || 0}{link.maxDownloads > 0 ? ` / ${link.maxDownloads}` : " / unlimited"} · Expires: {link.expiresAt ? new Date(link.expiresAt).toLocaleString() : "never"}</small>
                             <label>Secure link<input readOnly value={secureUrl} onFocus={(event) => event.currentTarget.select()} /></label>
                             <label>Direct download<input readOnly value={directUrl} onFocus={(event) => event.currentTarget.select()} /></label>
                             {status === "Active" && <div className="modal-actions"><button type="button" onClick={() => void copyManagedShareLink(link, "secure")} disabled={!secureUrl}>Copy secure</button><button type="button" onClick={() => void copyManagedShareLink(link, "direct")} disabled={!directUrl}>Copy direct</button><button type="button" className="danger" onClick={() => revokeManagedShareLink(link.shareToken)}>Revoke</button></div>}
                             {status === "Revoked" && <div className="modal-actions"><button type="button" onClick={() => deleteRevokedShareLink(link.shareToken)}>Clear revoked</button></div>}
                             {status === "Expired" && <div className="modal-actions"><button type="button" onClick={() => deleteExpiredShareLink(link.shareToken)}>Clear expired</button></div>}
                           </article>;
                         })}
                       </div>
                     </section>
                   ))}
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
                      <h3>REST API Entries</h3>
                      {!managedSession.restApiEntries.length && <span className="muted">No REST API entries yet.</span>}
                      <ol className="workspace-entry-list">
                        {managedSession.restApiEntries.map((entry) => (
                          <li key={entry.id}>
                            <button type="button" className="workspace-entry-button" onClick={() => { setWorkspaceSessionId(managedSession.id); setActiveRestEntryId(entry.id); setAppMode("rest"); setSessionsOpen(false); }}>
                              <strong>{entry.name}</strong>
                              <span>{entry.baseUrl}{entry.defaultPath}</span>
                            </button>
                            <button type="button" className="workspace-entry-edit" onClick={(event) => { event.stopPropagation(); openEditRestEntryDialog(managedSession.id, entry); }}>Edit</button>
                          </li>
                        ))}
                      </ol>
                    </section>
                    {desktopSettings.proxmoxVncModeEnabled && <section className="workspace-entry-section">
                      <h3>Proxmox VNC Entries</h3>
                      {!managedSession.proxmoxVncEntries.length && <span className="muted">No Proxmox VNC entries yet.</span>}
                      <ol className="workspace-entry-list">
                        {managedSession.proxmoxVncEntries.map((entry) => (
                          <li key={entry.id}>
                            <button type="button" className="workspace-entry-button" onClick={() => { setWorkspaceSessionId(managedSession.id); setActiveVncEntryId(entry.id); setAppMode("vnc"); setSessionsOpen(false); }}>
                              <strong>{entry.name}</strong>
                              <span>{entry.baseUrl} · {entry.node || "No node"}/{entry.vmid || "No VMID"}</span>
                            </button>
                            <button type="button" className="workspace-entry-edit" onClick={(event) => { event.stopPropagation(); openEditVncEntryDialog(managedSession.id, entry); }}>Edit</button>
                          </li>
                        ))}
                      </ol>
                    </section>}
                    <div className="workspace-entry-actions">
                      <button type="button" className="confirm" onClick={() => { setWorkspaceSessionId(managedSession.id); openAddSshEntryDialog(); }}>Add SSH Entry</button>
                      <button type="button" className="confirm" onClick={() => openAddRestEntryDialog(managedSession.id)}>Add REST API Entry</button>
                      {desktopSettings.proxmoxVncModeEnabled && <button type="button" className="confirm" onClick={() => openAddVncEntryDialog(managedSession.id)}>Add Proxmox VNC Entry</button>}
                      <button type="button" onClick={() => { setWorkspaceSessionId(managedSession.id); setAppMode("rest"); setSessionsOpen(false); }}>Open REST API</button>
                      {desktopSettings.proxmoxVncModeEnabled && <button type="button" onClick={() => { setWorkspaceSessionId(managedSession.id); setAppMode("vnc"); setSessionsOpen(false); }}>Open VNC</button>}
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
      {restEntryDialogOpen && restEntryDraft && (
        <div className="modal-cover modal-layer-top" onMouseDown={() => setRestEntryDialogOpen(false)}>
          <div className="modal rest-entry-modal" style={modalStyle("rest-entry")} onMouseDown={(event) => event.stopPropagation()}>
            <h2 className="modal-drag-handle" onMouseDown={beginModalDrag("rest-entry")}>{isEditingRestEntry(activeManagedWorkspace, restEntryDraft) ? "Edit REST API Entry" : "Add REST API Entry"}</h2>
            <p>Workspace: {activeManagedWorkspace?.name || "—"}</p>
            {sessionFormError && <output className="form-error" role="alert">{sessionFormError}</output>}
            <label>Name<input value={restEntryDraft.name} onChange={(event) => setRestEntryDraft({ ...restEntryDraft, name: event.target.value })} placeholder="Production BMC" /></label>
            <label>Base URL<input value={restEntryDraft.baseUrl} onChange={(event) => setRestEntryDraft({ ...restEntryDraft, baseUrl: event.target.value })} placeholder="https://api.example.com" /></label>
            <label>Default path<input value={restEntryDraft.defaultPath} onChange={(event) => setRestEntryDraft({ ...restEntryDraft, defaultPath: event.target.value })} placeholder="/v1/rest" /></label>
            <label className="tls-option"><input type="checkbox" checked={restEntryDraft.ignoreTlsErrors} onChange={(event) => setRestEntryDraft({ ...restEntryDraft, ignoreTlsErrors: event.target.checked })} /> Ignore TLS errors</label>
            <small className="field-help">Authentication mode, login path, and token settings are configured from the Authentication panel inside REST API mode once this entry is selected -- they're operational settings you tune while working with the entry, not part of its identity.</small>
            <div className="modal-actions">
              <button type="button" onClick={() => setRestEntryDialogOpen(false)}>Cancel</button>
              {isEditingRestEntry(activeManagedWorkspace, restEntryDraft) && <button type="button" className="session-delete" onClick={removeRestEntry}>Remove</button>}
              <button type="button" className="confirm" onClick={saveRestEntry}>Save</button>
            </div>
          </div>
        </div>
      )}
      {vncEntryDialogOpen && vncEntryDraft && (() => {
        const endpoint = vncEndpointParts(vncEntryDraft.baseUrl);
        const proxmoxUsername = vncUsernameParts(vncEntryDraft.username);
        const updateEndpoint = (host: string, port: string) => setVncEntryDraft({ ...vncEntryDraft, baseUrl: `https://${host}:${port}` });
        const updateUsername = (account: string, realm: string) => setVncEntryDraft({ ...vncEntryDraft, username: `${account}@${realm}` });
        return (
          <div className="modal-cover modal-layer-top" onMouseDown={() => setVncEntryDialogOpen(false)}>
            <div className="modal vnc-entry-modal" style={modalStyle("vnc-entry")} onMouseDown={(event) => event.stopPropagation()}>
              <h2 className="modal-drag-handle" onMouseDown={beginModalDrag("vnc-entry")}>{isEditingVncEntry(activeManagedWorkspace, vncEntryDraft) ? "Edit Proxmox VNC Entry" : "Add Proxmox VNC Entry"}</h2>
              <p>Workspace: {activeManagedWorkspace?.name || "—"}</p>
              {sessionFormError && <output className="form-error" role="alert">{sessionFormError}</output>}
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
              <div className="modal-actions">
                <button type="button" onClick={() => setVncEntryDialogOpen(false)}>Cancel</button>
                {isEditingVncEntry(activeManagedWorkspace, vncEntryDraft) && <button type="button" className="session-delete" onClick={removeVncEntry}>Remove</button>}
                <button type="button" className="confirm" onClick={saveVncEntry}>Save</button>
              </div>
            </div>
          </div>
        );
      })()}
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
                  <button type="button" className="ssh-tab-close" aria-label={`Close ${tab.title}`} onClick={() => closeSshTab(tab.id)}><CloseIcon size={11} /></button>
                </span>
              ))}
              <button type="button" aria-label="New SSH terminal tab" onClick={() => createSshTab()}>+</button>
            </div>
            <div className="terminal-actions">
               <button onClick={() => openSessionsModal()}>Workspace Manager</button>
               <button onClick={() => setQueueOpen(true)}>Transfer Queue ({transferQueue.filter((item) => ["queued", "running", "retrying", "needs_user_action"].includes(item.status)).length})</button>
              <button aria-label={terminalMaximized ? "Restore terminal size" : "Maximize terminal"} aria-pressed={terminalMaximized} onClick={toggleTerminalMaximized}>{terminalMaximized ? <CollapseIcon /> : <ExpandIcon />}</button>
              <button aria-label="Collapse terminal" onClick={() => setTerminalOpen(false)}><ChevronDownIcon /></button>
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
                <Dropdown
                  className="palette-select-control"
                  label="Select a Workspace"
                  value={workspaceSessionId}
                  options={workspaceSessions.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
                  onChange={selectWorkspaceSession}
                />
                {activeWorkspaceSession && (
                  <Dropdown
                    className="palette-select-control"
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
                       {savedLogPaths.length > 0 && <details className="saved-log-paths"><summary>Saved log files</summary>{savedLogPaths.map((savedPath) => <button type="button" key={savedPath} onClick={() => openLocalViewer(savedPath)}><code>{savedPath}</code></button>)}</details>}
                     {recording && <span className="recording-indicator">Recording</span>}
              </div>
            </div>
          </div>
        </section>
      )}
      {!terminalOpen && (
        <button className="terminal-restore" onClick={() => setTerminalOpen(true)} aria-label="Restore terminal">
          Terminal <ChevronUpIcon size={12} />
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
      {queueOpen && <QueueModal items={transferQueue} activeItems={activeTransferQueue} historyItems={transferHistory} renderItem={(item) => renderDesktopQueueItem(item as TransferQueueItem)} modalStyle={modalStyle("queue")} onDragStart={beginModalDrag("queue")} onClose={() => setQueueOpen(false)} onClearStatus={clearQueueStatus} onClearHistory={clearFinishedQueue} />}
      {viewerOpen && <ViewerModal title={viewerTitle} content={viewerContent} modalStyle={modalStyle("viewer")} onDragStart={beginModalDrag("viewer")} onClose={() => setViewerOpen(false)} onEdit={editViewerFile} onCopy={() => void navigator.clipboard.writeText(viewerContent).then(() => notify("File content copied."))} />}
      {logViewOpen && <LogView records={operationLogRecords} modalStyle={modalStyle("log-view")} onDragStart={beginModalDrag("log-view")} onClose={() => setLogViewOpen(false)} onExport={exportOperationLog} />}
      {helpOpen && <HelpModal sections={helpSections} pages={helpPages} selectedPage={selectedHelpPage} selectedSection={selectedHelpSection} selectedIndex={selectedHelpIndex} expandedSections={expandedHelpSections} modalStyle={modalStyle("help")} onDragStart={beginModalDrag("help")} onClose={() => setHelpOpen(false)} onToggleSection={(id) => setExpandedHelpSections((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])} onSelectPage={setSelectedHelpPageId} />}
      </Suspense>
    </AppShell>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
