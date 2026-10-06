// Pure window-manager model for the Pane desktop. Everything here is plain
// data + functions (no React, no DOM) so the geometry / z-order rules can be
// unit tested and reused by the reducer in usePaneWindows.ts.

/**
 * Window kinds. "sftp" and "ssh" windows belong to an SSH entry: `sftp:<entryId>`
 * (one per entry, see sftpWindowId) and `ssh:<entryId>#<n>` (one per opened SSH
 * terminal, `n` = 1, 2, 3, ... so the same entry can be opened any number of
 * times, see sshWindowId). Browser and Proxmox VNC flow panes are also opened
 * on demand. VNC uses `vnc-picker:<entryId>`, `vnc-screen:<sessionId>`, and
 * `vnc-files:<sessionId>` so each stage has an independent window. Every other
 * kind has exactly one window whose id is the kind itself.
 */
export type PaneWindowKind = "local" | "remote" | "rest" | "browser" | "sftp" | "ssh" | "vnc-picker" | "vnc-screen" | "vnc-files";

export type PaneSftpWindowId = `sftp:${string}`;
export type PaneSshWindowId = `ssh:${string}#${number}`;
export type PaneBrowserWindowId = `browser:${number}`;
export type PaneVncPickerWindowId = `vnc-picker:${string}`;
export type PaneVncScreenWindowId = `vnc-screen:${string}`;
export type PaneVncFilesWindowId = `vnc-files:${string}`;
export type PaneEntryWindowKind = "sftp" | "ssh";
type PaneVncWindowKind = "vnc-picker" | "vnc-screen" | "vnc-files";
type PaneSingletonWindowKind = Exclude<PaneWindowKind, PaneEntryWindowKind | "browser" | PaneVncWindowKind>;
export type PaneWindowId = PaneSingletonWindowKind | PaneBrowserWindowId | PaneSftpWindowId | PaneSshWindowId | PaneVncPickerWindowId | PaneVncScreenWindowId | PaneVncFilesWindowId;

export const PANE_WINDOW_KINDS: readonly PaneWindowKind[] = ["local", "remote", "rest", "browser", "sftp", "ssh", "vnc-picker", "vnc-screen", "vnc-files"];

/** Kinds that only ever have one window (id === kind). */
export const PANE_SINGLETON_KINDS: readonly PaneSingletonWindowKind[] = ["local", "remote", "rest"];

const SFTP_PREFIX = "sftp:";
const SSH_PREFIX = "ssh:";
const BROWSER_PREFIX = "browser:";
const VNC_PICKER_PREFIX = "vnc-picker:";
const VNC_SCREEN_PREFIX = "vnc-screen:";
const VNC_FILES_PREFIX = "vnc-files:";

export const sftpWindowId = (entryId: string): PaneSftpWindowId => `${SFTP_PREFIX}${entryId}`;
export const sshWindowId = (entryId: string, instance: number): PaneSshWindowId => `${SSH_PREFIX}${entryId}#${instance}`;
export const browserWindowId = (instance: number): PaneBrowserWindowId => `${BROWSER_PREFIX}${instance}`;
export const vncPickerWindowId = (entryId: string): PaneVncPickerWindowId => `${VNC_PICKER_PREFIX}${entryId}`;
export const vncScreenWindowId = (sessionId: string): PaneVncScreenWindowId => `${VNC_SCREEN_PREFIX}${sessionId}`;
export const vncFilesWindowId = (sessionId: string): PaneVncFilesWindowId => `${VNC_FILES_PREFIX}${sessionId}`;

const suffixOf = (id: string, prefix: string): string | null =>
  id.startsWith(prefix) && id.length > prefix.length ? id.slice(prefix.length) : null;

/** Proxmox entry id behind a VNC VM-picker window. */
export const vncPickerEntryIdOf = (id: string): string | null => suffixOf(id, VNC_PICKER_PREFIX);

/** Session id behind a VNC screen window. */
export const vncScreenSessionIdOf = (id: string): string | null => suffixOf(id, VNC_SCREEN_PREFIX);

/** Session id behind a VNC file-transfer window. */
export const vncFilesSessionIdOf = (id: string): string | null => suffixOf(id, VNC_FILES_PREFIX);

/** True for any dynamic VNC flow window. */
export function isVncFlowWindow(id: unknown): boolean {
  return typeof id === "string" && (
    vncPickerEntryIdOf(id) !== null || vncScreenSessionIdOf(id) !== null || vncFilesSessionIdOf(id) !== null
  );
}

/** The instance number of a `browser:<n>` window id (null for malformed ids). */
export function browserPaneInstanceOf(id: string): number | null {
  if (!id.startsWith(BROWSER_PREFIX)) return null;
  const instance = id.slice(BROWSER_PREFIX.length);
  if (!/^[1-9]\d*$/.test(instance)) return null;
  const number = Number(instance);
  return Number.isSafeInteger(number) ? number : null;
}

