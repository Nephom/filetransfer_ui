import React from "react";
import type { VncFileTransferPaneProps } from "../../proxmox-vnc";

export function VncFileTransferPane({ entry, vmName, vmid, fileBrowser }: VncFileTransferPaneProps) {
  return <section className="vnc-files-pane" aria-label={`Files on ${vmName}`}>
    <header className="vnc-files-heading">
      <div><span className="eyebrow">VNC File Transfer · {entry.name}</span><h1>{vmName}</h1><small>VMID {vmid}</small></div>
      <span className="vnc-reachability-status" data-mode={fileBrowser.mode}>
        {fileBrowser.modeLabel}{fileBrowser.guestIp ? ` · ${fileBrowser.guestIp}` : ""}
      </span>
    </header>
    <div className="vnc-files-toolbar">
      <button type="button" className="confirm" onClick={fileBrowser.onUpload} disabled={!fileBrowser.filesReady}>Upload</button>
      <button type="button" onClick={fileBrowser.onDownload} disabled={!fileBrowser.filesReady || !fileBrowser.selectedPaths.size}>Download{fileBrowser.selectedPaths.size ? ` (${fileBrowser.selectedPaths.size})` : ""}</button>
      <button type="button" onClick={fileBrowser.onRefresh} disabled={!fileBrowser.filesReady || fileBrowser.filesLoading}>Refresh</button>
      {fileBrowser.canTryHostJump && <button type="button" onClick={fileBrowser.onTryHostJump} disabled={fileBrowser.loading}>Try Host Jump</button>}
      <span className="vnc-files-breadcrumb" title={fileBrowser.path}>{fileBrowser.path}</span>
    </div>
    {fileBrowser.loading && <div className="vnc-empty">Detecting how to reach this VM for file transfer...</div>}
    {!fileBrowser.loading && fileBrowser.transferError && <div className="notice rest-error" role="alert">{fileBrowser.transferError}</div>}
    {fileBrowser.filesError && <div className="notice rest-error" role="alert">{fileBrowser.filesError}</div>}
    {fileBrowser.filesReady && <div className="vnc-files-table-wrap">
      {fileBrowser.filesLoading && <div className="vnc-files-loading" role="status">Loading folder…</div>}
      <table className="file-table">
        <thead><tr><th className="selection-column" aria-label="Select files" /><th>Name</th><th>Size</th><th>Modified</th></tr></thead>
        <tbody>
          {fileBrowser.path !== "/" && <tr className="file-row">
            <td className="selection-column" />
            <td><button type="button" className="tree-folder" onClick={() => fileBrowser.onNavigate(parentPath(fileBrowser.path))}>.. (up)</button></td>
            <td>--</td><td>--</td>
          </tr>}
          {!fileBrowser.filesLoading && !fileBrowser.files.length && <tr className="file-row"><td colSpan={4} className="vnc-files-empty">This folder is empty.</td></tr>}
          {fileBrowser.files.map((file) => <tr className="file-row" key={file.path}>
            <td className="selection-column">
              {(!file.isDirectory || fileBrowser.mode !== "guest-agent")
                ? <input type="checkbox" checked={fileBrowser.selectedPaths.has(file.path)} onChange={() => fileBrowser.onToggleSelect(file.path)} aria-label={`Select ${file.name}`} />
                : <span className="vnc-files-unavailable-selection" aria-label="Folder download unavailable with Guest Agent">—</span>}
            </td>
            <td>{file.isDirectory
              ? <button type="button" className="tree-folder" onClick={() => fileBrowser.onNavigate(file.path)}><span className="folder-mini" />{file.name}</button>
              : <span className="vnc-file-name-cell">{file.name}</span>}</td>
            <td>{file.isDirectory ? "--" : formatFileSize(file.size)}</td>
            <td>{formatModifiedDate(file.modified)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>}
    {fileBrowser.queue.length > 0 && <div className="vnc-transfer-queue">
      {fileBrowser.queue.map((item) => <div className="queue-item" key={item.id}>
        <div className="queue-item-header"><span className="queue-item-label">{item.kind === "upload" ? "Upload" : "Download"}: {item.label}</span><span className={`queue-status ${item.status}`}>{item.status}</span></div>
        <div className="queue-item-detail">{item.detail}</div>
        {(item.status === "completed" || item.status === "failed") && <div className="queue-item-actions"><button type="button" onClick={() => fileBrowser.onRemoveQueueItem(item.id)}>Remove</button></div>}
      </div>)}
    </div>}
  </section>;
}

function formatFileSize(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatModifiedDate(millis: number): string {
  if (!millis) return "--";
  try { return new Date(millis).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }); } catch { return "--"; }
}

function parentPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.length > 1 ? `/${segments.slice(0, -1).join("/")}` : "/";
}
