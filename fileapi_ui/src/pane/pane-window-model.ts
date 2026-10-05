// Pure window-manager model for the Pane desktop. Everything here is plain
// data + functions (no React, no DOM) so the geometry / z-order rules can be
// unit tested and reused by the reducer in usePaneWindows.ts.

/**
 * Window kinds. "sftp" and "ssh" windows are per SSH entry: their ids are
 * `sftp:<entryId>` / `ssh:<entryId>` (see sftpWindowId / sshWindowId) so
 * several can be open at once. Every other kind has exactly one window whose
 * id is the kind itself.
 */
export type PaneWindowKind = "local" | "remote" | "vnc" | "rest" | "sftp" | "ssh";

export type PaneSftpWindowId = `sftp:${string}`;
export type PaneSshWindowId = `ssh:${string}`;
export type PaneEntryWindowKind = "sftp" | "ssh";
export type PaneWindowId = Exclude<PaneWindowKind, PaneEntryWindowKind> | PaneSftpWindowId | PaneSshWindowId;

export const PANE_WINDOW_KINDS: readonly PaneWindowKind[] = ["local", "remote", "vnc", "rest", "sftp", "ssh"];

/** Kinds that only ever have one window (id === kind). */
export const PANE_SINGLETON_KINDS: readonly Exclude<PaneWindowKind, PaneEntryWindowKind>[] = ["local", "remote", "vnc", "rest"];

const SFTP_PREFIX = "sftp:";
const SSH_PREFIX = "ssh:";

export const sftpWindowId = (entryId: string): PaneSftpWindowId => `${SFTP_PREFIX}${entryId}`;
export const sshWindowId = (entryId: string): PaneSshWindowId => `${SSH_PREFIX}${entryId}`;

/** The SSH entry id behind a `sftp:<entryId>` window id (null for every other window). */
export function sshEntryIdOf(id: string): string | null {
  return id.startsWith(SFTP_PREFIX) && id.length > SFTP_PREFIX.length ? id.slice(SFTP_PREFIX.length) : null;
}

/** The SSH entry id behind a `ssh:<entryId>` terminal window id (null for every other window). */
export function sshPaneEntryIdOf(id: string): string | null {
  return id.startsWith(SSH_PREFIX) && id.length > SSH_PREFIX.length ? id.slice(SSH_PREFIX.length) : null;
}

/** Window kind for an id, or null when the id is not a valid window id. */
export function kindOf(id: unknown): PaneWindowKind | null {
  if (typeof id !== "string") return null;
  if (sshEntryIdOf(id)) return "sftp";
  if (sshPaneEntryIdOf(id)) return "ssh";
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
  vnc: { w: 520, h: 340 },
  rest: { w: 520, h: 340 },
  sftp: { w: 460, h: 280 },
  ssh: { w: 460, h: 280 },
};

export const PANE_KIND_LABEL: Record<PaneWindowKind, string> = {
  local: "Local",
  remote: "Remote",
  vnc: "VNC",
  rest: "RestAPI",
  sftp: "SFTP",
  ssh: "SSH",
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
    // SFTP and SSH windows are never restored (they are bound to a live SSH entry), so only singleton kinds are accepted.
    // A window id from an older version (e.g. the removed shared "terminal" window) is not a valid id and is dropped here.
    if (kindOf(id) === null || isEntryWindow(id) || windows.some((existing) => existing.id === id)) continue;
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
  return JSON.stringify({ version: STORAGE_VERSION, windows: layout.windows.filter((win) => !isEntryWindow(win.id)) });
}

export function loadStoredLayout(storage: Pick<Storage, "getItem"> = localStorage): PaneLayout | null {
  try {
    const text = storage.getItem(STORAGE_KEY);
    return text ? normalizeStoredLayout(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}