export function isBrowserWindow(id: unknown): id is PaneBrowserWindowId {
  return typeof id === "string" && browserPaneInstanceOf(id) !== null;
}

/** The SSH entry id behind a `sftp:<entryId>` window id (null for every other window). */
export function sshEntryIdOf(id: string): string | null {
  return id.startsWith(SFTP_PREFIX) && id.length > SFTP_PREFIX.length ? id.slice(SFTP_PREFIX.length) : null;
}

/** Splits a `ssh:<entryId>#<n>` terminal window id (null for every other window or a malformed id). */
function parseSshWindowId(id: string): { entryId: string; instance: number } | null {
  if (!id.startsWith(SSH_PREFIX)) return null;
  const separator = id.lastIndexOf("#");
  if (separator <= SSH_PREFIX.length) return null;
  const counter = id.slice(separator + 1);
  if (!/^[1-9]\d*$/.test(counter)) return null;
  return { entryId: id.slice(SSH_PREFIX.length, separator), instance: Number(counter) };
}

/** The SSH entry id behind a `ssh:<entryId>#<n>` terminal window id (null for every other window). */
export function sshPaneEntryIdOf(id: string): string | null {
  return parseSshWindowId(id)?.entryId ?? null;
}

/** The instance number (1, 2, 3, ...) of a `ssh:<entryId>#<n>` terminal window id (null for every other window). */
export function sshPaneInstanceOf(id: string): number | null {
  return parseSshWindowId(id)?.instance ?? null;
}

/** Window kind for an id, or null when the id is not a valid window id. */
export function kindOf(id: unknown): PaneWindowKind | null {
  if (typeof id !== "string") return null;
  if (sshEntryIdOf(id)) return "sftp";
  if (parseSshWindowId(id)) return "ssh";
  if (browserPaneInstanceOf(id) !== null) return "browser";
  if (vncPickerEntryIdOf(id) !== null) return "vnc-picker";
  if (vncScreenSessionIdOf(id) !== null) return "vnc-screen";
  if (vncFilesSessionIdOf(id) !== null) return "vnc-files";
  return (PANE_SINGLETON_KINDS as readonly string[]).includes(id) ? (id as PaneWindowKind) : null;
}

/**
 * SFTP and SSH windows belong to one live connection of an SSH entry: closing
 * one discards it (its body unmounts and disconnects), and they are never
 * written to or restored from storage.
 */
export function isEntryWindow(id: unknown): boolean {
  const kind = kindOf(id);
  return kind === "sftp" || kind === "ssh";
}

/** Browser panes, like SSH/SFTP panes, are session-only and are never restored. */
export function isTransientWindow(id: unknown): boolean {
  return isEntryWindow(id) || kindOf(id) === "browser" || isVncFlowWindow(id);
}

/** Dynamic windows that are rendered in the taskbar instead of the singleton group. */
export function isDynamicWindow(id: unknown): boolean {
  return isTransientWindow(id);
}

export type PaneRect = { x: number; y: number; w: number; h: number };
export type PaneSize = { w: number; h: number };

export type PaneWindowState = PaneRect & {
  id: PaneWindowId;
  /** false = the window is closed (frame hidden; bodies of non-keep-alive kinds are unmounted). */
  open: boolean;
  minimized: boolean;
  maximized: boolean;
  z: number;
};

export type PaneLayout = {
  windows: PaneWindowState[];
  activeId: PaneWindowId | null;
};

export const PANE_MIN_SIZE: Record<PaneWindowKind, PaneSize> = {
  local: { w: 360, h: 260 },
  remote: { w: 460, h: 280 },
  rest: { w: 520, h: 340 },
  sftp: { w: 460, h: 280 },
  ssh: { w: 460, h: 280 },
  browser: { w: 560, h: 360 },
  "vnc-picker": { w: 440, h: 320 },
  "vnc-screen": { w: 620, h: 380 },
  "vnc-files": { w: 540, h: 320 },
};

export const PANE_KIND_LABEL: Record<PaneWindowKind, string> = {
  local: "Local",
  remote: "Remote",
  rest: "RestAPI",
  sftp: "SFTP",
  ssh: "SSH",
  browser: "Browser",
  "vnc-picker": "VNC VM",
  "vnc-screen": "VNC",
  "vnc-files": "VNC Files",
};

/** Minimum size of the window with this id (unknown ids fall back to the smallest kind minimum). */
export function minSizeOf(id: string): PaneSize {
  const kind = kindOf(id);
  return kind ? PANE_MIN_SIZE[kind] : PANE_MIN_SIZE.local;
}

export const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** Keep a rectangle inside `layer` while honouring the kind's minimum size. */
export function clampRect(rect: PaneRect, layer: PaneSize, min: PaneSize): PaneRect {
  const w = clamp(Math.round(rect.w), Math.min(min.w, layer.w), layer.w);
  const h = clamp(Math.round(rect.h), Math.min(min.h, layer.h), layer.h);
  return {
    w,
    h,
    x: clamp(Math.round(rect.x), 0, layer.w - w),
    y: clamp(Math.round(rect.y), 0, layer.h - h),
  };
}

