import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { resolveResource } from "@tauri-apps/api/path";
import {
  initialQueueProgress,
} from "./queue/progress";
import { selectActiveQueueItems, selectQueueHistory } from "./queue/selectors";
import { clampRefreshDelayMs, decodeJwtExpiryMs, tokenRefreshLeadMs } from "./features/auth/auth-contracts";
import type { RemoteLocation } from "./features/remote-browser/remote-browser-contracts";
import { useRemoteApiActions } from "./features/remote-browser/useRemoteApiActions";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon, CloseIcon, CollapseIcon, ExpandIcon, SortAscIcon, SortDescIcon, WarningIcon } from "./ui/icons";
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
// Single ordered global-style entry point (T-018): tokens/base CSS first,
// feature-component CSS in the middle, the styles/theme/ override modules
// always last. See styles/index.css and styles/theme/README.md for the
// full contract and why the previous 18 separate imports here were
// consolidated, and how the override layer is split into modules (T-202).
import "./styles/index.css";
import { helpPages, helpSections } from "./help/help-content";
import type { OperationLogRecord } from "./log-view";
import type { RestApiSecret } from "./rest-api";
import type { ProxmoxVncSecret } from "./proxmox-vnc";
import { PaneResizeHandle } from "./resizable-pane";
import { ContextPicker, type ContextPickerGroup } from "./context-picker";
import { AppShell } from "./app/AppShell";
import { DesktopTitlebar } from "./app/DesktopTitlebar";
import { isMobileViewport } from "./styles/breakpoints";
import { TerminalWorkspace } from "./features/terminal/TerminalWorkspace";
import type { SshProfile } from "./features/ssh/ssh-contracts";
import type { SshTerminalTab } from "./features/terminal/terminal-contracts";
import { appendSshTabOutput, makeSshTabId } from "./features/terminal/terminal-utils";
import { useSshTerminal } from "./features/terminal/useSshTerminal";
import { useSshTerminalState } from "./features/terminal/useSshTerminalState";
import { useSshTerminalActions } from "./features/terminal/useSshTerminalActions";
import { formatSize } from "./format-utils";
import { useDesktopSettings } from "./features/settings/useDesktopSettings";
import { defaultDesktopSettings, desktopSettingsKey, normalizeDesktopSettings, type DesktopSettings, type OperationStorageInfo } from "./features/settings/settings-contracts";
import { useSessionsState } from "./features/sessions/useSessionsState";
import { useSessionsActions } from "./features/sessions/useSessionsActions";
import { type ManagedSession } from "./features/sessions/sessions-contracts";
import { useShareLinksState } from "./features/share-links/useShareLinksState";
import { useShareLinksActions } from "./features/share-links/useShareLinksActions";
import type { FileItem } from "./file-item-contracts";
import { downloadPath } from "./path-utils";
import { useTransferQueueState } from "./features/queue/useTransferQueueState";
import { useTransferQueueActions } from "./features/queue/useTransferQueueActions";
import type { TransferQueueItem } from "./features/queue/queue-contracts";

const RestApiWorkspace = lazy(() => import("./rest-api").then(({ RestApiWorkspace: component }) => ({ default: component })));
const VncWorkspaceController = lazy(() => import("./features/vnc/VncWorkspaceController").then(({ VncWorkspaceController: component }) => ({ default: component })));
const QueueModal = lazy(() => import("./features/queue/QueueModal").then(({ QueueModal: component }) => ({ default: component })));
const ViewerModal = lazy(() => import("./features/viewer/ViewerModal").then(({ ViewerModal: component }) => ({ default: component })));
const HelpModal = lazy(() => import("./features/help/HelpModal").then(({ HelpModal: component }) => ({ default: component })));
const LogView = lazy(() => import("./log-view").then(({ LogView: component }) => ({ default: component })));
const SettingsModal = lazy(() => import("./features/settings/SettingsModal").then(({ SettingsModal: component }) => ({ default: component })));
const SessionsModal = lazy(() => import("./features/sessions/SessionsModal").then(({ SessionsModal: component }) => ({ default: component })));
const WorkspaceNameDialog = lazy(() => import("./features/sessions/WorkspaceNameDialog").then(({ WorkspaceNameDialog: component }) => ({ default: component })));
const SshEntryDialog = lazy(() => import("./features/sessions/SshEntryDialog").then(({ SshEntryDialog: component }) => ({ default: component })));
const RestEntryDialog = lazy(() => import("./features/sessions/RestEntryDialog").then(({ RestEntryDialog: component }) => ({ default: component })));
const VncEntryDialog = lazy(() => import("./features/sessions/VncEntryDialog").then(({ VncEntryDialog: component }) => ({ default: component })));
const SharePasswordDialog = lazy(() => import("./features/share-links/SharePasswordDialog").then(({ SharePasswordDialog: component }) => ({ default: component })));
const ShareLinksModal = lazy(() => import("./features/share-links/ShareLinksModal").then(({ ShareLinksModal: component }) => ({ default: component })));
const ArchiveFormatDialog = lazy(() => import("./features/queue/ArchiveFormatDialog").then(({ ArchiveFormatDialog: component }) => ({ default: component })));

// `Location` here is the REMOTE (API Location) entry type main.tsx has
// used since before the Phase 5 refactor (GitHub issue #229) started;
// it's now an alias of the shared RemoteLocation type so the small piece
// of Phase 5 pulled out early for issue #233 (useRemoteApiActions) and
// the rest of main.tsx, which still owns the REMOTE file browser, agree
// on exactly one definition instead of two structurally-identical ones.
type Location = RemoteLocation;
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
type ColumnKey = "name" | "modified" | "size";
type SortKey = ColumnKey;
type SortDirection = "asc" | "desc";

type UndoEntry = {
  id: string;
  description: string;
  source: "api" | "ssh" | "local";
  locationId?: string;
  entryId?: string;
  oldPath: string;
  newPath: string;
};

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
// `output` (xterm's replay buffer) -- never into the on-disk recording
// transcripts, which must stay a faithful transcript of only the bytes
// actually received.


// Upper bound (in characters) on how much of an SSH tab's `output` this
// frontend keeps in memory. `output` is the buffer replayed into a fresh
// xterm.js `Terminal` instance on every tab switch/terminal recreation
// (see `useTerminalLifecycle`'s `replayOutput` below) and used to seed a
// new recording's transcript (see `startRecording`'s `rawSeed`/
// `plainSeed`). Every incoming SSH output chunk previously did an
// unconditional `item.output + data` with no cap at all, so a long-running
// session (a `tail -f`, a noisy build, an interactive session left open
// for hours) grew this string without bound -- and every *subsequent*
// chunk's `+` copy cost scaled with the *entire* accumulated history, not
// just the new chunk, so per-chunk cost (and the GC pressure from
// discarding the old, ever-larger string on each append) grew over the
// life of the session. That is the direct cause of a Terminal that starts
// responsive and gets progressively slower over time until it looks like
// it has nearly hung. 512KB comfortably covers many thousands of lines of
// scrollback -- far more than xterm's own default 1000-line scrollback
// buffer will show on a tab switch anyway -- while keeping the append cost
// bounded.


