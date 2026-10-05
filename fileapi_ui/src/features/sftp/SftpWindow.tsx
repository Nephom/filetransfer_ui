import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { FileItem } from "../../file-item-contracts";
import type { SshProfile } from "./../ssh/ssh-contracts";
import { formatSize } from "../../format-utils";
import { PaneResizeHandle } from "../../resizable-pane";
import { PersistentScrollbar } from "../../ui/PersistentScrollbar";
import { CommandBarOverflowMenu } from "../../ui/CommandBarOverflowMenu";
import { SortAscIcon, SortDescIcon } from "../../ui/icons";
import { useCommandbarOverflow } from "../../pane/useCommandbarOverflow";
import {
  compareFileNames, isValidMoveTarget, joinSshPath, normalizeColumnWidths, readPersistedColumnWidths, sortFileItems, sshParentPath, updateTreeNode,
  type ColumnKey, type FolderNode, type LocalDirectory, type SortDirection, type SortKey, type UndoEntry,
} from "./file-list-utils";

/** Drag-and-drop state shared between the Local pane, the API Remote window and every SFTP window. */
export type SftpDndBridge = {
  dragItems: FileItem[];
  itemsRef: React.MutableRefObject<FileItem[]>;
  sourceRef: React.MutableRefObject<"local" | "remote" | "">;
  /** SSH entry of the SFTP window the current "remote" drag started in ("" = the API Remote window). */
  entryRef: React.MutableRefObject<string>;
  begin: (event: React.DragEvent, entryId: string, items: FileItem[], label: string) => void;
  finish: () => void;
  finishAfterDrop: () => void;
  isExternalFileDrag: (event: React.DragEvent) => boolean;
  notifyExternalFileDrag: (event: React.DragEvent) => boolean;
  /** Tells the user that SFTP <-> other-remote transfers must go through a manual download + upload. */
  showCrossWindowNotice: () => void;
};

/** Transfer queue entry points that live in main.tsx (they need the LOCAL pane state). */
export type SftpTransferBridge = {
  uploadPaths: (entryId: string, paths: string[], destination: string) => void;
  uploadLocalItems: (entryId: string, items: FileItem[], destination: string) => void;
  downloadToLocal: (entryId: string, items: FileItem[]) => void;
};

export type SftpWindowProps = {
  entryId: string;
  /** Resolved from the Workspace Manager on every render; undefined when the entry was removed. */
  profile: SshProfile | undefined;
  writeOperationLog: (operation: string, status: string, sourceLabel: string, destinationLabel: string, detail: string, level?: "DEBUG" | "INFO" | "WARN" | "ERROR") => void;
  describeError: (error: unknown) => string;
  requestName: (title: string, value: string) => Promise<string | null>;
  requestConfirmation: (message: string, title?: string) => Promise<boolean>;
  confirmDelete: boolean;
  folderResizeEnabled: boolean;
  undoEnabled: boolean;
  undoEntries: UndoEntry[];
  recordUndo: (entry: Omit<UndoEntry, "id">) => void;
  removeUndo: (id: string) => void;
  dnd: SftpDndBridge;
  transfer: SftpTransferBridge;
  /** Registers the function the transfer queue calls once a transfer into `folder` finished. */
  registerRefresh: (entryId: string, refresh: ((folder: string) => void) | null) => void;
  onPathChange: (entryId: string, path: string) => void;
};

const ROOT = "/";
const MISSING_PROFILE = "The SSH connection for this remote view is no longer available.";

const isZipFile = (item: FileItem) => !item.isDirectory && /\.zip$/i.test(item.name);