export type ResizeEdges = { n?: boolean; s?: boolean; e?: boolean; w?: boolean };

/**
 * Compute the rectangle produced by dragging the given edges by (dx, dy)
 * starting from `start`. The opposite edge stays anchored when the minimum
 * size is reached, and the result never leaves the layer.
 */
export function resizeRect(start: PaneRect, edges: ResizeEdges, dx: number, dy: number, layer: PaneSize, min: PaneSize): PaneRect {
  const minW = Math.min(min.w, layer.w);
  const minH = Math.min(min.h, layer.h);
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (edges.w) left = clamp(start.x + dx, 0, right - minW);
  if (edges.e) right = clamp(right + dx, left + minW, layer.w);
  if (edges.n) top = clamp(start.y + dy, 0, bottom - minH);
  if (edges.s) bottom = clamp(bottom + dy, top + minH, layer.h);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Default placement of a window the first time it is opened. */
export function defaultRect(kind: PaneWindowKind, layer: PaneSize, openCount: number): PaneRect {
  const min = PANE_MIN_SIZE[kind];
  const gap = 12;
  const halfW = Math.floor((layer.w - gap * 3) / 2);
  const fullH = layer.h - gap * 2;
  let rect: PaneRect;
  if (kind === "local") rect = { x: gap, y: gap, w: halfW, h: fullH };
  else if (kind === "remote") rect = { x: gap * 2 + halfW, y: gap, w: halfW, h: fullH };
  else if (kind === "sftp") {
    rect = { x: Math.round(layer.w * 0.06), y: Math.round(layer.h * 0.06), w: Math.round(layer.w * 0.68), h: Math.round(layer.h * 0.74) };
  } else if (kind === "ssh") {
    rect = { x: Math.round(layer.w * 0.1), y: Math.round(layer.h * 0.12), w: Math.round(layer.w * 0.62), h: Math.round(layer.h * 0.7) };
  } else {
    rect = { x: Math.round(layer.w * 0.1), y: Math.round(layer.h * 0.08), w: Math.round(layer.w * 0.8), h: Math.round(layer.h * 0.84) };
  }
  // Cascade windows that would otherwise land exactly on top of an open one.
  const offset = (openCount % 6) * 28;
  if (kind !== "local" && kind !== "remote") rect = { ...rect, x: rect.x + offset, y: rect.y + offset };
  return clampRect(rect, layer, min);
}

export const nextZ = (windows: readonly PaneWindowState[]) => windows.reduce((max, win) => Math.max(max, win.z), 0) + 1;

/** The window that should hold focus: the open, non-minimized one with the highest z. */
export function pickActive(windows: readonly PaneWindowState[]): PaneWindowId | null {
  let best: PaneWindowState | null = null;
  for (const win of windows) {
    if (!win.open || win.minimized) continue;
    if (!best || win.z > best.z) best = win;
  }
  return best ? best.id : null;
}

export const STORAGE_KEY = "fileapi-pane-layout";
const STORAGE_VERSION = 1;

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Validate untrusted JSON (localStorage may be corrupt or from another version). */
export function normalizeStoredLayout(raw: unknown): PaneLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { version?: unknown; windows?: unknown };
  if (record.version !== STORAGE_VERSION || !Array.isArray(record.windows)) return null;
  const windows: PaneWindowState[] = [];
  for (const item of record.windows) {
    if (!item || typeof item !== "object") continue;
    const win = item as Record<string, unknown>;
    const id = win.id as PaneWindowId;
    // SSH/SFTP, Browser, and VNC flow windows are transient, so only durable singleton kinds are restored.
    // A window id from an older version (e.g. the former shared "vnc" workspace) is dropped here.
    if (kindOf(id) === null || isTransientWindow(id) || windows.some((existing) => existing.id === id)) continue;
    if (![win.x, win.y, win.w, win.h, win.z].every(isFiniteNumber)) continue;
    windows.push({
      id,
      x: win.x as number,
      y: win.y as number,
      w: win.w as number,
      h: win.h as number,
      z: win.z as number,
      open: win.open === true,
      minimized: win.minimized === true,
      maximized: win.maximized === true,
    });
  }
  if (!windows.length) return null;
  return { windows, activeId: pickActive(windows) };
}

export function serializeLayout(layout: PaneLayout): string {
  return JSON.stringify({ version: STORAGE_VERSION, windows: layout.windows.filter((win) => !isTransientWindow(win.id)) });
}

export function loadStoredLayout(storage: Pick<Storage, "getItem"> = localStorage): PaneLayout | null {
  try {
    const text = storage.getItem(STORAGE_KEY);
    return text ? normalizeStoredLayout(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}