// Appends `chunk` to `output` and truncates the *front* of the result once
// it exceeds `SSH_TAB_OUTPUT_CAP`, dropping whole lines only (never partial
// ones) so a truncation point can never land in the middle of a multi-byte
// UTF-8 character or, more importantly, in the middle of an ANSI/VT escape
// sequence -- doing so would leave xterm.js's VT parser replaying a
// dangling, unterminated control sequence the exact same way
// `VT_SESSION_BOUNDARY_GUARD` above guards against for reconnects. Cutting
// only at `\n` boundaries keeps every remaining escape sequence intact,
// since a bare `\n` can never appear inside one (VT sequences are
// terminated by their own specific bytes, and any literal `\n` a shell
// program means to display is itself a sequence boundary). This is used
// for every `output` append below, replacing the previous unconditional
// `item.output + data`.


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
  const menuRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({ visibility: "hidden" });

  const closeMenu = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !(event.target as HTMLElement).closest(".commandbar-overflow-options")) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  // T-133: match ui/Dropdown.tsx's keyboard matrix -- Escape/Arrow keys/
  // Home/End are handled by the portaled menu's own onKeyDown below, and
  // opening focuses the first action so this menu does not depend on a
  // mouse click to be usable.
  useEffect(() => {
    if (!open) return;
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") || []);
    buttons[0]?.focus();
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
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <span>{label}</span>
        <span aria-hidden="true">{open ? <ChevronLeftIcon /> : <ChevronRightIcon />}</span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="mobile-choice-options commandbar-overflow-options"
          style={popoverStyle}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") || []);
            const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "Escape") {
              event.preventDefault();
              closeMenu();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const nextIndex = event.key === "ArrowDown"
                ? Math.min(currentIndex + 1, buttons.length - 1)
                : Math.max(currentIndex - 1, 0);
              buttons[nextIndex]?.focus();
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              buttons[event.key === "Home" ? 0 : buttons.length - 1]?.focus();
            }
          }}
        >
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              title={action.title}
              onClick={() => {
                action.onClick();
                closeMenu();
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
};
const apiCredentialEntryId = "api-login";

// T-210: reads the raw persisted file-table column widths with the same
// per-field fallback defaults as before, but WITHOUT normalizing them --
// normalizeColumnWidths (below) is applied separately by every caller so a
// corrupt or drifted persisted value (see its own comment) can never reach
// the <col> widths unnormalized.
const readPersistedColumnWidths = (): Record<ColumnKey, number> => {
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
};
// T-210: the file table renders each column's width as a literal percent
// (main.tsx's <col style={{ width: `${columnWidths.x}%` }} />), with no
// runtime guarantee the three persisted percentages actually sum to 100 --
// e.g. a manually edited localStorage value, or a future bug in the
// column-resize drag handler, could persist widths that sum to well over
// or under 100%, which would either overflow the table horizontally or
// leave a visibly too-narrow/wide column. This proportionally rescales
// whatever was read so the three columns always sum to exactly 100 before
// they're ever used to size a <col>, regardless of what was persisted.
const normalizeColumnWidths = (widths: Record<ColumnKey, number>): Record<ColumnKey, number> => {
  const sanitized = {
    name: Number.isFinite(widths.name) && widths.name > 0 ? widths.name : 50,
    modified: Number.isFinite(widths.modified) && widths.modified > 0 ? widths.modified : 30,
    size: Number.isFinite(widths.size) && widths.size > 0 ? widths.size : 20,
  };
  const total = sanitized.name + sanitized.modified + sanitized.size;
  if (!Number.isFinite(total) || total <= 0) return { name: 50, modified: 30, size: 20 };
  const scale = 100 / total;
  return {
    name: sanitized.name * scale,
    modified: sanitized.modified * scale,
    size: sanitized.size * scale,
  };
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
  // Silently re-authenticates with the API Server using the saved
  // credentials, applies the resulting new token to `session`, and
  // returns that new token string. Resolves null when there is nothing
  // safe to re-authenticate with ("Save user info" is off) or the
  // re-login attempt itself failed -- callers must fall back to signing
  // the user out in that case (#233).
  refreshSessionToken: () => Promise<string | null>;
};

type LoginScreenProps = {
  session: Session;
  setSession: React.Dispatch<React.SetStateAction<Session>>;
  password: string;
  setPassword: React.Dispatch<React.SetStateAction<string>>;
  busy: boolean;
  notice: string;
  uiProfile: "auto" | "mobile";
  glassMenusEnabled: boolean;
  glassDialogsEnabled: boolean;
  onUiProfileChange: (profile: "auto" | "mobile") => void;
  onSubmit: (event: React.FormEvent) => void;
};

function LoginScreen({ session, setSession, password, setPassword, busy, notice, uiProfile, glassMenusEnabled, glassDialogsEnabled, onUiProfileChange, onSubmit }: LoginScreenProps) {
  // Auto profile sizing must flip to Mobile at the exact same threshold as
  // DesktopApp's own mobileLayout check, via the one shared resolver --
  // not a hand-copied CSS media query mirroring the same numbers (T-027).
  const [loginViewport, setLoginViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const updateViewport = () => setLoginViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);
  // The login screen always uses Auto's viewport-driven layout, even when
  // uiProfile is "mobile" (Large) -- Large's uniform text/control scale-up
  // was the direct cause of the login form overflowing the app's default
  // window (bottom border clipped) and the profile Dropdown being squeezed.
  // Login only has 4 fields + 2 toggles + 1 button, so it is already fully
  // usable at 800x600 without Large's enlargement; DesktopApp (post-login)
  // is unaffected and still honors the selected uiProfile normally.
  const loginMobileLayout = isMobileViewport(loginViewport);
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
    <main className={`login ui-profile-${uiProfile} ui-layout-${loginMobileLayout ? "mobile" : "desktop"} ${glassMenusEnabled ? "" : "glass-menus-off"} ${glassDialogsEnabled ? "" : "glass-dialogs-off"}`}>
      <form onSubmit={onSubmit}>
        <h1>nFterm {appVersion && <small className="login-version">{appVersion}</small>}</h1>
        <label className="login-field-server">Server address<input placeholder="files.example.internal" value={session.host} onChange={(event) => setSession((current) => ({ ...current, host: event.target.value }))} /></label>
        <label className="login-field-port">HTTPS port<input inputMode="numeric" value={session.port} onChange={(event) => setSession((current) => ({ ...current, port: event.target.value }))} /></label>
        <label className="login-field-username">Username<input value={session.username} onChange={(event) => setSession((current) => ({ ...current, username: event.target.value }))} /></label>
        <label className="login-field-password">Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <div className="login-toggle-row" role="group" aria-label="Login options">
          <button type="submit" className="login-submit-button" disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
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
        {notice && <output role="alert">{notice}</output>}
      </form>
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

  // The one place that actually calls POST /auth/login and applies the
  // result to `session`. Shared by the manual sign-in submit handler below
  // and by `refreshSessionToken`'s silent, background re-login (issue
  // #233) -- both must end up with byte-for-byte the same session update,
  // so this logic must not be duplicated in two places that could drift.
  const performLogin = async (usernameToUse: string, passwordToUse: string) => {
    validateServer(session);
    const responseValue = await invoke<NativeApiResponse>("api_request", {
      url: `${serverUrl(session)}/auth/login`,
      method: "POST",
      headers: [["Content-Type", "application/json"]],
      body: Array.from(new TextEncoder().encode(JSON.stringify({ username: usernameToUse, password: passwordToUse }))),
      ignoreTlsErrors: session.ignoreTlsErrors,
    });
    const response = new ApiResponse(responseValue.status, responseValue.body);
    if (!response.ok) throw new Error(await readError(response));
    const data = await response.json();
    const authenticatedUsername = data.user.username || usernameToUse;
     // Native Tauri requests keep the HttpOnly cookie in the Rust reqwest
     // client. Use an in-memory marker for the existing authenticated-state
     // checks; never treat it as a bearer token or persist it as a secret.
     const sessionMarker = typeof data.token === "string" && data.token ? data.token : "cookie";
    setSession((current) => ({ ...current, token: sessionMarker, username: authenticatedUsername, userId: data.user.id ?? null, role: data.user.role ?? "user", permissions: data.user.permissions ?? [] }));
    // `setSession` above only schedules a state update -- this function's
    // own callers (a 401 retry in `api()`, or the token-lifetime timer)
    // need the new token's actual string value *right now*, in this same
    // tick, to use for an immediate retry or to compute the next refresh
    // delay, not on the next render. Returning it directly avoids relying
    // on a stale `session.token` closure value.
    return { username: authenticatedUsername, token: sessionMarker };
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      const { username: authenticatedUsername } = await performLogin(session.username, password);
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

  // Silent re-login, used to keep the app connected to the API Server for
  // as long as it stays open, instead of the token quietly expiring after
  // the backend's fixed 24h JWT lifetime and leaving the user stuck in a
  // half-signed-in state (issue #233). Only possible when the user opted
  // into "Save user info", because that is the only place this app keeps a
  // password around after the login form's own `password` state may have
  // been cleared or gone stale across a long-running session; without a
  // saved password there is nothing to safely re-authenticate with, and
  // callers must fall back to sending the user back to the login screen.
  const refreshSessionToken = async (): Promise<string | null> => {
    if (!session.saveUserInformation) return null;
    try {
      const [storedUsername, storedPassword] = await Promise.all([
        invoke<string | null>("rest_load_secret", { entryId: apiCredentialEntryId, kind: "username" }),
        invoke<string | null>("rest_load_secret", { entryId: apiCredentialEntryId, kind: "password" }),
      ]);
      const usernameToUse = storedUsername || session.username;
      const passwordToUse = storedPassword || password;
      if (!usernameToUse || !passwordToUse) return null;
      const { token } = await performLogin(usernameToUse, passwordToUse);
      return token;
    } catch {
      return null;
    }
  };

  let savedAppearance = defaultDesktopSettings;
  try {
    savedAppearance = normalizeDesktopSettings(JSON.parse(localStorage.getItem(desktopSettingsKey) || "null"));
  } catch {
    // Keep the same safe defaults used by the settings hook when storage is invalid.
  }
  if (!session.token) return <LoginScreen session={session} setSession={setSession} password={password} setPassword={setPassword} busy={busy} notice={notice} uiProfile={uiProfile} glassMenusEnabled={savedAppearance.glassMenusEnabled} glassDialogsEnabled={savedAppearance.glassDialogsEnabled} onUiProfileChange={changeUiProfile} onSubmit={login} />;
  return <DesktopApp session={session} setSession={setSession} password={password} setPassword={setPassword} busy={busy} setBusy={setBusy} notice={notice} setNotice={setNotice} refreshSessionToken={refreshSessionToken} />;
}

function DesktopApp({ session, setSession, password, setPassword, busy, setBusy, notice, setNotice, refreshSessionToken }: DesktopAppProps) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [localFiles, setLocalFiles] = useState<FileItem[]>([]);
  const [localPath, setLocalPath] = useState("");
  const [localSelected, setLocalSelected] = useState<string[]>([]);
  const localTreeCacheRef = useRef(new Map<string, FolderNode[]>());
  const localRequestGenerationRef = useRef(0);
  const localFilesFingerprintRef = useRef("");
  // The LOCAL folder-tree "forest": the first entry is always the HOME
  // shortcut (path ""). Windows may append drive roots that the current
  // user can enumerate; the Rust side remains the real ACL and path boundary.
  const [localTrees, setLocalTrees] = useState<FolderNode[]>([
    { path: "", name: "HOMEDIR/", expanded: true, loaded: false, children: [] },
  ]);
  const [isLocalElevated, setIsLocalElevated] = useState(false);
  const [localHomeAbsolute, setLocalHomeAbsolute] = useState("");
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationsLoading, setLocationsLoading] = useState(false);
  const [appMode, setAppMode] = useState<"location" | "rest" | "vnc">(() => {
    const saved = localStorage.getItem("fileapi-app-mode");
    let vncEnabled = false;
    let restEnabled = false;
    try {
      const parsed = JSON.parse(localStorage.getItem(desktopSettingsKey) || "null");
      vncEnabled = parsed?.proxmoxVncModeEnabled === true;
      restEnabled = parsed?.restApiModeEnabled === true;
    } catch {
      vncEnabled = false;
      restEnabled = false;
    }
    return (saved === "rest" && restEnabled) || (saved === "vnc" && vncEnabled) ? saved : "location";
  });
  const [path, setPath] = useState("");
  const [remoteSshEntryId, setRemoteSshEntryId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const {
    shareUrl, setShareUrl,
    shareLinksOpen, setShareLinksOpen,
    shareLinks, setShareLinks,
    shareLinksLoading, setShareLinksLoading,
    sharePasswordOpen, setSharePasswordOpen,
    sharePasswordDraft, setSharePasswordDraft,
  } = useShareLinksState();
  const selectionAnchorRef = useRef<string | null>(null);
  const localSelectionAnchorRef = useRef<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountMenuStyle, setAccountMenuStyle] = useState<React.CSSProperties>({});
  const [helpOpen, setHelpOpen] = useState(false);
  const [logViewOpen, setLogViewOpen] = useState(false);
  const [operationLogRecords, setOperationLogRecords] = useState<OperationLogRecord[]>([]);
  const [selectedHelpPageId, setSelectedHelpPageId] = useState("login");
  const [expandedHelpSections, setExpandedHelpSections] = useState<string[]>(["getting-started"]);
  const [locationMenuOpen, setLocationMenuOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [saveLogNameOpen, setSaveLogNameOpen] = useState(false);
  const [saveLogNameDraft, setSaveLogNameDraft] = useState("");
  const [saveLogDestinationPath, setSaveLogDestinationPath] = useState("");
  const {
    settingsOpen, setSettingsOpen,
    settingsPanel, setSettingsPanel,
    themeSnapshotRef,
    desktopSettings, setDesktopSettings,
    themeVariables,
    storageInfo, setStorageInfo,
  } = useDesktopSettings({ setNotice });
  useEffect(() => {
    if (!desktopSettings.proxmoxVncModeEnabled && appMode === "vnc") setAppMode("location");
    if (!desktopSettings.restApiModeEnabled && appMode === "rest") setAppMode("location");
  }, [desktopSettings.proxmoxVncModeEnabled, desktopSettings.restApiModeEnabled, appMode]);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
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
  const {
    managedSessions, setManagedSessions,
    activeRestEntryId, setActiveRestEntryId,
    restSecrets, setRestSecrets,
    restSessionHeaders, setRestSessionHeaders,
    activeVncEntryId, setActiveVncEntryId,
    vncSecrets, setVncSecrets,
    sessionsOpen, setSessionsOpen,
    workspaceNameDialogOpen, setWorkspaceNameDialogOpen,
    sessionFormError, setSessionFormError,
    lastSavedSessionId, setLastSavedSessionId,
    sshProfiles, setSshProfiles,
    sshProfileId, setSshProfileId,
    workspaceSessionId, setWorkspaceSessionId,
    selectedSshEntryId, setSelectedSshEntryId,
    sshProfileDraft, setSshProfileDraft,
    sshPasswordSaved, setSshPasswordSaved,
    sshEntryDraftId, setSshEntryDraftId,
    vmSshPasswordDraft, setVmSshPasswordDraft,
    vmSshPasswordSaved, setVmSshPasswordSaved,
    hostSshPasswordDraft, setHostSshPasswordDraft,
    hostSshPasswordSaved, setHostSshPasswordSaved,
    sessionNameDraft, setSessionNameDraft,
    sshEntryDialogOpen, setSshEntryDialogOpen,
    restEntryDialogOpen, setRestEntryDialogOpen,
    restEntryDraft, setRestEntryDraft,
    vncEntryDialogOpen, setVncEntryDialogOpen,
    vncEntryDraft, setVncEntryDraft,
    vncEntryModalTab, setVncEntryModalTab,
  } = useSessionsState();
  const terminalState = useSshTerminalState();
  const {
    terminalOpen, setTerminalOpen, sshTabs, setSshTabs, activeSshTabId, setActiveSshTabId,
    sshQuickListOpen, setSshQuickListOpen, terminalMaximized, setTerminalMaximized,
    previousTerminalHeightRef, terminalHeight, setTerminalHeight, terminalResizeRef,
    stopTerminalResize, resizeTerminal, beginTerminalResize, toggleTerminalMaximized,
    sshConnected, setSshConnected, sshOutputRef, recording, setRecording, savedLogPaths, setSavedLogPaths,
    terminalHostRef, terminalInstanceRef, sshSessionIdRef, sshConnectingRef, sshWriteQueuesRef,
    recordingWriteQueuesRef, recordingRef, sshSecretPromptRef, activeSshTabIdRef,
    pendingSshConnectRequestsRef, connectAttemptRef, sshTabsRef, shellInputRef,
  } = terminalState;
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
  const [columnWidths, setColumnWidths] = useState<Record<ColumnKey, number>>(() =>
    normalizeColumnWidths(readPersistedColumnWidths()),
  );
  const [remoteSortKey, setRemoteSortKey] = useState<SortKey>("name");
  const [remoteSortDirection, setRemoteSortDirection] = useState<SortDirection>("asc");
  const [remoteDirectoriesFirst, setRemoteDirectoriesFirst] = useState(false);
  const [localSortKey, setLocalSortKey] = useState<SortKey>("name");
  const [localSortDirection, setLocalSortDirection] = useState<SortDirection>("asc");
  const {
    transferQueue, setTransferQueue,
    queueStoreRef,
    queueOpen, setQueueOpen,
    archiveFormatOpen, setArchiveFormatOpen,
    archiveFormatDraft, setArchiveFormatDraft,
    queueProgressSamplesRef,
    latestQueueProgressRef,
    queueCompletionHandlersRef,
    cancelledQueueItemsRef,
    queueSchedulerRef,
  } = useTransferQueueState();
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerTitle, setViewerTitle] = useState("");
  const [viewerContent, setViewerContent] = useState("");
  const [viewerLocalPath, setViewerLocalPath] = useState("");
  const [viewerRemotePath, setViewerRemotePath] = useState("");
  const dragPreparationRef = useRef(new Map<string, Promise<string>>());
  const dragExpandTimerRef = useRef<number | undefined>(undefined);
  const dragScrollIntervalRef = useRef<number | null>(null);
  const dragIconPathRef = useRef<Promise<string> | null>(null);

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
  // Dedupes concurrent 401 responses: if several in-flight requests all
  // hit an expired token at once, only the first should trigger a real
  // POST /auth/login -- every other caller awaits that same in-flight
  // promise and reuses its result instead of firing its own extra login
  // request (#233).
  const tokenRefreshPromiseRef = useRef<Promise<string | null> | null>(null);
  const refreshTokenOnce = () => {
    if (!tokenRefreshPromiseRef.current) {
      tokenRefreshPromiseRef.current = refreshSessionToken().finally(() => {
        tokenRefreshPromiseRef.current = null;
      });
    }
    return tokenRefreshPromiseRef.current;
  };
  const locationsLoaded = useRef(false);
  const locationRefreshInProgress = useRef(false);
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
        // T-216: if the theme/accent currently applied differs from what
        // was active when Settings opened (a pending, unconfirmed
        // preview), the first Escape reverts that preview instead of
        // immediately closing the whole Settings window -- matching the
        // Revert button's own behavior and the "or Escape" requirement.
        // A second Escape (nothing left to revert) closes Settings as
        // before.
        const snapshot = themeSnapshotRef.current;
        if (snapshot && (snapshot.theme !== desktopSettings.theme || snapshot.accentColor !== desktopSettings.accentColor)) {
          setDesktopSettings((current) => ({ ...current, theme: snapshot.theme, accentColor: snapshot.accentColor }));
        } else {
          setSettingsOpen(false);
        }
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
    desktopSettings.accentColor,
    desktopSettings.theme,
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
    activeSshTabIdRef.current = activeSshTabId;
    const tab = sshTabs.find((item) => item.id === activeSshTabId);
    setSshConnected(Boolean(tab?.connected));
    setRecording(Boolean(tab?.recording));
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
    localStorage.setItem("fileapi-app-mode", appMode);
  }, [appMode]);

  useEffect(() => {
    const updateViewport = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useEffect(() => {
    const maxHeight = Math.max(160, viewport.height - 180);
    setTerminalHeight((current) => Math.min(current, maxHeight));
  }, [viewport.height]);

  // T-206/T-207: localPaneWidth (Split mode's LOCAL pane) and
  // folderPaneWidth (non-split mode's REMOTE folder tree) were previously
  // clamped only at drag time (resizePane's own Math.min(maxWidth, ...)) --
  // unlike terminalHeight just above, shrinking the window after dragging
  // either pane to a wide value left it pinned at that now-stale width,
  // which could push the sibling pane (REMOTE, or the file list) off
  // screen instead of shrinking together with the window. Mirrors the same
  // maxWidth formula resizePane already uses at drag time.
  useEffect(() => {
    const maxWidth = Math.max(220, Math.min(720, viewport.width - 300));
    setLocalPaneWidth((current) => Math.min(current, maxWidth));
    setFolderPaneWidth((current) => Math.min(current, maxWidth));
  }, [viewport.width]);

  // T-208: localTreeWidth (the LOCAL mini folder-tree column) had the same
  // drag-time-only clamping gap -- re-clamp it against the current
  // localPaneWidth any time either the window or the LOCAL pane itself
  // shrinks, using the same ceiling formula resizeLocalTree already uses.
  useEffect(() => {
    const maxTreeWidth = Math.max(80, Math.min(Math.max(160, localPaneWidth - 160), viewport.width));
    setLocalTreeWidth((current) => Math.min(current, maxTreeWidth));
  }, [viewport.width, localPaneWidth]);


  useSshTerminal({
    enabled: terminalOpen,
    activeTabId: activeSshTabId,
    replayOutput: sshTabsRef.current.find((item) => item.id === activeSshTabId)?.output || "Select a saved SSH session or open the Session manager to add one.\r\n",
    replayKey: `${activeSshTabId}:${sshTabsRef.current.find((item) => item.id === activeSshTabId)?.sessionId || ""}`,
    bracketedPasteControlEnabled: desktopSettings.bracketedPasteControlEnabled,
    setTabs: setSshTabs,
    setConnected: setSshConnected,
    setNotice,
    tabsRef: sshTabsRef,
    pendingRequestsRef: pendingSshConnectRequestsRef,
    terminalRef: terminalInstanceRef,
    hostRef: terminalHostRef,
    activeTabIdRef: activeSshTabIdRef,
    outputRef: sshOutputRef,
    sessionIdRef: sshSessionIdRef,
    connectingRef: sshConnectingRef,
    writeQueuesRef: sshWriteQueuesRef,
    recordingWriteQueuesRef,
    recordingRef,
    secretPromptRef: sshSecretPromptRef,
    shellInputRef,
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

  // Fires one raw HTTP request through the Tauri `api_request` command,
  // using whichever bearer token the caller passes in -- separated from
  // `api()`/`apiForLocation()` below so the 401-retry wrapper can call it
  // twice (once with the old token, once with a freshly refreshed one)
  // without duplicating the request-building logic itself.
  const rawApiRequest = async (endpoint: string, init: RequestInit, token: string, locationId: string) => {
    const headers = new Headers(init.headers);
    if (token && token !== "cookie") headers.set("Authorization", `Bearer ${token}`);
    if (locationId) headers.set("X-Location-ID", locationId);
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

  // Every REST call to the API Server goes through here. The backend signs
  // its JWTs with a fixed 24h lifetime (see src/backend/auth/auth.js and
  // src/backend/server.js) and exposes no refresh-token endpoint, so a
  // long-running desktop session eventually gets a 401 on an otherwise
  // completely normal request. Before this fix (#233) that 401 just became
  // a visible error message while `session.token` stayed non-empty --
  // leaving the whole app stuck in a half-signed-in state that neither the
  // login screen's own guard (`!session.token`) nor the user could recover
  // from without restarting the app. Now: on 401, silently try to
  // re-authenticate with the saved credentials and replay the exact same
  // request once with the new token; only surface the 401 (and let
  // `session.token` be cleared so the app falls back to the login screen)
  // if that refresh attempt itself fails or there is nothing saved to
  // refresh with.
  const api = async (endpoint: string, init: RequestInit = {}) => {
    const response = await rawApiRequest(endpoint, init, session.token, session.locationId);
    if (response.status !== 401) return response;
    const refreshedToken = await refreshTokenOnce();
    if (!refreshedToken) {
      setSession((current) => ({ ...current, token: "" }));
      notify("Your session expired. Please sign in again.");
      return response;
    }
    return rawApiRequest(endpoint, init, refreshedToken, session.locationId);
  };

  const apiForLocation = async (endpoint: string, locationId: string) => {
    const response = await rawApiRequest(endpoint, { method: "GET" }, session.token, locationId);
    if (response.status !== 401) return response;
    const refreshedToken = await refreshTokenOnce();
    if (!refreshedToken) {
      setSession((current) => ({ ...current, token: "" }));
      notify("Your session expired. Please sign in again.");
      return response;
    }
    return rawApiRequest(endpoint, { method: "GET" }, refreshedToken, locationId);
  };

  // The REMOTE/API connection slice pulled out of main.tsx ahead of the
  // full Phase 5 extraction (GitHub issue #229) while fixing issue #233
  // (token refresh) -- see useRemoteApiActions.ts for why.
  const {
    activeLocation, hasCapability, locationOnline,
    loadLocations, findSshProfileById, ensureApiRemote, connectedSshBrowseOptions,
  } = useRemoteApiActions({
    api, readError, session, setSession, remoteSshEntryId,
    managedSessions, sshTabs, locations, setLocations, setLocationsLoading,
    locationsLoadedRef: locationsLoaded, locationRefreshInProgressRef: locationRefreshInProgress,
  });

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

  const refreshRemoteFiles = async () => {
    const refreshPath = path;
    if (remoteSshEntryId) {
      await Promise.all([loadLocations(), loadFiles(refreshPath)]);
      return;
    }

    const cacheResponse = await api("/api/files/refresh-cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directoryPath: refreshPath }),
    });
    if (!cacheResponse.ok) throw new Error(await readError(cacheResponse));

    await Promise.all([loadLocations(), loadFiles(refreshPath)]);
  };

  // Where "up" from `path` should go for the LOCAL pane. Non-elevated
  // sessions can enter other Windows drive roots, but HOME remains the only
  // parent of the relative HOME paths. Elevated sessions can also leave HOME.
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

  // Keeps the app connected to the API Server for as long as it stays
  // open, instead of waiting for a 401 to happen on some future request
  // (issue #233). Computes the JWT's *real* expiry from its own `exp`
  // claim (decodeJwtExpiryMs) rather than assuming the backend's current
  // 24h default, so this keeps working correctly even if the backend's
  // token lifetime configuration ever changes. Schedules one proactive
  // refresh a few minutes before that real expiry; every successful
  // refresh updates `session.token`, which re-runs this same effect and
  // schedules the next one -- so the chain continues automatically until
  // logout/close. If the expiry can't be determined (decodeJwtExpiryMs
  // returned null) or the user didn't opt into "Save user info", there is
  // nothing safe to proactively refresh with, so this effect does
  // nothing and the 401-triggered path in `api()`/`apiForLocation()`
  // remains the only fallback.
  useEffect(() => {
    if (!session.token || !session.saveUserInformation) return undefined;
    const expiryMs = decodeJwtExpiryMs(session.token);
    if (expiryMs === null) return undefined;
    const delayMs = clampRefreshDelayMs(expiryMs - Date.now() - tokenRefreshLeadMs);
    // Guards against the timer's async refresh landing *after* this effect
    // was torn down (for example the user clicked "Sign out" while the
    // silent refresh was already in flight) -- without this flag, that
    // stale refresh's `setSession` call would silently sign the user back
    // in right after they explicitly signed out.
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void refreshTokenOnce().then((refreshedToken) => {
        if (cancelled) return;
        if (!refreshedToken) {
          setSession((current) => ({ ...current, token: "" }));
          notify("Your session expired. Please sign in again.");
        }
      });
    }, delayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [session.token, session.saveUserInformation]);

  useEffect(() => {
    if (!session.token) return undefined;
    void (async () => {
      try {
        await loadLocalFiles("");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    })();
    return undefined;
  }, [session.token]);

  useEffect(() => {
    if (!session.token) return undefined;
    void (async () => {
      try {
        const elevated = await invoke<boolean>("is_local_elevated");
        setIsLocalElevated(elevated);
        const roots = await invoke<string[]>("list_local_roots");
        if (elevated) setLocalHomeAbsolute(await invoke<string>("local_home_path"));
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
  }, [session.token]);

  useEffect(() => {
    if (session.token && session.locationId) {
      const nextPath = pendingRemotePath ?? "";
      if (pendingRemotePath !== null) setPendingRemotePath(null);
      void loadFiles(nextPath).catch((error) => setNotice(error.message));
      void loadTreeChildren("").catch((error) => setNotice(error.message));
    }
  }, [session.token, session.locationId]);

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

  const {
    saveWorkspaceName,
    openWorkspaceNameDialog,
    removeSession,
    loadSshProfileDraft,
    selectWorkspaceSession,
    openSessionsModal,
    startNewWorkspace,
    startNewSshEntry,
    openAddSshEntryDialog,
    openEditSshEntryDialog,
    saveSshEntry,
    forgetSshPassword,
    removeSshEntry,
    removeSshEntryDirect,
    emptyRestEntry,
    openAddRestEntryDialog,
    openEditRestEntryDialog,
    isEditingRestEntry,
    saveRestEntry,
    removeRestEntry,
    removeRestEntryDirect,
    emptyVncEntry,
    openAddVncEntryDialog,
    openEditVncEntryDialog,
    isEditingVncEntry,
    vncEndpointParts,
    vncUsernameParts,
    saveVncEntry,
    removeVncEntry,
    removeVncEntryDirect,
    installVncSshKey,
    selectRestWorkspace,
    selectVncWorkspace,
    workspaceSessions,
    activeWorkspaceSession,
    activeManagedWorkspace,
    restWorkspace,
    vncWorkspace,
    ensureRestWorkspaceId,
    ensureVncWorkspaceId,
  } = useSessionsActions({
    run, notify, setNotice,
    managedSessions, setManagedSessions,
    workspaceSessionId, setWorkspaceSessionId,
    sessionNameDraft, setSessionNameDraft,
    setSessionFormError, setLastSavedSessionId,
    setWorkspaceNameDialogOpen, setSessionsOpen,
    sshProfiles, setSshProfiles,
    sshProfileId, setSshProfileId,
    selectedSshEntryId, setSelectedSshEntryId,
    sshProfileDraft, setSshProfileDraft,
    setSshPasswordSaved,
    sshEntryDraftId, setSshEntryDraftId,
    setSshEntryDialogOpen,
    restEntryDraft, setRestEntryDraft, setRestEntryDialogOpen,
    activeRestEntryId, setActiveRestEntryId,
    vncEntryDraft, setVncEntryDraft, setVncEntryDialogOpen, setVncEntryModalTab,
    activeVncEntryId, setActiveVncEntryId,
    vmSshPasswordDraft, setVmSshPasswordDraft, vmSshPasswordSaved, setVmSshPasswordSaved,
    hostSshPasswordDraft, setHostSshPasswordDraft, hostSshPasswordSaved, setHostSshPasswordSaved,
  });

  const {
    activeTab: activeSshTab,
    recordingHasOutput,
    createSshTab,
    closeSshTab,
    selectSshTab,
    performSshConnect,
    cancelSshConnect,
    quickConnectSsh,
    reorderSshTabs,
    connectSsh,
    disconnectSsh,
    startRecording,
    stopRecording,
    saveSshLogs,
    openSaveLogDialog,
  } = useSshTerminalActions({
    tabs: sshTabs,
    setTabs: setSshTabs,
    activeTabId: activeSshTabId,
    setActiveTabId: setActiveSshTabId,
    terminalInstanceRef,
    connectAttemptRef,
    pendingRequestsRef: pendingSshConnectRequestsRef,

    connectingRef: sshConnectingRef,
    recordingWriteQueuesRef,
    workspaces: managedSessions,
    workspaceId: workspaceSessionId,
    setWorkspaceId: setWorkspaceSessionId,
    selectedEntryId: selectedSshEntryId,
    setSelectedEntryId: setSelectedSshEntryId,
    setSshProfileId,
    setTerminalOpen,
    loadSshProfileDraft,
    onOpenWorkspaceManager: () => openSessionsModal(),
    onNotify: notify,
    onSetNotice: setNotice,
    run: (action) => { void run(action); },
    onWriteOperationLog: (...args: Parameters<typeof writeOperationLog>) => writeOperationLog(...args),
    describeError: (error: unknown) => describeError(error),
    saveLogNameDraft,
    setSaveLogNameDraft,
    saveLogDestinationPath,
    setSaveLogDestinationPath,
    saveLogNameOpen,
    setSaveLogNameOpen,
    localPath,
  });

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
      setSshTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, output: appendSshTabOutput(item.output, `Installing SSH key for ${profile.username}@${profile.host}:${profile.port} using the saved password...\n`) }));
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
        setSshTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, output: appendSshTabOutput(item.output, `${message}\n`) }));
        notify(message);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setSshTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, output: appendSshTabOutput(item.output, `${detail}\n`) }));
        setNotice(detail);
      }
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
    }).catch((error) => console.error("Operation log write failed", error));
  };
  // Every file-mutating action below should log both how it finished, success
  // or failure -- an on-screen `notify`/error banner disappears after a few
  // seconds and is gone for good, so without a persisted log entry a failure
  // (e.g. "builder error") leaves no trace to diagnose after the fact.
  const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));


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

  const {
    updateQueueItem,
    updateQueueProgress,
    isQueueItemCancelled,
    cancelQueueItem,
    removeQueueItem,
    clearQueueHistory,
    clearQueueStatus,
    clearFinishedQueue,
    executeQueuedSshUpload,
    executeQueuedUpload,
    executeQueuedDownload,
    executeQueuedDownloadSet,
    executeQueuedSshDownload,
    runQueuedSshUpload,
    runQueuedUpload,
    runQueuedDownload,
    runQueuedDownloadSet,
    runQueuedSshDownload,
    retryDesktopQueueItem,
    renderDesktopQueueItem,
    queueDragPreparation,
    enqueueQueueDownload,
    enqueueDownload,
    enqueueSshDownload,
    download,
  } = useTransferQueueActions({
    run, notify, setNotice, api, readError,
    session,
    serverUrl: () => serverUrl(session),
    writeOperationLog, describeError,
    path, localPath, loadFiles,
    activeLocationDisplayName: activeLocation?.displayName,
    activeManagedWorkspaceName: activeManagedWorkspace?.name,
    findSshProfileById, remoteSshEntryId, selectedItems,
    transferQueue, setTransferQueue, queueStoreRef,
    setQueueOpen, setArchiveFormatOpen, setArchiveFormatDraft,
    queueProgressSamplesRef, latestQueueProgressRef, queueCompletionHandlersRef,
    cancelledQueueItemsRef, queueSchedulerRef,
  });

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
    // .file-table/.file-grid/.local-file-list (see styles/layout/context-menu.css)
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

  const canSearchRemote = Boolean(session.token && session.locationId && !remoteSshEntryId);

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
     const headers: [string, string][] = session.token && session.token !== "cookie"
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
         downloadHeaders: session.token && session.token !== "cookie"
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
        const headers: [string, string][] = session.token && session.token !== "cookie"
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

  const {
    createShareLink,
    loadShareLinks,
    openShareLinks,
    shareLinkUrl,
    copyManagedShareLink,
    revokeManagedShareLink,
    deleteExpiredShareLink,
    deleteRevokedShareLink,
    shareLinkStatus,
    shareLinkGroups,
    share,
  } = useShareLinksActions({
    run, notify, api, readError,
    session,
    serverUrl: () => serverUrl(session),
    activeLocationDisplayName: activeLocation?.displayName,
    writeOperationLog, describeError,
    shareLinkMode: desktopSettings.shareLinkMode,
    shareLinkExpirationDays: desktopSettings.shareLinkExpirationDays,
    ensureApiRemote,
    selectedShareableItem: selectedItems.length === 1 ? selectedItems[0] : undefined,
    shareLinks, setShareLinks, setShareLinksLoading,
    setShareUrl, setShareLinksOpen, setSharePasswordOpen, setSharePasswordDraft,
  });


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
    // Clearing `session.token` here also tears down the auto-refresh
    // effect above (it depends on `session.token`), whose cleanup sets
    // `cancelled = true` -- so a refresh already in flight at the moment
    // of sign-out cannot land afterward and silently sign the user back
    // in (#233).
    setSession((current) => ({
      ...current,
      token: "",
      username: "",
      userId: null,
      role: "",
      permissions: [],
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
    const rootLabel = absolute ? (segments[0]?.label || "/") : "HOMEDIR/";
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
  const commandbarRef = useRef<HTMLElement>(null);
  const [commandBarOverflow, setCommandBarOverflow] = useState(mobileLayout);
  const commandBarOverflowRef = useRef(mobileLayout);
  const commandBarRequiredWidthRef = useRef<number | null>(null);
  useEffect(() => {
    const commandbar = commandbarRef.current;
    if (!commandbar) return undefined;
    const measure = () => {
      if (mobileLayout) {
        commandBarOverflowRef.current = true;
        setCommandBarOverflow(true);
        return;
      }
      const actionButtons = Array.from(commandbar.querySelectorAll<HTMLButtonElement>(":scope > button"));
      if (commandBarOverflowRef.current && commandBarRequiredWidthRef.current !== null) {
        // This width was measured while every action was rendered, so it is
        // the minimum width needed to restore the full toolbar safely.
        if (commandbar.clientWidth < commandBarRequiredWidthRef.current) return;
        commandBarOverflowRef.current = false;
        commandBarRequiredWidthRef.current = null;
        setCommandBarOverflow(false);
        return;
      }
      const nonActionWidth = Array.from(commandbar.children)
        .filter((child) => !(child instanceof HTMLButtonElement) && !child.classList.contains("divider"))
        .reduce((width, child) => width + child.getBoundingClientRect().width, 0);
      const dividerWidth = Array.from(commandbar.children)
        .filter((child) => child.classList.contains("divider"))
        .reduce((width, child) => width + child.getBoundingClientRect().width, 0);
      const gap = Number.parseFloat(getComputedStyle(commandbar).gap) || 0;
      const requiredWidth = nonActionWidth
        + actionButtons.reduce((width, button) => width + button.scrollWidth, 0)
        + dividerWidth
        + (commandbar.children.length - 1) * gap;
      const overflow = requiredWidth > commandbar.clientWidth + 1
        || commandbar.scrollWidth > commandbar.clientWidth + 1
        || actionButtons.some((button) => button.scrollWidth > button.clientWidth + 1);
      commandBarOverflowRef.current = overflow;
      commandBarRequiredWidthRef.current = overflow ? requiredWidth : null;
      setCommandBarOverflow(overflow);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(commandbar);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [mobileLayout, appMode, splitMode]);
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
    <AppShell style={themeVariables} className={`explorer ui-profile-${desktopSettings.uiProfile} ui-layout-${mobileLayout ? "mobile" : "desktop"} ${desktopSettings.glassMainEnabled ? "" : "glass-main-off"} ${desktopSettings.glassMenusEnabled ? "" : "glass-menus-off"} ${desktopSettings.glassDialogsEnabled ? "" : "glass-dialogs-off"} ${appMode !== "location" ? "rest-mode" : ""} ${appMode === "vnc" ? "vnc-mode" : ""}`}>
      <Suspense fallback={null}>
      <DesktopTitlebar
        appMode={appMode}
        vncEnabled={desktopSettings.proxmoxVncModeEnabled}
        restEnabled={desktopSettings.restApiModeEnabled}
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
      <nav ref={commandbarRef} className="commandbar" aria-label={appMode === "rest" ? "REST API actions" : "File actions"}>
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
        {!commandBarOverflow && <>
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
        </>}
        {commandBarOverflow ? (
          <CommandBarOverflowMenu
            label="More actions"
            actions={[
              {
                key: "new-folder",
                label: "New folder",
                disabled: splitMode && activePane === "local"
                  ? busy
                  : busy || !(remoteSshEntryId ? true : locationOnline && hasCapability("mkdir")),
                onClick: createFolder,
              },
              {
                key: "download",
                label: "Download",
                disabled:
                  busy ||
                  (splitMode && remoteSshEntryId
                    ? activePane !== "remote" || !selectedItems.length
                    : !selectedItems.length || !(remoteSshEntryId ? true : locationOnline && hasCapability("read"))),
                title: splitMode && remoteSshEntryId ? "Bring the REMOTE selection into the current LOCAL folder" : undefined,
                onClick: () => {
                  if (splitMode && remoteSshEntryId && activePane === "remote" && selectedItems.length) {
                    downloadRemoteItemsToLocal(selectedItems);
                  } else {
                    download();
                  }
                },
              },
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
              {
                key: "refresh",
                label: "Refresh",
                disabled: busy,
                onClick: () => void run(refreshRemoteFiles),
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
        {!commandBarOverflow && <button onClick={() => void run(refreshRemoteFiles)} disabled={busy}>Refresh</button>}
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
            onAddEntry={() => openAddRestEntryDialog(ensureRestWorkspaceId())}
            onEditEntry={(entry) => restWorkspace && openEditRestEntryDialog(restWorkspace.id, entry)}
            onRemoveEntry={(entry) => restWorkspace && removeRestEntryDirect(restWorkspace.id, entry)}
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
             onAddEntry={() => openAddVncEntryDialog(ensureVncWorkspaceId())}
             onEditEntry={(entry) => vncWorkspace && openEditVncEntryDialog(vncWorkspace.id, entry)}
             onRemoveEntry={(entry) => vncWorkspace && removeVncEntryDirect(vncWorkspace.id, entry)}
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
          <SharePasswordDialog
            sharePasswordDraft={sharePasswordDraft}
            setSharePasswordDraft={setSharePasswordDraft}
            onClose={() => setSharePasswordOpen(false)}
            onCreate={(password) => void createShareLink(password)}
          />
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
          <SettingsModal
            desktopSettings={desktopSettings}
            setDesktopSettings={setDesktopSettings}
            settingsPanel={settingsPanel}
            setSettingsPanel={setSettingsPanel}
            themeSnapshot={themeSnapshotRef.current}
            storageInfo={storageInfo}
            modalStyle={modalStyle("settings")}
            onDragStart={beginModalDrag("settings")}
            onClose={() => setSettingsOpen(false)}
            onSave={() => { localStorage.setItem(desktopSettingsKey, JSON.stringify(desktopSettings)); notify("Desktop settings saved."); }}
            onManageShareLinks={openShareLinks}
            canManageShareLinks={Boolean(session.token)}
            onClearHistory={clearHistory}
            onClearLogs={clearLogs}
          />
        )}
        {shareLinksOpen && (
          <ShareLinksModal
            shareLinks={shareLinks}
            shareLinksLoading={shareLinksLoading}
            shareLinkGroups={shareLinkGroups}
            isAdmin={session.role === "admin"}
            modalStyle={modalStyle("share-links")}
            onDragStart={beginModalDrag("share-links")}
            onClose={() => setShareLinksOpen(false)}
            onRefresh={() => void loadShareLinks()}
            shareLinkUrl={shareLinkUrl}
            shareLinkStatus={shareLinkStatus}
            onCopyLink={(link, kind) => void copyManagedShareLink(link, kind)}
            onRevokeLink={revokeManagedShareLink}
            onClearRevoked={deleteRevokedShareLink}
            onClearExpired={deleteExpiredShareLink}
          />
        )}
        {sessionsOpen && (
          <SessionsModal
            managedSessions={managedSessions}
            workspaceSessionId={workspaceSessionId}
            activeManagedWorkspace={activeManagedWorkspace}
            sessionFormError={sessionFormError}
            lastSavedSessionId={lastSavedSessionId}
            restApiModeEnabled={desktopSettings.restApiModeEnabled}
            proxmoxVncModeEnabled={desktopSettings.proxmoxVncModeEnabled}
            modalStyle={modalStyle("sessions")}
            onDragStart={beginModalDrag("sessions")}
            onClose={() => setSessionsOpen(false)}
            setWorkspaceSessionId={setWorkspaceSessionId}
            setActiveRestEntryId={setActiveRestEntryId}
            setActiveVncEntryId={setActiveVncEntryId}
            setAppMode={setAppMode}
            startNewWorkspace={startNewWorkspace}
            openWorkspaceNameDialog={openWorkspaceNameDialog}
            removeSession={removeSession}
            openAddSshEntryDialog={openAddSshEntryDialog}
            openEditSshEntryDialog={openEditSshEntryDialog}
            removeSshEntryDirect={removeSshEntryDirect}
            openAddRestEntryDialog={openAddRestEntryDialog}
            openEditRestEntryDialog={openEditRestEntryDialog}
            removeRestEntryDirect={removeRestEntryDirect}
            openAddVncEntryDialog={openAddVncEntryDialog}
            openEditVncEntryDialog={openEditVncEntryDialog}
            removeVncEntryDirect={removeVncEntryDirect}
          />
        )}
        {workspaceNameDialogOpen && (
          <WorkspaceNameDialog
            isEditing={Boolean(workspaceSessionId)}
            sessionFormError={sessionFormError}
            sessionNameDraft={sessionNameDraft}
            setSessionNameDraft={setSessionNameDraft}
            modalStyle={modalStyle("workspace-name")}
            onDragStart={beginModalDrag("workspace-name")}
            onClose={() => setWorkspaceNameDialogOpen(false)}
            onSave={saveWorkspaceName}
          />
        )}
      {sshEntryDialogOpen && (
        <SshEntryDialog
          isEditing={Boolean(sshEntryDraftId)}
          workspaceName={activeManagedWorkspace?.name}
          sessionFormError={sessionFormError}
          sshProfileDraft={sshProfileDraft}
          setSshProfileDraft={setSshProfileDraft}
          sshPasswordSaved={sshPasswordSaved}
          modalStyle={modalStyle("ssh-entry")}
          onDragStart={beginModalDrag("ssh-entry")}
          onClose={() => setSshEntryDialogOpen(false)}
          onForgetPassword={forgetSshPassword}
          onRemove={removeSshEntry}
          onSave={saveSshEntry}
        />
      )}
      {restEntryDialogOpen && restEntryDraft && (
        <RestEntryDialog
          isEditing={isEditingRestEntry(activeManagedWorkspace, restEntryDraft)}
          workspaceName={activeManagedWorkspace?.name}
          sessionFormError={sessionFormError}
          restEntryDraft={restEntryDraft}
          setRestEntryDraft={setRestEntryDraft}
          modalStyle={modalStyle("rest-entry")}
          onDragStart={beginModalDrag("rest-entry")}
          onClose={() => setRestEntryDialogOpen(false)}
          onRemove={removeRestEntry}
          onSave={saveRestEntry}
        />
      )}
      {vncEntryDialogOpen && vncEntryDraft && (
        <VncEntryDialog
          isEditing={isEditingVncEntry(activeManagedWorkspace, vncEntryDraft)}
          workspaceName={activeManagedWorkspace?.name}
          sessionFormError={sessionFormError}
          vncEntryDraft={vncEntryDraft}
          setVncEntryDraft={setVncEntryDraft}
          vncEntryModalTab={vncEntryModalTab}
          setVncEntryModalTab={setVncEntryModalTab}
          vmSshPasswordDraft={vmSshPasswordDraft}
          setVmSshPasswordDraft={setVmSshPasswordDraft}
          vmSshPasswordSaved={vmSshPasswordSaved}
          hostSshPasswordDraft={hostSshPasswordDraft}
          setHostSshPasswordDraft={setHostSshPasswordDraft}
          hostSshPasswordSaved={hostSshPasswordSaved}
          modalStyle={modalStyle("vnc-entry")}
          onDragStart={beginModalDrag("vnc-entry")}
          onClose={() => setVncEntryDialogOpen(false)}
          onInstallVmKey={() => void installVncSshKey("vm")}
          onInstallHostKey={() => void installVncSshKey("host")}
          onRemove={removeVncEntry}
          onSave={saveVncEntry}
          vncEndpointParts={vncEndpointParts}
          vncUsernameParts={vncUsernameParts}
        />
      )}
      <TerminalWorkspace
        open={terminalOpen}
        height={terminalHeight}
        maximized={terminalMaximized}
        quickListOpen={sshQuickListOpen}
        tabs={sshTabs}
        activeTabId={activeSshTabId}
        activeTab={activeSshTab}
        workspaces={workspaceSessions}
        activeWorkspaceId={workspaceSessionId}
        activeWorkspace={activeWorkspaceSession}
        connected={sshConnected}
        recording={recording}
        recordingHasOutput={recordingHasOutput}
        savedLogPaths={savedLogPaths}
        activeQueueCount={transferQueue.filter((item) => ["queued", "running", "retrying", "needs_user_action"].includes(item.status)).length}
        terminalHostRef={terminalHostRef}
        onToggleQuickList={() => setSshQuickListOpen((open) => !open)}
        onResizeStart={beginTerminalResize}
        onSelectTab={selectSshTab}
        onReorderTabs={reorderSshTabs}
        onCloseTab={closeSshTab}
        onCreateTab={() => { createSshTab(); }}
        onQuickConnect={quickConnectSsh}
        onSelectWorkspace={selectWorkspaceSession}
        onConnect={connectSsh}
        onDisconnect={disconnectSsh}
        onCancelConnect={cancelSshConnect}
        onStartRecording={startRecording}
        onStopRecording={stopRecording}
        onSaveLog={openSaveLogDialog}
        onOpenSavedLog={openLocalViewer}
        onOpenWorkspaceManager={() => { void openSessionsModal(); }}
        onOpenQueue={() => setQueueOpen(true)}
        onToggleMaximized={toggleTerminalMaximized}
        onClose={() => setTerminalOpen(false)}
        onRestore={() => setTerminalOpen(true)}
      />
      {archiveFormatOpen && (
        <ArchiveFormatDialog
          archiveFormatDraft={archiveFormatDraft}
          setArchiveFormatDraft={setArchiveFormatDraft}
          onClose={() => setArchiveFormatOpen(false)}
          onConfirm={() => (archiveFormatDraft === "queue" ? enqueueQueueDownload() : enqueueDownload(archiveFormatDraft))}
        />
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
