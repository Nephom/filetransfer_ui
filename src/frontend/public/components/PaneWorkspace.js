import React from 'react';
import PaneFileWindow from './PaneFileWindow.js';
import PaneTools from './PaneTools.js';
import { normalisePanePath, paneHeaders, paneItemKey, paneViewModeKey } from './pane-workspace-utils.js';

const emptyPane = (id, locationId, z) => ({ id, locationId, path: '', files: [], selected: [], query: '', loading: true, error: '', mode: localStorage.getItem(paneViewModeKey) || 'details', z });

export default function PaneWorkspace({ token, user, onLogout, onStyleChange }) {
    const [locations, setLocations] = React.useState([]);
    const [windows, setWindows] = React.useState([]);
    const [activeId, setActiveId] = React.useState(null);
    const [accountOpen, setAccountOpen] = React.useState(false);
    const [nextId, setNextId] = React.useState(1);
    const [toast, setToast] = React.useState('');
    const [clipboard, setClipboard] = React.useState(null);
    const fileInput = React.useRef(null);
    const windowsRef = React.useRef(windows);
    windowsRef.current = windows;
    const activeWindow = windows.find((pane) => pane.id === activeId);
    const locationFor = (id) => locations.find((location) => location.id === id);
    const announce = (message) => { setToast(message); window.setTimeout(() => setToast(''), 3000); };
    const patchWindow = (id, patch) => setWindows((current) => current.map((pane) => pane.id === id ? { ...pane, ...patch } : pane));
    const selectedItems = (pane) => pane.files.filter((file) => pane.selected.includes(paneItemKey(file)));

    const loadFiles = async (id, path = '', query = '') => {
        const pane = windowsRef.current.find((item) => item.id === id); const location = locationFor(pane?.locationId);
        if (!pane || !location) return;
        patchWindow(id, { loading: true, error: '' });
        try {
            const url = query ? `/api/files/search?query=${encodeURIComponent(query)}` : `/api/files?path=${encodeURIComponent(path)}&sort=name&order=asc`;
            const response = await fetch(url, { headers: paneHeaders(token, location) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.indexing) throw new Error(data.message || 'Unable to load this folder.');
            patchWindow(id, { files: (data.files || []).filter((file) => file?.name), path: data.currentPath || path, query, loading: false, selected: [] });
        } catch (error) { patchWindow(id, { loading: false, error: error.message }); }
    };
    const openWindow = (locationId) => {
        const id = `pane-${nextId}`;
        setNextId((value) => value + 1);
        setWindows((current) => [...current, emptyPane(id, locationId, current.length + 1)]);
        setActiveId(id);
        window.setTimeout(() => loadFiles(id), 0);
    };
    const closeWindow = (id) => {
        const pane = windows.find((item) => item.id === id);
        if (!pane) return;
        localStorage.setItem(paneViewModeKey, pane.mode);
        setWindows((current) => current.filter((item) => item.id !== id));
        setActiveId((current) => current === id ? null : current);
    };
    const focusWindow = (id) => { setActiveId(id); setWindows((current) => current.map((pane) => ({ ...pane, z: pane.id === id ? Math.max(...current.map((item) => item.z), 0) + 1 : pane.z }))); };
    const choose = (id, key, event) => {
        const pane = windows.find((item) => item.id === id); if (!pane) return;
        const selected = event.ctrlKey || event.metaKey ? (pane.selected.includes(key) ? pane.selected.filter((item) => item !== key) : [...pane.selected, key]) : [key];
        patchWindow(id, { selected });
    };
    const moveItems = async (sourceId, destinationId, items, operation = 'cut') => {
        const source = windows.find((pane) => pane.id === sourceId); const destination = windows.find((pane) => pane.id === destinationId);
        const sourceLocation = locationFor(source?.locationId); const destinationLocation = locationFor(destination?.locationId);
        if (!source || !destination || sourceId === destinationId || !sourceLocation || !destinationLocation) return;
        const response = await fetch('/api/files/paste', { method: 'POST', headers: { ...paneHeaders(token, sourceLocation), 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items.map((item) => ({ name: item.name, isDirectory: item.isDirectory, path: normalisePanePath(item.path || `${source.path}/${item.name}`), sourceLocationId: source.locationId })), operation, sourceLocationId: source.locationId, sourceLocationRevision: sourceLocation.revision, targetLocationId: destination.locationId, targetLocationRevision: destinationLocation.revision, targetPath: destination.path }) });
        if (!response.ok) throw new Error('Move or copy failed.');
        announce(`${operation === 'cut' ? 'Moved' : 'Copied'} ${items.length} item${items.length === 1 ? '' : 's'}.`);
        await Promise.all([loadFiles(sourceId, source.path, source.query), loadFiles(destinationId, destination.path, destination.query)]);
    };
    const runAction = async (id, action) => {
        const pane = windows.find((item) => item.id === id); const location = locationFor(pane?.locationId); const items = pane ? selectedItems(pane) : [];
        if (!pane || !location) return;
        const headers = paneHeaders(token, location);
        try {
            if (action === 'refresh') return loadFiles(id, pane.path, pane.query);
            if (action === 'upload') return fileInput.current?.click();
            if (action === 'select-all') return patchWindow(id, { selected: pane.files.map(paneItemKey) });
            if (action === 'new-folder') { const name = window.prompt('Folder name'); if (!name?.trim()) return; const response = await fetch('/api/folders', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ folderName: name.trim(), currentPath: pane.path }) }); if (!response.ok) throw new Error('Could not create folder.'); }
            if (action === 'rename') { if (items.length !== 1) return announce('Select one item to rename.'); const name = window.prompt('New name', items[0].name); if (!name?.trim()) return; const oldPath = normalisePanePath(items[0].path || `${pane.path}/${items[0].name}`); const response = await fetch('/api/files/rename', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPath, oldName: items[0].name, newName: name.trim(), currentPath: oldPath.split('/').slice(0, -1).join('/') }) }); if (!response.ok) throw new Error('Rename failed.'); }
            if (action === 'delete') { if (!items.length || !window.confirm(`Delete ${items.length} selected item${items.length === 1 ? '' : 's'}?`)) return; const groups = new Map(); items.forEach((item) => { const path = normalisePanePath(item.path || `${pane.path}/${item.name}`); const parent = path.split('/').slice(0, -1).join('/'); if (!groups.has(parent)) groups.set(parent, []); groups.get(parent).push({ name: path.split('/').pop(), path, isDirectory: item.isDirectory }); }); for (const [currentPath, group] of groups) { const response = await fetch('/api/files/delete', { method: 'DELETE', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPath, items: group }) }); if (!response.ok) throw new Error('Delete failed.'); } }
            if (action === 'download') { if (!items.length) return announce('Select files to download.'); for (const item of items) { const response = await fetch(`/api/files/download/${encodeURIComponent(item.path)}`, { headers }); if (!response.ok) throw new Error('Download failed.'); const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = item.name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 60000); } }
            if (action === 'share') { if (items.length !== 1 || items[0].isDirectory) return announce('Select one file to share.'); const response = await fetch('/api/files/share', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ locationId: pane.locationId, filePath: items[0].path, expiresIn: 86400, maxDownloads: 0 }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Share failed.'); if (data.data?.fullUrl) await navigator.clipboard.writeText(data.data.fullUrl); announce('Secure share link copied.'); return; }
            if (action === 'copy' || action === 'move') { if (!items.length) return announce(`Select files to ${action}.`); setClipboard({ sourceId: id, items, operation: action === 'copy' ? 'copy' : 'cut' }); return announce(`${action === 'copy' ? 'Copied' : 'Moved'} items are ready. Drop them into another open window.`); }
            announce(`${action.replace('-', ' ')} complete.`); await loadFiles(id, pane.path, pane.query);
        } catch (error) { patchWindow(id, { error: error.message }); }
    };
    const upload = async (event) => {
        const pane = activeWindow; const location = locationFor(pane?.locationId); const files = Array.from(event.target.files || []); event.target.value = '';
        if (!pane || !location || !files.length) return;
        const headers = paneHeaders(token, location);
        const reservation = await fetch('/api/upload/batches', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: pane.path, clientAttemptId: `pane-${Date.now()}-${Math.random().toString(16).slice(2)}` }) });
        const reservationData = await reservation.json().catch(() => ({}));
        if (!reservation.ok || !reservationData.batchId) { patchWindow(pane.id, { error: reservationData.error || 'Upload reservation failed.' }); return; }
        const form = new FormData(); files.forEach((file) => form.append('files', file, file.name)); form.append('path', pane.path);
        const response = await fetch('/api/upload/multiple', { method: 'POST', headers: { ...headers, 'X-Upload-Batch-ID': reservationData.batchId }, body: form });
        if (!response.ok) { patchWindow(pane.id, { error: 'Upload failed.' }); return; }
        announce('Upload submitted.'); await loadFiles(pane.id, pane.path, pane.query);
    };
    const handleDrop = (event, destinationId) => {
        let payload; try { payload = JSON.parse(event.dataTransfer.getData('application/x-pane-file') || '{}'); } catch { return; }
        const source = windows.find((pane) => pane.id === payload.windowId); if (!source) return;
        const pending = clipboard?.sourceId === source.id ? clipboard : null;
        const items = pending?.items || (selectedItems(source).length ? selectedItems(source) : source.files.filter((file) => paneItemKey(file) === payload.key));
        void moveItems(source.id, destinationId, items, pending?.operation || 'cut');
        if (pending) setClipboard(null);
    };
    React.useEffect(() => { fetch('/api/locations', { headers: token ? { Authorization: `Bearer ${token}` } : {} }).then((response) => response.json()).then((data) => setLocations((data.locations || []).filter((location) => location?.id))).catch(() => announce('Unable to load Locations.')); }, [token]);
    React.useEffect(() => { const close = () => setAccountOpen(false); window.addEventListener('click', close); return () => window.removeEventListener('click', close); }, []);
    return <div className="pane-explorer" onContextMenu={(event) => event.preventDefault()}>
        <header className="pane-titlebar"><span className="app-mark" /><span className="app-name">LAB File Manager</span><span className="connection-status">SECURE STORAGE</span><div className="account-control"><button className="account" onClick={(event) => { event.stopPropagation(); setAccountOpen((open) => !open); }} aria-expanded={accountOpen}>{user.username}<span className="account-role">{user.role}</span><span className="account-chevron">⌄</span></button>{accountOpen && <div className="account-menu"><div className="account-summary"><strong>{user.username}</strong><span>Interface preferences</span></div><label className="style-menu-item" onClick={(event) => event.stopPropagation()}>Style settings<select aria-label="Interface style" value="pane" onChange={(event) => onStyleChange(event.target.value)}><option value="classical">Classical Style</option><option value="pane">Pane Style</option></select></label><button className="danger" onClick={onLogout}>Log out</button></div>}</div></header>
        <main className="pane-workspace"><aside className="pane-side pane-locations"><div className="pane-heading">LOCATIONS</div><div className="pane-location-list">{locations.map((location) => <button type="button" key={location.id} className={windows.some((pane) => pane.locationId === location.id) ? 'is-open' : ''} onClick={() => openWindow(location.id)}><span className="folder-mini" /><span><strong>{location.displayName || location.id}</strong><small>{location.status || 'online'}</small></span></button>)}</div></aside><section className="pane-center"><div className="pane-window-layer">{windows.map((pane) => <PaneFileWindow key={pane.id} window={pane} location={locationFor(pane.locationId)} active={activeId === pane.id} selectedItems={selectedItems(pane)} onFocus={focusWindow} onClose={closeWindow} onAction={runAction} onModeChange={(id, mode) => patchWindow(id, { mode })} onQueryChange={(id, query) => patchWindow(id, { query })} onLoadFiles={loadFiles} onChoose={choose} onDrop={handleDrop} />)}</div>{!windows.length && <div className="pane-empty-state"><strong>Open a Location</strong><span>Each Location opens as an independent floating file explorer.</span></div>}</section><PaneTools active={activeWindow} onUpload={() => fileInput.current?.click()} onAction={(action) => activeId && void runAction(activeId, action)} /></main><input ref={fileInput} type="file" multiple hidden onChange={upload} /><footer className="pane-statusbar"><span>{windows.length} open window{windows.length === 1 ? '' : 's'}</span><span>{activeWindow ? `Active: ${locationFor(activeWindow.locationId)?.displayName || activeWindow.locationId}` : 'Open a Location to begin'}</span></footer>{toast && <div className="pane-toast" role="status">{toast}</div>}</div>;
}
