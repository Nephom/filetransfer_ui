import type { FileItem } from "../../file-item-contracts";

// File-list types and pure helpers shared by the main Location windows
// (main.tsx) and the per-entry SFTP windows (SftpWindow.tsx).

export type FolderNode = {
  path: string;
  name: string;
  expanded: boolean;
  loaded: boolean;
  children: FolderNode[];
};
export type LocalDirectory = {
  path: string;
  files: FileItem[];
};
export type ColumnKey = "name" | "modified" | "size";
export type SortKey = ColumnKey;
export type SortDirection = "asc" | "desc";

/** One reversible rename/move, recorded by the Location windows and the SFTP windows. */
export type UndoEntry = {
  id: string;
  description: string;
  source: "api" | "ssh" | "local";
  locationId?: string;
  context?: string;
  /** SSH entry id for `source: "ssh"` (the SFTP window the operation happened in). */
  entryId?: string;
  oldPath: string;
  newPath: string;
};

export const sshParentPath = (path: string) => {
  const segments = path.split("/").filter(Boolean);
  return segments.length > 1 ? `/${segments.slice(0, -1).join("/")}` : "/";
};
export const joinSshPath = (directory: string, name: string) =>
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
export const compareFileNames = (left: string, right: string) =>
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
export const sortFileItems = (
  items: FileItem[],
  sortKey: SortKey,
  direction: SortDirection,
  directoriesFirst = false,
) => [...items].sort((left, right) =>
  compareFileItems(left, right, sortKey, direction, directoriesFirst));

/** Replace the node at `targetPath` (searching the whole tree) with `update(node)`. */
export const updateTreeNode = (
  node: FolderNode,
  targetPath: string,
  update: (node: FolderNode) => FolderNode,
): FolderNode =>
  node.path === targetPath
    ? update(node)
    : {
        ...node,
        children: node.children.map((child) => updateTreeNode(child, targetPath, update)),
      };

/**
 * True when every item can move into `destination`: not into the folder it is
 * already in, and (for folders) not into itself or one of its descendants.
 */
export const isValidMoveTarget = (items: FileItem[], destination: string) =>
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

// The file table renders each column's width as a literal percent. These
// helpers read the persisted widths and rescale them so the three columns
// always sum to exactly 100 (see main.tsx history for T-210).
export const readPersistedColumnWidths = (): Record<ColumnKey, number> => {
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
export const normalizeColumnWidths = (widths: Record<ColumnKey, number>): Record<ColumnKey, number> => {
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