export function SftpWindow({
  entryId, profile, writeOperationLog, describeError, requestName, requestConfirmation, confirmDelete, folderResizeEnabled,
  undoEnabled, undoEntries, recordUndo, removeUndo, dnd, transfer, registerRefresh, onPathChange,
}: SftpWindowProps) {
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const sourceName = profile ? `SSH: ${profile.name}` : "SSH";

  const [files, setFiles] = useState<FileItem[]>([]);
  const [path, setPath] = useState(ROOT);
  const pathRef = useRef(path);
  pathRef.current = path;
  const [selected, setSelected] = useState<string[]>([]);
  const anchorRef = useRef<string | null>(null);
  const [tree, setTree] = useState<FolderNode>({ path: ROOT, name: "/", expanded: true, loaded: false, children: [] });
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [directoriesFirst, setDirectoriesFirst] = useState(false);
  const [viewMode, setViewMode] = useState<"details" | "grid">(() => (localStorage.getItem("file-view-mode") === "grid" ? "grid" : "details"));
  const [columnWidths, setColumnWidths] = useState<Record<ColumnKey, number>>(() => normalizeColumnWidths(readPersistedColumnWidths()));
  const [folderPaneWidth, setFolderPaneWidth] = useState(() => Number(localStorage.getItem("fileapi-folder-pane-width")) || 250);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<number | undefined>(undefined);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [paneHover, setPaneHover] = useState(false);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const marqueeRef = useRef<{ startX: number; startY: number; additive: boolean; base: string[]; container: HTMLElement } | null>(null);
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({ visibility: "hidden" });

  const rootRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const fileAreaRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const paneResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const columnResizeRef = useRef<{ key: ColumnKey; startX: number; startWidth: number } | null>(null);
  const dragExpandTimer = useRef<number | undefined>(undefined);
  const dragScrollInterval = useRef<number | null>(null);
  const mountedRef = useRef(true);
  // Generation counters: a late reply from a previous navigation / tree request is dropped.
  const listGeneration = useRef(0);
  const treeGeneration = useRef(0);
  const treeRequests = useRef(new Map<string, number>());
  const bar = useCommandbarOverflow();

  const sortedFiles = sortFileItems(files, sortKey, sortDirection, directoriesFirst);
  const selectedItems = files.filter((file) => selected.includes(file.path));
  const showUp = path !== ROOT;
  const parentFolder = sshParentPath(path);
  const undoCandidates = undoEntries.filter((entry) => entry.source === "ssh" && entry.entryId === entryId);
  const lastUndo = undoCandidates[undoCandidates.length - 1];

  const notify = (message: string, duration = 4000) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(message);
    if (duration > 0) noticeTimer.current = window.setTimeout(() => setNotice(""), duration);
  };

  // Each SFTP window has its own busy flag and notice, so a long operation in
  // one window never disables another window.
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice("");
    try {
      await action();
    } catch (error) {
      if (mountedRef.current) setNotice(describeError(error));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const requireProfile = () => {
    const current = profileRef.current;
    if (!current) throw new Error(MISSING_PROFILE);
    return current;
  };

  const loadFiles = async (nextPath: string) => {
    const sshProfile = requireProfile();
    const generation = ++listGeneration.current;
    const isCurrent = () => mountedRef.current && generation === listGeneration.current;
    const operationId = crypto.randomUUID();
    const started = performance.now();
    const source = `SSH: ${sshProfile.name}`;
    writeOperationLog("ssh_browse", "started", source, nextPath, JSON.stringify({ operationId, path: nextPath, sshEntryId: entryId }), "DEBUG");
    try {
      const data = await invoke<LocalDirectory>("ssh_list_directory", { profile: sshProfile, path: nextPath });
      if (!isCurrent()) return;
      setFiles(data.files || []);
      setPath(data.path || ROOT);
      anchorRef.current = null;
      setSelected([]);
      writeOperationLog("ssh_browse", "completed", source, data.path || nextPath, JSON.stringify({ operationId, path: data.path || nextPath, fileCount: data.files?.length || 0, durationMs: Math.round(performance.now() - started), sshEntryId: entryId }), "INFO");
    } catch (error) {
      if (!isCurrent()) return;
      writeOperationLog("ssh_browse", "failed", source, nextPath, JSON.stringify({ operationId, path: nextPath, durationMs: Math.round(performance.now() - started), failureType: "browse", errorMessage: describeError(error), sshEntryId: entryId }), "ERROR");
      throw error;
    }
  };

  const loadTreeChildren = async (treePath: string, force = false) => {
    const sshProfile = requireProfile();
    const generation = treeGeneration.current;
    const request = (treeRequests.current.get(treePath) || 0) + 1;
    treeRequests.current.set(treePath, request);
    const isCurrent = () => mountedRef.current && generation === treeGeneration.current && treeRequests.current.get(treePath) === request;
    try {
      const data = await invoke<LocalDirectory>("ssh_list_directory", { profile: sshProfile, path: treePath });
      if (!isCurrent()) return;
      const children = (data.files || [])
        .filter((file) => file.isDirectory)
        .map((file) => ({ path: file.path, name: file.name, expanded: false, loaded: false, children: [] as FolderNode[] }))
        .sort((left, right) => compareFileNames(left.name, right.name));
      setTree((current) => updateTreeNode(current, treePath, (node) => ({ ...node, expanded: true, loaded: true, children })));
    } catch (error) {
      if (isCurrent() && !force) throw error;
    }
  };

  const toggleFolder = (node: FolderNode) => {
    if (!node.expanded && !node.loaded) {
      void run(() => loadTreeChildren(node.path));
      return;
    }
    setTree((current) => updateTreeNode(current, node.path, (item) => ({ ...item, expanded: !item.expanded })));
  };

  const scheduleTreeExpand = (node: FolderNode) => {
    if (node.expanded) return;
    window.clearTimeout(dragExpandTimer.current);
    dragExpandTimer.current = window.setTimeout(() => toggleFolder(node), 650);
  };

  // First listing, window-lifetime bookkeeping and the SFTP connection release.
  useEffect(() => {
    mountedRef.current = true;
    void run(async () => {
      await Promise.all([loadFiles(ROOT), loadTreeChildren(ROOT, true)]);
    });
    return () => {
      mountedRef.current = false;
      listGeneration.current++;
      treeGeneration.current++;
      window.clearTimeout(noticeTimer.current);
      window.clearTimeout(dragExpandTimer.current);
      if (dragScrollInterval.current !== null) window.clearInterval(dragScrollInterval.current);
      void invoke("ssh_sftp_disconnect", { entryId }).catch(() => undefined);
    };
  }, [entryId]);

  // Transfers finished by the queue refresh this window when they touched the folder it shows.
  const refreshForTransfer = (folder: string) => {
    if (folder !== pathRef.current) return;
    void loadFiles(pathRef.current).catch(() => undefined);
  };
  const refreshForTransferRef = useRef(refreshForTransfer);
  refreshForTransferRef.current = refreshForTransfer;
  useEffect(() => {
    registerRefresh(entryId, (folder) => refreshForTransferRef.current(folder));
    return () => registerRefresh(entryId, null);
  }, [entryId]);

  useEffect(() => { onPathChange(entryId, path); }, [entryId, path]);
  useEffect(() => { localStorage.setItem("file-view-mode", viewMode); }, [viewMode]);
  useEffect(() => { localStorage.setItem("fileapi-folder-pane-width", String(folderPaneWidth)); }, [folderPaneWidth]);
  useEffect(() => { localStorage.setItem("fileapi-column-widths", JSON.stringify(columnWidths)); }, [columnWidths]);

  // ---- selection --------------------------------------------------------
  const toggle = (file: FileItem, checked: boolean) => {
    anchorRef.current = file.path;
    setSelected((current) => (checked ? [...new Set([...current, file.path])] : current.filter((value) => value !== file.path)));
  };

  const selectFile = (file: FileItem, event: React.MouseEvent) => {
    const index = sortedFiles.findIndex((item) => item.path === file.path);
    const anchorIndex = anchorRef.current ? sortedFiles.findIndex((item) => item.path === anchorRef.current) : -1;
    if (event.shiftKey && anchorIndex >= 0 && index >= 0) {
      const start = Math.min(anchorIndex, index);
      const end = Math.max(anchorIndex, index);
      setSelected(sortedFiles.slice(start, end + 1).map((item) => item.path));
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      anchorRef.current = file.path;
      setSelected((current) => (current.includes(file.path) ? current.filter((value) => value !== file.path) : [...current, file.path]));
      return;
    }
    anchorRef.current = file.path;
    setSelected([file.path]);
  };

  const beginMarquee = (event: React.MouseEvent) => {
    const container = fileAreaRef.current;
    if (event.button !== 0 || !container) return;
    const target = event.target as HTMLElement;
    if (target.closest(".file-row, .file-tile, .file-table th, button, input, a, .column-resize-handle, .pane-resize-handle")) return;
    event.preventDefault();
    const additive = event.ctrlKey || event.metaKey;
    if (!additive) {
      anchorRef.current = null;
      setSelected([]);
    }
    marqueeRef.current = { startX: event.clientX, startY: event.clientY, additive, base: additive ? selected : [], container };
    setMarquee({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
  };

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      const state = marqueeRef.current;
      if (!state) return;
      const left = Math.min(state.startX, event.clientX);
      const top = Math.min(state.startY, event.clientY);
      const right = Math.max(state.startX, event.clientX);
      const bottom = Math.max(state.startY, event.clientY);
      setMarquee({ left, top, width: right - left, height: bottom - top });
      const hit: string[] = [];
      state.container.querySelectorAll<HTMLElement>("[data-path]").forEach((node) => {
        const nodePath = node.getAttribute("data-path");
        const box = node.getBoundingClientRect();
        if (nodePath && box.left < right && box.right > left && box.top < bottom && box.bottom > top) hit.push(nodePath);
      });
      setSelected(state.additive ? [...new Set([...state.base, ...hit])] : hit);
    };
    const handleUp = () => {
      if (!marqueeRef.current) return;
      marqueeRef.current = null;
      setMarquee(null);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  // ---- column / folder-pane resizing ------------------------------------
  const stopPaneResize = () => { paneResizeRef.current = null; };
  const resizePane = (event: PointerEvent | React.PointerEvent) => {
    const start = paneResizeRef.current;
    if (!start) return;
    const available = rootRef.current?.clientWidth || window.innerWidth;
    const maxWidth = Math.max(220, Math.min(720, available - 240));
    setFolderPaneWidth(Math.max(180, Math.min(maxWidth, start.startWidth + (event.clientX - start.startX))));
  };
  const beginPaneResize = (event: React.PointerEvent<HTMLDivElement>) => {
    paneResizeRef.current = { startX: event.clientX, startWidth: folderPaneWidth };
  };

  const resizeColumn = (event: PointerEvent) => {
    const start = columnResizeRef.current;
    const area = fileAreaRef.current;
    if (!start || !area) return;
    const delta = ((event.clientX - start.startX) / area.clientWidth) * 100;
    const next = Math.max(12, Math.min(70, start.startWidth + delta));
    setColumnWidths((current) => {
      const otherTotal = Object.entries(current).filter(([key]) => key !== start.key).reduce((total, [, width]) => total + width, 0);
      if (next + otherTotal > 96) return current;
      return { ...current, [start.key]: next };
    });
  };
  const stopColumnResize = () => {
    columnResizeRef.current = null;
    window.removeEventListener("pointermove", resizeColumn);
    window.removeEventListener("pointerup", stopColumnResize);
  };
  const beginColumnResize = (key: ColumnKey, event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    columnResizeRef.current = { key, startX: event.clientX, startWidth: columnWidths[key] };
    window.addEventListener("pointermove", resizeColumn);
    window.addEventListener("pointerup", stopColumnResize);
  };

  const toggleSort = (column: ColumnKey) => {
    if (sortKey === column) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(column);
    setSortDirection("asc");
  };

  // ---- operations -------------------------------------------------------
  const refresh = () => loadFiles(path);

  const createFolder = () => run(async () => {
    const sshProfile = requireProfile();
    const folderName = await requestName("New folder", "");
    if (!folderName?.trim()) return;
    const name = folderName.trim();
    if (/[\\/]/.test(name) || name === "." || name === "..") throw new Error("Enter a folder name, not a path.");
    const fullPath = joinSshPath(path, name);
    try {
      await invoke("ssh_create_directory", { profile: sshProfile, path: fullPath });
      await loadFiles(path);
      writeOperationLog("create_folder", "completed", `SSH: ${sshProfile.name}:${path}`, `SSH: ${sshProfile.name}:${fullPath}`, `Created folder ${name} through SFTP.`);
      notify(`Created ${name}.`);
    } catch (error) {
      writeOperationLog("create_folder", "failed", `SSH: ${sshProfile.name}:${path}`, `SSH: ${sshProfile.name}:${fullPath}`, `Failed to create folder ${name} through SFTP: ${describeError(error)}`, "ERROR");
      throw error;
    }
  });

  const rename = () => run(async () => {
    const sshProfile = requireProfile();
    if (selectedItems.length !== 1) return;
    const item = selectedItems[0];
    const newName = await requestName("Rename", item.name);
    if (!newName?.trim() || newName === item.name) return;
    const trimmedName = newName.trim();
    if (/[\\/]/.test(trimmedName) || trimmedName === "." || trimmedName === "..") throw new Error("Enter a filename, not a path.");
    const newPath = joinSshPath(sshParentPath(item.path), trimmedName);
    try {
      const finalPath = await invoke<string>("ssh_rename_path", { profile: sshProfile, oldPath: item.path, newPath });
      if (undoEnabled) {
        recordUndo({ source: "ssh", entryId, oldPath: item.path, newPath: finalPath, description: `Rename ${finalPath.split("/").pop()} back to ${item.path.split("/").pop()}` });
      }
      await loadFiles(path);
      writeOperationLog("rename", "completed", `SSH: ${sshProfile.name}:${item.path}`, `SSH: ${sshProfile.name}:${finalPath}`, `Renamed ${item.name} to ${finalPath.split("/").pop()} through SFTP.`);
      notify(`Renamed ${item.name} to ${finalPath.split("/").pop()}.`);
    } catch (error) {
      writeOperationLog("rename", "failed", `SSH: ${sshProfile.name}:${item.path}`, `SSH: ${sshProfile.name}:${newPath}`, `Failed to rename ${item.name} through SFTP: ${describeError(error)}`, "ERROR");
      throw error;
    }
  });

  const remove = () => run(async () => {
    const sshProfile = requireProfile();
    if (!selectedItems.length) return;
    if (confirmDelete && !await requestConfirmation(`Delete ${selectedItems.length} selected item${selectedItems.length === 1 ? "" : "s"}? This cannot be undone.`, "Delete remote items")) return;
    const sourceLabel = `${selectedItems.length} selected item${selectedItems.length === 1 ? "" : "s"}`;
    const destinationLabel = `SSH: ${sshProfile.name}:${path}`;
    try {
      for (const item of selectedItems) {
        await invoke("ssh_delete_path", { profile: sshProfile, path: item.path, isDirectory: item.isDirectory });
      }
      await loadFiles(path);
      writeOperationLog("delete", "completed", sourceLabel, destinationLabel, "Deleted through SFTP. This cannot be undone.");
      notify("Deleted selected items. This cannot be undone.");
    } catch (error) {
      writeOperationLog("delete", "failed", sourceLabel, destinationLabel, `Failed to delete through SFTP: ${describeError(error)}`, "ERROR");
      throw error;
    }
  });

  const moveItems = (items: FileItem[], destination: string) => run(async () => {
    const sshProfile = requireProfile();
    writeOperationLog("drag", "dropped", `SSH: ${sshProfile.name}`, destination, JSON.stringify({ itemCount: items.length, sourceType: "SFTP", destinationType: "SFTP" }), "INFO");
    if (!isValidMoveTarget(items, destination)) {
      throw new Error("Choose a folder other than the current folder or a folder inside a selected folder.");
    }
    const sourceLabel = `${items.length} item${items.length === 1 ? "" : "s"}`;
    const destinationLabel = `SSH: ${sshProfile.name}:${destination}`;
    try {
      for (const item of items) {
        const newPath = joinSshPath(destination, item.name);
        const finalPath = await invoke<string>("ssh_rename_path", { profile: sshProfile, oldPath: item.path, newPath });
        if (undoEnabled) recordUndo({ source: "ssh", entryId, oldPath: item.path, newPath: finalPath, description: `Move ${finalPath} back to ${item.path}` });
      }
      setMenuPoint(null);
      await loadFiles(path);
      writeOperationLog("move", "completed", sourceLabel, destinationLabel, `Moved ${items.length} item(s) through SFTP.`);
      notify(`Moved ${items.length} item${items.length === 1 ? "" : "s"}.`);
    } catch (error) {
      writeOperationLog("move", "failed", sourceLabel, destinationLabel, `Failed to move through SFTP: ${describeError(error)}`, "ERROR");
      throw error;
    }
  });

  const undo = () => run(async () => {
    const sshProfile = requireProfile();
    const entry = lastUndo;
    if (!entry) return;
    const sourceLabel = `SSH: ${entry.newPath}`;
    const destinationLabel = `SSH: ${entry.oldPath}`;
    try {
      await invoke("ssh_rename_path", { profile: sshProfile, oldPath: entry.newPath, newPath: entry.oldPath });
      removeUndo(entry.id);
      await loadFiles(path);
      writeOperationLog("undo", "completed", sourceLabel, destinationLabel, `Undone: ${entry.description}`);
      notify(`Undone: ${entry.description}`);
    } catch (error) {
      writeOperationLog("undo", "failed", sourceLabel, destinationLabel, `Failed to undo "${entry.description}": ${describeError(error)}`, "ERROR");
      throw error;
    }
  });

  const compress = () => run(async () => {
    const sshProfile = requireProfile();
    if (!selectedItems.length) return;
    const defaultName = selectedItems.length === 1 ? selectedItems[0].name.replace(/\.[^./]+$/, "") : "Archive";
    const archiveName = await requestName("Archive name", defaultName);
    if (!archiveName?.trim()) return;
    const sourceLabel = `${selectedItems.length} selected item${selectedItems.length === 1 ? "" : "s"}`;
    const destinationLabel = `SSH: ${sshProfile.name}:${path}`;
    try {
      const finalName = await invoke<string>("ssh_compress_paths", {
        profile: sshProfile,
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

  const extract = () => run(async () => {
    const sshProfile = requireProfile();
    if (selectedItems.length !== 1) return;
    const item = selectedItems[0];
    const sourceLabel = `SSH: ${sshProfile.name}:${item.path}`;
    const destinationLabel = `SSH: ${sshProfile.name}:${path}`;
    try {
      const finalName = await invoke<string>("ssh_extract_archive", { profile: sshProfile, path: item.path, destinationFolder: path });
      await loadFiles(path);
      writeOperationLog("extract", "completed", sourceLabel, destinationLabel, `Extracted ${item.name} to ${finalName} through SFTP.`);
      notify(`Extracted to ${finalName}.`);
    } catch (error) {
      writeOperationLog("extract", "failed", sourceLabel, destinationLabel, `Failed to extract ${item.name} through SFTP: ${describeError(error)}`, "ERROR");
      throw error;
    }
  });

  const pickAndUpload = async () => {
    try {
      const paths = await invoke<string[]>("pick_upload_files");
      if (!paths.length) {
        writeOperationLog("upload", "cancelled", "LOCAL", `${sourceName}:${path}`, "Upload file picker was cancelled or returned no files.", "INFO");
        return;
      }
      transfer.uploadPaths(entryId, paths, path);
    } catch (error) {
      const detail = `Unable to choose upload files: ${describeError(error)}`;
      writeOperationLog("upload", "failed", "LOCAL", `${sourceName}:${path}`, detail, "ERROR");
      notify(detail);
    }
  };

  const download = () => {
    if (!selectedItems.length) return;
    transfer.downloadToLocal(entryId, selectedItems);
  };

  // ---- drag and drop ----------------------------------------------------
  const stopDragAutoScroll = () => {
    if (dragScrollInterval.current !== null) {
      window.clearInterval(dragScrollInterval.current);
      dragScrollInterval.current = null;
    }
  };
  const handleDragAutoScroll = (event: React.DragEvent, container: HTMLElement | null) => {
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const threshold = 48;
    const fromTop = event.clientY - rect.top;
    const fromBottom = rect.bottom - event.clientY;
    stopDragAutoScroll();
    if (fromTop >= 0 && fromTop < threshold) {
      const speed = Math.max(2, (threshold - fromTop) / 2);
      dragScrollInterval.current = window.setInterval(() => { container.scrollTop -= speed; }, 16);
    } else if (fromBottom >= 0 && fromBottom < threshold) {
      const speed = Math.max(2, (threshold - fromBottom) / 2);
      dragScrollInterval.current = window.setInterval(() => { container.scrollTop += speed; }, 16);
    }
  };

  const beginDrag = (event: React.DragEvent, file: FileItem) => {
    const items = selected.includes(file.path) ? selectedItems : [file];
    if (!selected.includes(file.path)) setSelected([file.path]);
    dnd.begin(event, entryId, items, file.path);
  };

  /** Whether the current drag may be released on `destination` (also true for other windows' drags so the drop can explain why it is refused). */
  const acceptsDrop = (destination: string) => {
    const source = dnd.sourceRef.current;
    const items = dnd.itemsRef.current;
    if (!items.length) return false;
    if (source === "local") return true;
    if (source === "remote") return dnd.entryRef.current === entryId ? isValidMoveTarget(items, destination) : true;
    return false;
  };

  const dropOn = (destination: string) => {
    const source = dnd.sourceRef.current;
    const items = dnd.itemsRef.current;
    const fromEntry = dnd.entryRef.current;
    dnd.finish();
    setDropTarget(null);
    setPaneHover(false);
    if (source === "local") transfer.uploadLocalItems(entryId, items, destination);
    else if (source === "remote" && fromEntry === entryId) void moveItems(items, destination);
    else if (source === "remote") dnd.showCrossWindowNotice();
  };

  const endDrag = () => {
    setDropTarget(null);
    setPaneHover(false);
    dnd.finishAfterDrop();
  };

  // ---- context menu -----------------------------------------------------
  const openMenu = (event: React.MouseEvent, file: FileItem) => {
    event.preventDefault();
    if (!selected.includes(file.path)) setSelected([file.path]);
    setMenuStyle({ visibility: "hidden" });
    setMenuPoint({ x: event.clientX, y: event.clientY });
  };

  useEffect(() => {
    if (!menuPoint) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      const edge = 8;
      setMenuStyle({
        left: Math.max(edge, Math.min(menuPoint.x, window.innerWidth - rect.width - edge)),
        top: Math.max(edge, Math.min(menuPoint.y, window.innerHeight - rect.height - edge)),
        maxHeight: window.innerHeight - edge * 2,
        visibility: "visible",
      });
    });
    const dismiss = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenuPoint(null);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuPoint(null); };
    window.addEventListener("mousedown", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("mousedown", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuPoint]);

  const menuHost = menuPoint ? rootRef.current?.closest<HTMLElement>(".explorer") || document.body : null;
  const closeMenuThen = (action: () => unknown) => () => { setMenuPoint(null); void action(); };

  // ---- rendering --------------------------------------------------------
  const renderTreeNode = (node: FolderNode): React.ReactNode => (
    <div className="folder-tree" key={node.path}>
      <div
        className={`tree-node ${path === node.path ? "active" : ""} ${dropTarget === node.path ? "drop-target" : ""}`}
        onDragOver={(event) => {
          if (acceptsDrop(node.path)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = dnd.sourceRef.current === "local" ? "copy" : "move";
            setDropTarget(node.path);
            scheduleTreeExpand(node);
            handleDragAutoScroll(event, treeRef.current);
          }
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDropTarget(null);
          window.clearTimeout(dragExpandTimer.current);
        }}
        onDropCapture={(event) => {
          event.preventDefault();
          event.stopPropagation();
          stopDragAutoScroll();
          dropOn(node.path);
        }}
      >
        <button className="tree-toggle" aria-label={`${node.expanded ? "Collapse" : "Expand"} ${node.name}`} onClick={() => toggleFolder(node)}>
          {node.expanded ? "−" : "+"}
        </button>
        <button className="tree-folder" onClick={() => void run(() => loadFiles(node.path))}>
          <span className="folder-mini" />
          {node.name}
        </button>
        {dnd.dragItems.length > 0 && dropTarget === node.path && (
          <span className="drop-label">{dnd.sourceRef.current === "local" ? "Upload here" : "Move here"}</span>
        )}
      </div>
      {node.expanded && (
        <div className="tree-children">
          {node.loaded ? node.children.map(renderTreeNode) : <span className="tree-loading">Loading folders...</span>}
        </div>
      )}
    </div>
  );

  const parts = path.split("/").filter(Boolean);
  const breadcrumbs = (
    <div className="pane-breadcrumbs crumbs" aria-label="SFTP path">
      <button onClick={() => void run(() => loadFiles(ROOT))}>/</button>
      {parts.map((part, index) => (
        <React.Fragment key={`sftp-crumb-${part}-${index}`}>
          <span className="crumb-separator">›</span>
          <button onClick={() => void run(() => loadFiles(`/${parts.slice(0, index + 1).join("/")}`))}>{part}</button>
        </React.Fragment>
      ))}
    </div>
  );

  const rowDropProps = (destination: string, enabled: boolean) => ({
    onDragOver: (event: React.DragEvent) => {
      if (enabled && acceptsDrop(destination)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = dnd.sourceRef.current === "local" ? "copy" : "move";
        setDropTarget(destination);
      }
    },
    onDrop: (event: React.DragEvent) => {
      if (!enabled) return;
      event.preventDefault();
      event.stopPropagation();
      dropOn(destination);
    },
  });

  const openFile = (file: FileItem) => {
    if (file.isDirectory) void run(() => loadFiles(file.path));
    else transfer.downloadToLocal(entryId, [file]);
  };

  const selectAll = () => setSelected(selected.length === files.length ? [] : sortedFiles.map((file) => file.path));
  const noProfile = !profile;

  const overflowActions = [
    { key: "new-folder", label: "New folder", disabled: busy || noProfile, onClick: () => void createFolder() },
    { key: "download", label: "Download", disabled: busy || !selectedItems.length, title: "Bring the selection into the current LOCAL folder", onClick: download },
    { key: "rename", label: "Rename", disabled: busy || selectedItems.length !== 1, onClick: () => void rename() },
    { key: "delete", label: "Delete", disabled: busy || !selectedItems.length, onClick: () => void remove() },
    { key: "undo", label: "Undo", disabled: busy || !lastUndo, title: lastUndo ? `Undo: ${lastUndo.description}` : "No operation to undo", onClick: () => void undo() },
    { key: "select-all", label: "Select all", onClick: selectAll },
    { key: "refresh", label: "Refresh", disabled: busy || noProfile, onClick: () => void run(refresh) },
  ];

  const fileArea = (
    <div
      id={`files-${entryId}`}
      ref={fileAreaRef}
      className={`file-area ${paneHover && dnd.sourceRef.current === "local" ? "drop-target" : ""}`}
      onDragEnter={(event) => {
        if (dnd.notifyExternalFileDrag(event)) return;
        setPaneHover(true);
      }}
      onDragOver={(event) => {
        handleDragAutoScroll(event, fileAreaRef.current);
        if (dnd.notifyExternalFileDrag(event)) return;
        if (acceptsDrop(path)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = dnd.sourceRef.current === "local" ? "copy" : "move";
        }
      }}
      onDragLeave={(event) => {
        stopDragAutoScroll();
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setPaneHover(false);
      }}
      onMouseDown={beginMarquee}
      onDropCapture={(event) => {
        stopDragAutoScroll();
        if (dnd.isExternalFileDrag(event)) {
          event.preventDefault();
          event.stopPropagation();
          dnd.notifyExternalFileDrag(event);
          return;
        }
        // Rows / folders handle their own drops (they stop propagation); this is a drop on empty space.
        const source = dnd.sourceRef.current;
        if (source === "local" || (source === "remote" && dnd.entryRef.current !== entryId)) {
          event.preventDefault();
          event.stopPropagation();
          dropOn(path);
        }
      }}
    >
      {viewMode === "grid" ? (
        <div className="file-grid">
          {showUp && (
            <article
              className={`file-tile file-tile-dotdot ${dropTarget === parentFolder ? "drop-target" : ""}`}
              {...rowDropProps(parentFolder, true)}
              onClick={() => void run(() => loadFiles(parentFolder))}
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
              onDragStart={(event) => beginDrag(event, file)}
              onDragEnd={endDrag}
              {...rowDropProps(file.path, file.isDirectory)}
              onClick={(event) => selectFile(file, event)}
              onDoubleClick={() => openFile(file)}
              onContextMenu={(event) => openMenu(event, file)}
            >
              <span className="tile-icon">
                <span className={file.isDirectory ? "glyph-folder" : "glyph-file"} aria-hidden="true" />
              </span>
              <strong>{file.name}</strong>
              <span>{file.isDirectory ? "File folder" : "File"}</span>
              <small>{file.isDirectory ? "Drop files here" : formatSize(file.size)}</small>
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
                  className={`resizable-column sortable-column${sortKey === column ? " active" : ""}`}
                  aria-sort={sortKey === column ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
                >
                  {column === "name" && (
                    <button
                      type="button"
                      className={`directory-first-toggle${directoriesFirst ? " active" : ""}`}
                      aria-label="Keep folders first"
                      aria-pressed={directoriesFirst}
                      title={directoriesFirst ? "Folders first: on" : "Folders first: off"}
                      onClick={() => setDirectoriesFirst((current) => !current)}
                    >
                      <span aria-hidden="true" />
                    </button>
                  )}
                  <button type="button" onClick={() => toggleSort(column)} aria-label={`Sort by ${column}`}>
                    <span>{column[0].toUpperCase() + column.slice(1)}</span>
                    {sortKey === column && (
                      <span className="sort-indicator" aria-hidden="true">
                        {sortDirection === "asc" ? <SortAscIcon size={11} /> : <SortDescIcon size={11} />}
                      </span>
                    )}
                  </button>
                  <span className="column-resize-handle" onPointerDown={(event) => beginColumnResize(column, event)} role="separator" aria-label={`Resize ${column} column`} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {showUp && (
              <tr
                className={`file-row file-row-dotdot ${dropTarget === parentFolder ? "drop-target" : ""}`}
                {...rowDropProps(parentFolder, true)}
                onClick={() => void run(() => loadFiles(parentFolder))}
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
                onDragStart={(event) => beginDrag(event, file)}
                onDragEnd={endDrag}
                {...rowDropProps(file.path, file.isDirectory)}
                onClick={(event) => selectFile(file, event)}
                onDoubleClick={() => openFile(file)}
                onContextMenu={(event) => openMenu(event, file)}
              >
                <td>
                  <input
                    aria-label={`Select ${file.name}`}
                    type="checkbox"
                    checked={selected.includes(file.path)}
                    onChange={(event) => toggle(file, event.target.checked)}
                    onClick={(event) => event.stopPropagation()}
                  />
                </td>
                <td>
                  <span className="file-name">
                    <span className={file.isDirectory ? "glyph-folder" : "glyph-file"} aria-hidden="true" /> {file.name}
                  </span>
                </td>
                <td className="muted">{file.modified ? new Date(file.modified).toLocaleString() : "--"}</td>
                <td className="muted">{file.isDirectory ? "--" : formatSize(file.size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  return (
    <div className="pane-window-content sftp-window" ref={rootRef}>
      <nav ref={bar.setRef} className="commandbar" aria-label="SFTP file actions">
        <button className="primary" onClick={() => void pickAndUpload()} disabled={busy || noProfile} title="Choose local files to upload into the current folder">
          Upload
        </button>
        {!bar.overflow && <>
          <button onClick={() => void createFolder()} disabled={busy || noProfile}>New folder</button>
          <span className="divider" />
          <button disabled={busy || !selectedItems.length} onClick={download} title="Bring the selection into the current LOCAL folder">Download</button>
        </>}
        {bar.overflow ? (
          <CommandBarOverflowMenu label="More actions" actions={overflowActions} />
        ) : (
          <>
            <button disabled={busy || selectedItems.length !== 1} onClick={() => void rename()}>Rename</button>
            <button disabled={busy || !selectedItems.length} onClick={() => void remove()}>Delete</button>
            <button disabled={busy || !lastUndo} onClick={() => void undo()} title={lastUndo ? `Undo: ${lastUndo.description}` : "No operation to undo"}>Undo</button>
            <span className="divider" />
            <button onClick={selectAll}>Select all</button>
          </>
        )}
        <span className="view-switch">
          <button className={viewMode === "details" ? "active" : ""} onClick={() => setViewMode("details")}>Details</button>
          <button className={viewMode === "grid" ? "active" : ""} onClick={() => setViewMode("grid")}>Grid</button>
        </span>
        {!bar.overflow && <button onClick={() => void run(refresh)} disabled={busy || noProfile}>Refresh</button>}
      </nav>
      <div className="desktop-workspace pane-remote-workspace">
        <aside className="desktop-folder-tree" style={{ flexBasis: `${folderPaneWidth}px`, width: `${folderPaneWidth}px` }}>
          <span className="sidebar-label">Folders</span>
          <div className="folder-pane">
            <div
              id={`folders-${entryId}`}
              ref={treeRef}
              className="folder-tree-scroll"
              onDragOver={(event) => handleDragAutoScroll(event, treeRef.current)}
              onDragLeave={stopDragAutoScroll}
              onDrop={stopDragAutoScroll}
            >
              {renderTreeNode(tree)}
            </div>
            <PersistentScrollbar targetRef={treeRef} label="Folders" />
          </div>
        </aside>
        {folderResizeEnabled && (
          <PaneResizeHandle ariaLabel="Resize Folders and SFTP panes" onStart={beginPaneResize} onMove={(event) => resizePane(event.nativeEvent)} onEnd={stopPaneResize} />
        )}
        <section className="desktop-content active-pane">
          <div className="content-heading">
            <div>
              <span className="eyebrow">{`REMOTE (${sourceName})`}</span>
              <div className="remote-navigation-row">{breadcrumbs}</div>
            </div>
          </div>
          <div className="remote-status-row" aria-label="SFTP status">
            <span className="selection-count" aria-live="polite">{selectedItems.length > 0 ? `${selectedItems.length} selected` : ""}</span>
            {notice && (
              <output className="notice transfer-notice" role="status" title={notice}>{notice}</output>
            )}
          </div>
          <div className="file-pane">
            {fileArea}
            <PersistentScrollbar targetRef={fileAreaRef} label="Files" />
          </div>
        </section>
      </div>
      <footer className="statusbar">
        <span>{files.length} item{files.length === 1 ? "" : "s"}</span>
        <span>{path}</span>
      </footer>
      {marquee && (
        <div className="marquee-select" style={{ position: "fixed", left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height, pointerEvents: "none", zIndex: 9999 }} />
      )}
      {menuPoint && menuHost && createPortal(
        <div ref={menuRef} className="context-menu" role="menu" aria-label="SFTP file actions" style={menuStyle} onClick={(event) => event.stopPropagation()}>
          <button disabled={!selectedItems.length} onClick={closeMenuThen(download)}>Download</button>
          <button disabled={selectedItems.length !== 1} onClick={closeMenuThen(rename)}>Rename</button>
          <hr />
          <button disabled={!selectedItems.length} onClick={closeMenuThen(compress)}>Compress to .zip</button>
          <button disabled={selectedItems.length !== 1 || !isZipFile(selectedItems[0])} onClick={closeMenuThen(extract)}>Extract here</button>
          <hr />
          <button disabled={!selectedItems.length} onClick={closeMenuThen(remove)}>Delete</button>
        </div>,
        menuHost,
      )}
    </div>
  );
}
