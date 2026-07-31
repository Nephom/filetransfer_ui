import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";
import "./tls.css";
import "./webui-shell.css";
import "./explorer-parity.css";

type FileItem = { name: string; path: string; isDirectory: boolean; size: number; modified: number };
type Session = { host: string; port: string; token: string; username: string; userId: number | null; role: string; permissions: string[]; ignoreTlsErrors: boolean };
type ShareResponse = { data?: { fullUrl?: string; shareUrl?: string } };
type NativeApiResponse = { status: number; body: number[] };
type FolderNode = { path: string; name: string; expanded: boolean; loaded: boolean; children: FolderNode[] };

const defaultHost = import.meta.env.VITE_DEFAULT_SERVER_HOST || "";
const defaultPort = import.meta.env.VITE_DEFAULT_SERVER_PORT || "9443";
const initialSession: Session = { host: defaultHost, port: defaultPort, token: "", username: "", userId: null, role: "", permissions: [], ignoreTlsErrors: false };

const readError = async (response: { status: number; text: () => Promise<string> }) => {
  const body = await response.text();
  try {
    const data = JSON.parse(body);
    return data.error?.message || data.error || data.message || `HTTP ${response.status}`;
  } catch {
    return body || `HTTP ${response.status}`;
  }
};

const parentPath = (path: string) => path.split("/").filter(Boolean).slice(0, -1).join("/");
const downloadPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const formatSize = (size: number) => size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`;
const serverUrl = (session: Session) => `https://${session.host.trim()}:${session.port.trim()}`;

class ApiResponse {
  readonly ok: boolean;
  private readonly bytes: Uint8Array;

  constructor(readonly status: number, body: number[]) {
    this.ok = status >= 200 && status < 300;
    this.bytes = new Uint8Array(body);
  }

  text = async () => new TextDecoder().decode(this.bytes);
  json = async () => JSON.parse(await this.text());
  arrayBuffer = async () => this.bytes.slice().buffer;
}

const validateServer = (session: Session) => {
  if (!/^[a-zA-Z0-9.-]+$/.test(session.host.trim())) throw new Error("Enter a server address without a protocol, path, or port.");
  const port = Number(session.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter an HTTPS port between 1 and 65535.");
};

function App() {
  const [session, setSession] = useState<Session>(initialSession);
  const [password, setPassword] = useState("");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [pathBeforeSearch, setPathBeforeSearch] = useState("");
  const [viewMode, setViewMode] = useState<"details" | "grid">(() => localStorage.getItem("file-view-mode") === "grid" ? "grid" : "details");
  const [folderTree, setFolderTree] = useState<FolderNode>({ path: "", name: "/", expanded: true, loaded: false, children: [] });
  const [dragItems, setDragItems] = useState<FileItem[]>([]);
  const [dropTarget, setDropTarget] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const accountControl = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("fileapi-desktop-session");
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<Session>;
        setSession(current => ({ ...current, ...parsed, host: parsed.host || defaultHost, port: parsed.port || defaultPort }));
      }
    } catch {
      setNotice("Unable to restore the saved desktop session.");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("fileapi-desktop-session", JSON.stringify(session));
  }, [session]);

  useEffect(() => {
    localStorage.setItem("file-view-mode", viewMode);
  }, [viewMode]);

  useEffect(() => {
    const closeAccountMenu = (event: MouseEvent) => {
      if (!accountControl.current?.contains(event.target as Node)) setAccountOpen(false);
    };
    window.addEventListener("click", closeAccountMenu);
    return () => window.removeEventListener("click", closeAccountMenu);
  }, []);

  const api = async (endpoint: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (session.token) headers.set("Authorization", `Bearer ${session.token}`);
    const body = init.body === undefined ? undefined : Array.from(new TextEncoder().encode(String(init.body)));
    const response = await invoke<NativeApiResponse>("api_request", {
      url: `${serverUrl(session)}${endpoint}`,
      method: init.method || "GET",
      headers: Array.from(headers.entries()),
      body,
      ignoreTlsErrors: session.ignoreTlsErrors
    });
    return new ApiResponse(response.status, response.body);
  };

  const loadFiles = async (nextPath = path) => {
    const response = await api(`/api/files?path=${encodeURIComponent(nextPath)}`);
    if (!response.ok) throw new Error(await readError(response));
    const data = await response.json();
    setFiles(data.files || []);
    setPath(data.currentPath || "");
    setSearching(false);
    setSelected([]);
  };

  const updateTreeNode = (node: FolderNode, targetPath: string, update: (node: FolderNode) => FolderNode): FolderNode => node.path === targetPath ? update(node) : { ...node, children: node.children.map(child => updateTreeNode(child, targetPath, update)) };

  const loadTreeChildren = async (treePath: string, force = false) => {
    const response = await api(`/api/files?path=${encodeURIComponent(treePath)}`);
    if (!response.ok) {
      if (!force) throw new Error(await readError(response));
      return;
    }
    const data = await response.json();
    const children = (data.files || []).filter((file: FileItem) => file.isDirectory).map((file: FileItem) => ({ path: file.path, name: file.name, expanded: false, loaded: false, children: [] })).sort((left: FolderNode, right: FolderNode) => left.name.localeCompare(right.name));
    setFolderTree(tree => updateTreeNode(tree, treePath, node => ({ ...node, expanded: true, loaded: true, children })));
  };

  const toggleFolder = (node: FolderNode) => {
    if (!node.expanded && !node.loaded) {
      void run(() => loadTreeChildren(node.path));
      return;
    }
    setFolderTree(tree => updateTreeNode(tree, node.path, item => ({ ...item, expanded: !item.expanded })));
  };

  useEffect(() => {
    if (session.token) {
      void loadFiles("").catch(error => setNotice(error.message));
      void loadTreeChildren("").catch(error => setNotice(error.message));
    }
  }, [session.token]);

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

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    await run(async () => {
      validateServer(session);
      const response = await api("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: session.username, password })
      });
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json();
      setSession(current => ({ ...current, token: data.token, username: data.user.username, userId: data.user.id ?? null, role: data.user.role ?? "user", permissions: data.user.permissions ?? [] }));
      setPassword("");
    });
  };

  const selectedItems = files.filter(file => selected.includes(file.path));
  const toggle = (file: FileItem, checked: boolean) => setSelected(current => checked ? [...new Set([...current, file.path])] : current.filter(value => value !== file.path));

  const searchFiles = () => run(async () => {
    const query = search.trim();
    if (!query) {
      if (searching) await loadFiles(pathBeforeSearch);
      return;
    }
    if (!searching) setPathBeforeSearch(path);
    const response = await api(`/api/files/search?query=${encodeURIComponent(query)}`);
    const data = await response.json();
    if (!response.ok || data.indexing) throw new Error(data.message || "Search is not available yet.");
    setFiles((data.files || []).filter((file: FileItem) => file.name && file.path));
    setSearching(true);
    setSelected([]);
  });

  const clearSearch = () => {
    setSearch("");
    if (searching) void run(() => loadFiles(pathBeforeSearch));
  };

  const isValidMoveTarget = (items: FileItem[], destination: string) => items.length > 0 && items.every(item => {
    const source = item.path;
    const sourceFolder = source.split("/").slice(0, -1).join("/");
    return destination !== sourceFolder && (!item.isDirectory || (destination !== source && !destination.startsWith(`${source}/`)));
  });

  const moveItems = (items: FileItem[], destination: string) => run(async () => {
    if (!isValidMoveTarget(items, destination)) throw new Error("Choose a folder other than the current folder or a folder inside a selected folder.");
    const response = await api("/api/files/paste", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: items.map(({ name, isDirectory, path: itemPath }) => ({ name, isDirectory, path: itemPath })), operation: "cut", targetPath: destination }) });
    if (!response.ok) throw new Error(await readError(response));
    const data = await response.json();
    setDragItems([]);
    setDropTarget("");
    setContextMenu(null);
    setNotice(data.message || "Move complete.");
    setFolderTree({ path: "", name: "/", expanded: true, loaded: false, children: [] });
    await Promise.all([loadFiles(path), loadTreeChildren("", true)]);
  });

  const beginDrag = (event: React.DragEvent, file: FileItem) => {
    const items = selected.includes(file.path) ? selectedItems : [file];
    if (!selected.includes(file.path)) setSelected([file.path]);
    setDragItems(items);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", items.map(item => item.name).join(", "));
  };

  const finishDrag = () => {
    setDragItems([]);
    setDropTarget("");
  };

  const download = () => run(async () => {
    if (!selectedItems.length) return;
    const singleFile = selectedItems.length === 1 && !selectedItems[0].isDirectory;
    const fileName = singleFile ? selectedItems[0].name : "archive.zip";
    const response = singleFile
      ? await api(`/api/files/download/${downloadPath(selectedItems[0].path)}`)
      : await api("/api/archive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: selectedItems.map(({ name, isDirectory, path: itemPath }) => ({ name, isDirectory, path: itemPath })), currentPath: path }) });
    if (!response.ok) throw new Error(await readError(response));
    const destination = await invoke<string>("write_download", { fileName, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) });
    setNotice(`Downloaded to ${destination}`);
  });

  const upload = (event: React.ChangeEvent<HTMLInputElement>) => void run(async () => {
    const picked = Array.from(event.target.files || []);
    event.target.value = "";
    if (!picked.length) return;
    const headers = session.token ? [["Authorization", `Bearer ${session.token}`]] : [];
    const files = await Promise.all(picked.map(async file => ({
      name: file.name,
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
      relativePath: file.webkitRelativePath || undefined
    })));
    const rawResponse = await invoke<NativeApiResponse>("api_upload", {
      url: `${serverUrl(session)}/api/upload/multiple`,
      headers,
      files,
      path,
      ignoreTlsErrors: session.ignoreTlsErrors
    });
    const response = new ApiResponse(rawResponse.status, rawResponse.body);
    if (!response.ok) throw new Error(await readError(response));
    setNotice(`Upload started for ${picked.length} file${picked.length === 1 ? "" : "s"}.`);
    await loadFiles(path);
  });

  const createFolder = () => run(async () => {
    const folderName = window.prompt("Folder name");
    if (!folderName?.trim()) return;
    const response = await api("/api/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderName: folderName.trim(), currentPath: path }) });
    if (!response.ok) throw new Error(await readError(response));
    await loadFiles(path);
    setNotice(`Created ${folderName.trim()}.`);
  });

  const rename = () => run(async () => {
    if (selectedItems.length !== 1) return;
    const item = selectedItems[0];
    const newName = window.prompt("New name", item.name);
    if (!newName?.trim() || newName === item.name) return;
    const response = await api("/api/files/rename", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ oldName: item.name, newName: newName.trim(), currentPath: path }) });
    if (!response.ok) throw new Error(await readError(response));
    await loadFiles(path);
    setNotice(`Renamed ${item.name}.`);
  });

  const remove = () => run(async () => {
    if (!selectedItems.length || !window.confirm(`Delete ${selectedItems.length} selected item${selectedItems.length === 1 ? "" : "s"}?`)) return;
    const response = await api("/api/files/delete", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: selectedItems.map(({ name, isDirectory }) => ({ name, isDirectory })), currentPath: path }) });
    if (!response.ok) throw new Error(await readError(response));
    await loadFiles(path);
    setNotice("Deleted selected items.");
  });

  const share = () => run(async () => {
    if (selectedItems.length !== 1 || selectedItems[0].isDirectory) return;
    const response = await api("/api/files/share", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filePath: selectedItems[0].path }) });
    if (!response.ok) throw new Error(await readError(response));
    const data = await response.json() as ShareResponse;
    const url = data.data?.fullUrl || (data.data?.shareUrl ? `${serverUrl(session)}${data.data.shareUrl}` : "");
    if (!url) throw new Error("The server did not return a share link.");
    setShareUrl(url);
    setNotice("Share link created.");
  });

  const changePassword = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get("currentPassword") || "");
    const newPassword = String(form.get("newPassword") || "");
    const confirmPassword = String(form.get("confirmPassword") || "");
    void run(async () => {
      if (newPassword !== confirmPassword) throw new Error("The new passwords do not match.");
      const response = await api("/auth/change-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword }) });
      if (!response.ok) throw new Error(await readError(response));
      setChangePasswordOpen(false);
      setSession(current => ({ ...current, token: "" }));
      setNotice("Password changed. Please sign in again.");
    });
  };

  const signOut = () => {
    setAccountOpen(false);
    setSession(current => ({ ...current, token: "", username: "", userId: null, role: "", permissions: [] }));
  };

  const renderTreeNode = (node: FolderNode) => <div className="folder-tree" key={node.path}><div className={`tree-node ${path === node.path ? "active" : ""} ${dropTarget === node.path ? "drop-target" : ""}`} onDragOver={event => { if (isValidMoveTarget(dragItems, node.path)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(node.path); } }} onDragLeave={() => setDropTarget("")} onDrop={event => { event.preventDefault(); const items = dragItems; finishDrag(); void moveItems(items, node.path); }}><button className="tree-toggle" aria-label={`${node.expanded ? "Collapse" : "Expand"} ${node.name}`} onClick={() => toggleFolder(node)}>{node.expanded ? "−" : "+"}</button><button className="tree-folder" onClick={() => void run(() => loadFiles(node.path))}><span className="folder-mini" />{node.name}</button>{dragItems.length > 0 && dropTarget === node.path && <span className="drop-label">Move here</span>}</div>{node.expanded && <div className="tree-children">{node.loaded ? node.children.map(renderTreeNode) : <span className="tree-loading">Loading folders...</span>}</div>}</div>;

  if (!session.token) return <main className="login"><form onSubmit={login}><h1>File Transfer</h1><p>Sign in to your file server over HTTPS.</p><label>Server address<input placeholder="files.example.internal" value={session.host} onChange={event => setSession(current => ({ ...current, host: event.target.value }))} /></label><label>HTTPS port<input inputMode="numeric" value={session.port} onChange={event => setSession(current => ({ ...current, port: event.target.value }))} /></label><label>Username<input value={session.username} onChange={event => setSession(current => ({ ...current, username: event.target.value }))} /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} /></label><label className="tls-option"><input type="checkbox" checked={session.ignoreTlsErrors} onChange={event => setSession(current => ({ ...current, ignoreTlsErrors: event.target.checked }))} /> Ignore SSL certificate verification <small>Only enable for a server you trust.</small></label><button disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>{notice && <output role="alert">{notice}</output>}</form></main>;

  return <main className="explorer">
    <header className="titlebar"><span className="app-mark" /><span className="app-name">LAB File Manager</span><span className="connection-status">SECURE STORAGE</span><div className="account-control" ref={accountControl}><button className="account" onClick={event => { event.stopPropagation(); setAccountOpen(open => !open); }} aria-expanded={accountOpen}>{session.username}<span className="account-role">{session.role === "admin" ? "Admin" : "User"}</span><span className="account-chevron">⌄</span></button>{accountOpen && <div className="account-menu"><div className="account-summary"><strong>{session.username}</strong><span>{session.role === "admin" ? "System administrator" : "Standard user"}</span></div>{session.role === "admin" && <button onClick={() => { setAccountOpen(false); setNotice("Admin console browser handoff is being added in issue #111."); }}>Admin console</button>}<button onClick={() => { setAccountOpen(false); setChangePasswordOpen(true); }}>Change password</button><hr /><button className="danger" onClick={signOut}>Log out</button></div>}</div></header>
    <nav className="commandbar" aria-label="File actions"><button className="primary" onClick={() => uploadInput.current?.click()} disabled={busy}>Upload</button><input ref={uploadInput} className="visually-hidden" type="file" multiple onChange={upload} /><button onClick={createFolder} disabled={busy}>New folder</button><span className="divider" /><button disabled={busy || !selectedItems.length} onClick={download}>Download</button><button disabled={busy || !selectedItems.length} onClick={() => setNotice("Drag selected files to a destination folder to move them.")}>Move</button><button disabled={busy || selectedItems.length !== 1} onClick={rename}>Rename</button><button disabled={busy || selectedItems.length !== 1 || selectedItems[0].isDirectory} onClick={share}>Share</button><button disabled={busy || !selectedItems.length} onClick={remove}>Delete</button><span className="divider" /><button onClick={() => setSelected(selected.length === files.length ? [] : files.map(file => file.path))}>Select all</button><span className="view-switch"><button className={viewMode === "details" ? "active" : ""} onClick={() => setViewMode("details")}>Details</button><button className={viewMode === "grid" ? "active" : ""} onClick={() => setViewMode("grid")}>Grid</button></span><button onClick={() => void run(() => loadFiles(path))} disabled={busy}>Refresh</button></nav>
    <div className="navigation"><button className="nav-button" onClick={() => void run(() => loadFiles(searching ? pathBeforeSearch : parentPath(path)))} disabled={busy || (!path && !searching)}>↑</button><div className="crumbs"><button onClick={() => void run(() => loadFiles(""))}>/</button>{path.split("/").filter(Boolean).map((part, index, parts) => <React.Fragment key={`${part}-${index}`}><span className="crumb-separator">›</span><button onClick={() => void run(() => loadFiles(parts.slice(0, index + 1).join("/")))}>{part}</button></React.Fragment>)}</div><div className="search-control"><input className="search" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === "Enter") searchFiles(); if (event.key === "Escape") clearSearch(); }} placeholder="Search files" />{(search || searching) && <button className="clear-search" onClick={clearSearch}>×</button>}</div></div>
    <section className="desktop-content"><div className="content-heading"><div><span className="eyebrow">CURRENT DIRECTORY</span><h1>{searching ? `Search results for "${search}"` : path || "/"}</h1></div>{selectedItems.length > 0 && <span className="selection-count">{selectedItems.length} selected</span>}</div>{notice && <output className="notice transfer-notice" role="status">{notice}</output>}{shareUrl && <div className="share-link"><label>Share link<input readOnly value={shareUrl} onFocus={event => event.currentTarget.select()} /></label><button onClick={() => void navigator.clipboard.writeText(shareUrl).then(() => setNotice("Share link copied.")).catch(error => setNotice(error.message))}>Copy link</button><button onClick={() => setShareUrl("")}>Close</button></div>}<div className="file-area">{viewMode === "grid" ? <div className="file-grid">{files.map(file => <article key={file.path} className={`file-tile ${selected.includes(file.path) ? "selected" : ""} ${dropTarget === file.path ? "drop-target" : ""}`} draggable onDragStart={event => beginDrag(event, file)} onDragEnd={finishDrag} onDragOver={event => { if (file.isDirectory && isValidMoveTarget(dragItems, file.path)) { event.preventDefault(); setDropTarget(file.path); } }} onDrop={event => { if (file.isDirectory) { event.preventDefault(); const items = dragItems; finishDrag(); void moveItems(items, file.path); } }} onClick={event => { if (event.ctrlKey || event.metaKey) toggle(file, true); else setSelected([file.path]); }} onDoubleClick={() => file.isDirectory ? void run(() => loadFiles(file.path)) : download()} onContextMenu={event => { event.preventDefault(); setSelected([file.path]); setContextMenu({ x: event.clientX, y: event.clientY }); }}><span className="tile-icon">{file.isDirectory ? "📁" : "📄"}</span><strong>{file.name}</strong><span>{file.isDirectory ? "File folder" : "File"}</span><small>{file.isDirectory ? "Drop files here" : formatSize(file.size)}</small></article>)}</div> : <table className="file-table"><thead><tr><th aria-label="Select" /><th>Name</th><th>Modified</th><th>Size</th></tr></thead><tbody>{files.map(file => <tr key={file.path} draggable className={`file-row ${selected.includes(file.path) ? "selected" : ""} ${dropTarget === file.path ? "drop-target" : ""}`} onDragStart={event => beginDrag(event, file)} onDragEnd={finishDrag} onDragOver={event => { if (file.isDirectory && isValidMoveTarget(dragItems, file.path)) { event.preventDefault(); setDropTarget(file.path); } }} onDrop={event => { if (file.isDirectory) { event.preventDefault(); const items = dragItems; finishDrag(); void moveItems(items, file.path); } }} onClick={event => { if (event.ctrlKey || event.metaKey) toggle(file, true); else setSelected([file.path]); }} onDoubleClick={() => file.isDirectory ? void run(() => loadFiles(file.path)) : download()} onContextMenu={event => { event.preventDefault(); setSelected([file.path]); setContextMenu({ x: event.clientX, y: event.clientY }); }}><td><input aria-label={`Select ${file.name}`} type="checkbox" checked={selected.includes(file.path)} onChange={event => toggle(file, event.target.checked)} onClick={event => event.stopPropagation()} /></td><td><span className="file-name">{file.isDirectory ? "📁" : "📄"} {file.name}</span></td><td className="muted">{file.modified ? new Date(file.modified).toLocaleString() : "--"}</td><td className="muted">{file.isDirectory ? "--" : formatSize(file.size)}</td></tr>)}</tbody></table>}</div></section>
    <aside className="sidebar desktop-folder-tree"><span className="sidebar-label">Locations</span>{renderTreeNode(folderTree)}</aside>
    <footer className="statusbar"><span>{files.length} item{files.length === 1 ? "" : "s"}</span><span>{searching ? "Search results" : path ? `/${path}` : "/"}</span></footer>
    {contextMenu && <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}><button disabled={!selectedItems.length} onClick={() => { setContextMenu(null); download(); }}>Download</button><button disabled={selectedItems.length !== 1} onClick={() => { setContextMenu(null); rename(); }}>Rename</button><button disabled={selectedItems.length !== 1 || selectedItems[0].isDirectory} onClick={() => { setContextMenu(null); share(); }}>Share</button><hr /><button disabled={!selectedItems.length} onClick={() => { setContextMenu(null); remove(); }}>Delete</button></div>}
    {changePasswordOpen && <div className="modal-cover" onMouseDown={() => setChangePasswordOpen(false)}><div className="modal" onMouseDown={event => event.stopPropagation()}><h2>Change password</h2><form onSubmit={changePassword}><p>Changing your password signs this device out.</p><label>Current password<input name="currentPassword" type="password" autoFocus required /></label><label>New password<input name="newPassword" type="password" minLength={6} required /></label><label>Confirm new password<input name="confirmPassword" type="password" minLength={6} required /></label><div className="modal-actions"><button type="button" onClick={() => setChangePasswordOpen(false)}>Cancel</button><button className="confirm" type="submit" disabled={busy}>Change password</button></div></form></div></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
