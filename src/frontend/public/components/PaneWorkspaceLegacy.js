import React from 'react';
import PaneFileWindow from './PaneFileWindow.js';
import PaneTerminalWindow from './PaneTerminalWindow.js';
import PaneTools, { PaneTerminalLauncher } from './PaneTools.js';
import { clearLegacyPaneBackgroundStorage, deletePaneBackground, loadPaneBackground, savePaneBackground } from './pane-background-storage.js';
import { normalisePanePath, paneHeaders, paneItemKey, paneViewModeKey, usePaneMenuPosition } from './pane-workspace-utils.js';

const BACKGROUND_MAX_FILE_SIZE = 5 * 1024 * 1024;
const BACKGROUND_MIN_SCALE = 0.5;
const BACKGROUND_MAX_SCALE = 2;
const BACKGROUND_SCALE_STEP = 0.1;
const BACKGROUND_POSITION_STEP = 10;
const PASTE_PROGRESS_READ_TIMEOUT_MS = 45_000; // Allow three missed 15-second server heartbeats.
const PANE_TRANSFER_FAILURE_PREVIEW_LIMIT = 50; // Keep retained failure details bounded for large batches.
const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);
const roundScale = (value) => Math.round(value * 100) / 100;
const centeredBackgroundPosition = () => ({ x: 50, y: 50 });
const normaliseBackgroundCoordinate = (value) => { const numeric = Number(value); return Number.isFinite(numeric) ? numeric : 50; };
const normaliseBackgroundPosition = (position) => ({ x: clamp(normaliseBackgroundCoordinate(position?.x), 0, 100), y: clamp(normaliseBackgroundCoordinate(position?.y), 0, 100) });
const normaliseBackgroundScale = (scale) => clamp(roundScale(Number(scale) || 1), BACKGROUND_MIN_SCALE, BACKGROUND_MAX_SCALE);
const consumePasteProgressStream = async (response, onEvent) => {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The transfer progress stream is unavailable.');
    const decoder = new TextDecoder();
    let buffer = '';
    let terminalEvent = null;
    const dispatch = (block) => {
        let event = 'message';
        const data = [];
        for (const line of block.split(/\r?\n/)) {
            if (!line || line.startsWith(':')) continue;
            const separator = line.indexOf(':');
            const field = separator < 0 ? line : line.slice(0, separator);
            const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
            if (field === 'event') event = value;
            if (field === 'data') data.push(value);
        }
        if (!data.length) return;
        let payload;
        try {
            payload = JSON.parse(data.join('\n'));
        } catch (error) {
            throw new Error(`Invalid transfer progress data: ${error.message}`);
        }
        onEvent(event, payload);
        if (event === 'complete' || event === 'error') terminalEvent = { event, payload };
    };
    try {
        while (true) {
            let timeout;
            let read;
            try {
                read = await Promise.race([
                    reader.read(),
                    new Promise((resolve, reject) => {
                        timeout = window.setTimeout(() => reject(new Error('Transfer progress was inactive for too long.')), PASTE_PROGRESS_READ_TIMEOUT_MS);
                    })
                ]);
            } finally {
                if (timeout !== undefined) window.clearTimeout(timeout);
            }
            const { done, value } = read;
            buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
            let separator = buffer.match(/\r?\n\r?\n/);
            while (separator) {
                const index = separator.index;
                const block = buffer.slice(0, index);
                buffer = buffer.slice(index + separator[0].length);
                dispatch(block);
                separator = buffer.match(/\r?\n\r?\n/);
            }
            if (done) break;
        }
    } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
    }
    if (buffer.trim()) dispatch(buffer);
    if (!terminalEvent) throw new Error('The transfer progress stream ended before its final status.');
    return terminalEvent;
};

const emptyPane = (id, locationId, z) => ({ id, locationId, path: '', files: [], selected: [], query: '', loading: true, error: '', mode: localStorage.getItem(paneViewModeKey) || 'details', minimized: false, maximized: false, z });

export default function PaneWorkspace({ token, user, onLogout, onStyleChange, transferQueue = [], onCancelUpload, onResumeUpload, onUploadFiles }) {
    const [locations, setLocations] = React.useState([]);
    const [windows, setWindows] = React.useState([]);
    const [terminalWindows, setTerminalWindows] = React.useState([]);
    const [activeId, setActiveId] = React.useState(null);
    const [accountOpen, setAccountOpen] = React.useState(false);
    const [styleSettingsOpen, setStyleSettingsOpen] = React.useState(false);
    const [theme, setTheme] = React.useState(() => localStorage.getItem('pane-background-theme') || 'default');
    const [customBackground, setCustomBackground] = React.useState(null);
    const [backgroundEditorOpen, setBackgroundEditorOpen] = React.useState(false);
    const [backgroundScale, setBackgroundScale] = React.useState(1);
    const [backgroundPosition, setBackgroundPosition] = React.useState(centeredBackgroundPosition());
    const [backgroundStorageReady, setBackgroundStorageReady] = React.useState(false);
    const [nextId, setNextId] = React.useState(1);
    const [nextTerminalId, setNextTerminalId] = React.useState(1);
    const [toast, setToast] = React.useState('');
    const [transferProgress, setTransferProgress] = React.useState(null);
    const [clipboard, setClipboard] = React.useState(null);
    const [contextMenu, setContextMenu] = React.useState(null);
    const menuPosition = usePaneMenuPosition(contextMenu);
    const fileInput = React.useRef(null);
    const dragRef = React.useRef(null);
    const backgroundInput = React.useRef(null);
    const backgroundLoadRef = React.useRef(0);
    const pendingBackgroundUrlRef = React.useRef('');
    const backgroundPersistenceRef = React.useRef(Promise.resolve());
    const transferSequenceRef = React.useRef(0);
    const transferRunningRef = React.useRef(false);
    const transferDismissTimerRef = React.useRef(null);
    const transferMountedRef = React.useRef(true);
    const windowsRef = React.useRef(windows);
    windowsRef.current = windows;
    const terminalWindowsRef = React.useRef(terminalWindows);
    terminalWindowsRef.current = terminalWindows;
    const activeWindow = windows.find((pane) => pane.id === activeId && !pane.minimized);
    const locationFor = (id) => locations.find((location) => location.id === id);
    const announce = (message) => { setToast(message); window.setTimeout(() => setToast(''), 3000); };
    const clearTransferDismissTimer = () => {
        if (transferDismissTimerRef.current !== null) window.clearTimeout(transferDismissTimerRef.current);
        transferDismissTimerRef.current = null;
    };
    const dismissTransferProgress = () => {
        clearTransferDismissTimer();
        setTransferProgress((current) => current?.status === 'running' ? current : null);
    };
    React.useEffect(() => {
        transferMountedRef.current = true;
        return () => {
            transferMountedRef.current = false;
            transferRunningRef.current = false;
            clearTransferDismissTimer();
        };
    }, []);
    const openPrivateConsole = async (destination) => {
        try {
            const response = await fetch('/auth/browser-handoff', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
            if (!response.ok) throw new Error('Unable to open the console.');
            const data = await response.json();
            window.location.assign(`${data.url}?destination=${encodeURIComponent(destination)}`);
        } catch (error) { announce(error.message); }
    };
    const patchWindow = (id, patch) => setWindows((current) => current.map((pane) => pane.id === id ? { ...pane, ...patch } : pane));
    const patchTerminalWindow = (id, patch) => setTerminalWindows((current) => current.map((pane) => pane.id === id ? { ...pane, ...patch } : pane));
    const nextZIndex = () => Math.max(...[...windowsRef.current, ...terminalWindowsRef.current].map((pane) => pane.z), 0) + 1;
    const moveWindow = (id, left, top) => {
        const position = left === null ? null : { left, top };
        if (terminalWindowsRef.current.some((pane) => pane.id === id)) patchTerminalWindow(id, { position });
        else patchWindow(id, { position });
    };
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
        setWindows((current) => [...current, { ...emptyPane(id, locationId, nextZIndex()), position: null }]);
        setActiveId(id);
        window.setTimeout(() => loadFiles(id), 0);
    };
    const openTerminalWindow = () => {
        console.log('[PaneWorkspaceLegacy] openTerminalWindow called');
        const id = `terminal-${nextTerminalId}`;
        setNextTerminalId((value) => value + 1);
        setTerminalWindows((current) => [...current, { id, targetId: '', minimized: false, maximized: false, position: null, z: nextZIndex() }]);
        setActiveId(id);
    };
    window.__paneWorkspaceOpenTerminal = openTerminalWindow;
    console.log('[PaneWorkspaceLegacy] window.__paneWorkspaceOpenTerminal set');
    const closeWindow = (id) => {
        const pane = windows.find((item) => item.id === id);
        if (!pane) return;
        localStorage.setItem(paneViewModeKey, pane.mode);
        setWindows((current) => current.filter((item) => item.id !== id));
        setActiveId((current) => current === id ? null : current);
    };
    const closeTerminalWindow = (id) => {
        setTerminalWindows((current) => current.filter((item) => item.id !== id));
        setActiveId((current) => current === id ? null : current);
    };
    const focusWindow = (id) => {
        const pane = [...windowsRef.current, ...terminalWindowsRef.current].find((item) => item.id === id);
        if (!pane || pane.minimized) return;
        setActiveId(id);
        const z = nextZIndex();
        setWindows((current) => current.map((item) => item.id === id ? { ...item, z } : item));
        setTerminalWindows((current) => current.map((item) => item.id === id ? { ...item, z } : item));
    };
    const onTitlePointerDown = (paneId) => (event) => {
        if (event.target.closest('button, select, input, textarea')) return;
        const windowElement = event.currentTarget.closest('.pane-window');
        const layer = windowElement?.parentElement;
        if (!windowElement || !layer || dragRef.current) return;
        event.preventDefault();
        focusWindow(paneId);
        const windowRect = windowElement.getBoundingClientRect();
        const layerRect = layer.getBoundingClientRect();
        dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - windowRect.left, offsetY: event.clientY - windowRect.top, layerRect, paneId };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const onTitlePointerMove = (paneId) => (event) => {
        const drag = dragRef.current;
        const windowElement = event.currentTarget.closest('.pane-window');
        if (!drag || drag.pointerId !== event.pointerId || !windowElement || drag.paneId !== paneId) return;
        const pane = [...windowsRef.current, ...terminalWindowsRef.current].find((item) => item.id === drag.paneId);
        if (!pane) return;
        const newPosition = { left: Math.max(0, Math.min(drag.layerRect.width - windowElement.offsetWidth, event.clientX - drag.layerRect.left - drag.offsetX)), top: Math.max(0, Math.min(drag.layerRect.height - windowElement.offsetHeight, event.clientY - drag.layerRect.top - drag.offsetY)) };
        if (paneId.startsWith('terminal-')) {
            setTerminalWindows(current => current.map(p => p.id === paneId ? { ...p, position: newPosition } : p));
        } else {
            setWindows(current => current.map(p => p.id === paneId ? { ...p, position: newPosition } : p));
        }
    };
    const onTitlePointerUp = (paneId) => (event) => {
        if (dragRef.current?.paneId !== paneId) return;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        dragRef.current = null;
    };
    const minimizeWindow = (id) => {
        setWindows((current) => current.map((pane) => pane.id === id ? { ...pane, minimized: true } : pane));
        setTerminalWindows((current) => current.map((pane) => pane.id === id ? { ...pane, minimized: true } : pane));
    };
    const restoreWindow = (id) => {
        const z = nextZIndex();
        setWindows((current) => {
            return current.map((pane) => pane.id === id ? { ...pane, minimized: false, z } : pane);
        });
        setTerminalWindows((current) => {
            return current.map((pane) => pane.id === id ? { ...pane, minimized: false, z } : pane);
        });
        setActiveId(id);
    };
    const toggleMaximizeWindow = (id) => {
        const pane = [...windowsRef.current, ...terminalWindowsRef.current].find((item) => item.id === id);
        if (!pane || pane.minimized) return;
        focusWindow(id);
        setWindows((current) => current.map((item) => item.id === id ? { ...item, maximized: !item.maximized } : item));
        setTerminalWindows((current) => current.map((item) => item.id === id ? { ...item, maximized: !item.maximized } : item));
    };
    const choose = (id, key, event) => {
        const pane = windows.find((item) => item.id === id); if (!pane) return;
        const selected = event.ctrlKey || event.metaKey ? (pane.selected.includes(key) ? pane.selected.filter((item) => item !== key) : [...pane.selected, key]) : [key];
        patchWindow(id, { selected });
    };
    const moveItems = async (sourceId, destinationId, items, operation = 'cut') => {
        const source = windows.find((pane) => pane.id === sourceId); const destination = windows.find((pane) => pane.id === destinationId);
        const sourceLocation = locationFor(source?.locationId); const destinationLocation = locationFor(destination?.locationId);
        if (!source || !destination || sourceId === destinationId || !sourceLocation || !destinationLocation || !items.length || transferRunningRef.current) return;
        clearTransferDismissTimer();
        transferRunningRef.current = true;
        const transferId = ++transferSequenceRef.current;
        const totalItems = items.length;
        const operationLabel = operation === 'cut' ? 'Move' : 'Copy';
        setTransferProgress({
            id: transferId,
            operation,
            status: 'running',
            phase: 'preparing',
            currentName: items[0].name,
            totalItems,
            completedItems: 0,
            failedItems: 0,
            resolvedItems: 0,
            remainingItems: totalItems,
            failures: [],
            message: `Preparing to ${operation === 'cut' ? 'move' : 'copy'} items...`
        });
        const updateProgress = (patch) => {
            if (!transferMountedRef.current) return;
            setTransferProgress((current) => current?.id === transferId ? { ...current, ...patch } : current);
        };
        const finishProgress = (status, data) => {
            if (!transferMountedRef.current) return;
            clearTransferDismissTimer();
            updateProgress({
                ...data,
                status,
                phase: 'finished',
                currentName: data.currentName || data.results?.at(-1)?.name || items[0].name
            });
            if (status === 'completed') {
                transferDismissTimerRef.current = window.setTimeout(() => {
                    setTransferProgress((current) => current?.id === transferId ? null : current);
                    transferDismissTimerRef.current = null;
                }, 1800);
            }
        };
        try {
            const response = await fetch('/api/files/paste', {
                method: 'POST',
                headers: { ...paneHeaders(token, sourceLocation), 'Accept': 'text/event-stream', 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: items.map((item) => ({ name: item.name, isDirectory: item.isDirectory, path: normalisePanePath(item.path || `${source.path}/${item.name}`), sourceLocationId: source.locationId })), operation, sourceLocationId: source.locationId, sourceLocationRevision: sourceLocation.revision, targetLocationId: destination.locationId, targetLocationRevision: destinationLocation.revision, targetPath: destination.path })
            });
            let finalData;
            let finalEvent = 'complete';
            if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) {
                const terminal = await consumePasteProgressStream(response, (event, data) => {
                    if (event === 'start') {
                        updateProgress({ ...data, phase: 'preparing', status: 'running' });
                    } else if (event === 'item-start') {
                        updateProgress({ ...data, phase: 'transferring', status: 'running' });
                    } else if (event === 'item-result') {
                        setTransferProgress((current) => {
                            if (!transferMountedRef.current || current?.id !== transferId) return current;
                            const previousFailures = (current.failures || []).filter((result) => result.itemIndex !== data.itemIndex);
                            const failures = data.result?.success === false
                                ? [...previousFailures, { ...data.result, itemIndex: data.itemIndex }].slice(0, PANE_TRANSFER_FAILURE_PREVIEW_LIMIT)
                                : previousFailures;
                            return { ...current, ...data, failures, phase: 'transferring', status: 'running' };
                        });
                    }
                });
                finalEvent = terminal.event;
                finalData = terminal.payload;
            } else {
                finalData = await response.json();
                if (!response.ok && !finalData.error) finalData.error = `${operationLabel} request failed (${response.status}).`;
            }
            const results = Array.isArray(finalData.results) ? finalData.results : [];
            const failures = results.filter((result) => result?.success === false).slice(0, PANE_TRANSFER_FAILURE_PREVIEW_LIMIT);
            const completedItems = Number.isInteger(finalData.completedItems) ? finalData.completedItems : results.filter((result) => result?.success === true).length;
            const failedItems = Number.isInteger(finalData.failedItems) ? finalData.failedItems : results.filter((result) => result?.success === false).length;
            const resolvedItems = Number.isInteger(finalData.resolvedItems) ? finalData.resolvedItems : results.length;
            const remainingItems = Number.isInteger(finalData.remainingItems) ? finalData.remainingItems : Math.max(0, totalItems - resolvedItems);
            // Only a successful terminal event and HTTP response may auto-dismiss the panel.
            const succeeded = finalEvent === 'complete' && finalData.success === true && response.ok;
            const status = succeeded ? 'completed' : (finalData.status === 'partial' || completedItems > 0 ? 'partial' : 'failed');
            finishProgress(status, {
                currentName: results.at(-1)?.name,
                totalItems,
                completedItems,
                failedItems,
                resolvedItems,
                remainingItems,
                failures,
                message: status === 'completed'
                    ? `${operationLabel} complete.`
                    : finalData.error || finalData.message || `${operationLabel} did not complete. Check the source and destination Locations before retrying.`
            });
            if (completedItems > 0 && transferMountedRef.current) {
                await Promise.all([loadFiles(sourceId, source.path, source.query), loadFiles(destinationId, destination.path, destination.query)]);
            }
        } catch (error) {
            clearTransferDismissTimer();
            updateProgress({
                status: 'unconfirmed',
                phase: 'finished',
                message: `${operationLabel} outcome is unconfirmed: ${error.message}. Check both Locations before retrying.`
            });
        } finally {
            transferRunningRef.current = false;
        }
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
    const showLocationContextMenu = (event, locationId) => { event.preventDefault(); event.stopPropagation(); setContextMenu({ type: 'location', x: event.clientX, y: event.clientY, locationId }); };
    const showWindowContextMenu = (event, windowId) => { event.preventDefault(); event.stopPropagation(); setContextMenu({ type: 'window', x: event.clientX, y: event.clientY, windowId }); };
    const closeContextMenu = () => setContextMenu(null);
    const closeAccountMenu = () => { setAccountOpen(false); setStyleSettingsOpen(false); };
    const upload = async (event) => {
        const pane = activeWindow; const location = locationFor(pane?.locationId); const files = Array.from(event.target.files || []); event.target.value = '';
        if (!pane || !location || !files.length) return;
        const warning = files.length > 500
            ? '\n\nLarge uploads are split into child batches. Up to 2 batches can run concurrently; this may use more system/storage resources and can reduce overall efficiency.'
            : '';
        if (!window.confirm(`Upload ${files.length} file${files.length === 1 ? '' : 's'} to ${pane.path ? `/${pane.path}` : '/'}?${warning}`)) return;
        if (typeof onUploadFiles !== 'function') { patchWindow(pane.id, { error: 'Resumable API upload queue is unavailable.' }); return; }
        const items = files.map((file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
        onUploadFiles(items, [], {
            path: pane.path, locationId: pane.locationId, locationName: location.displayName || location.id,
        }, () => loadFiles(pane.id, pane.path, pane.query));
        announce('Resumable upload added to the Transfer Queue.');
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
    React.useEffect(() => { const close = (event) => { if (event.target.closest?.('.pane-account-menu, .account')) return; closeAccountMenu(); setContextMenu(null); }; window.addEventListener('click', close); return () => window.removeEventListener('click', close); }, []);
    React.useEffect(() => {
        const allWindows = [...windows, ...terminalWindows];
        const active = allWindows.find((pane) => pane.id === activeId);
        if (activeId && (!active || active.minimized)) setActiveId(allWindows.filter((pane) => !pane.minimized).sort((left, right) => right.z - left.z)[0]?.id || null);
    }, [windows, terminalWindows, activeId]);
    React.useEffect(() => { if (!accountOpen) setStyleSettingsOpen(false); }, [accountOpen]);
    React.useEffect(() => { localStorage.setItem('pane-background-theme', theme); }, [theme]);
    React.useEffect(() => {
        let active = true;
        let restoredUrl = '';
        backgroundLoadRef.current += 1;
        const loadId = backgroundLoadRef.current;
        setCustomBackground(null);
        setBackgroundEditorOpen(false);
        setBackgroundScale(1);
        setBackgroundPosition(centeredBackgroundPosition());
        setBackgroundStorageReady(false);
        Promise.allSettled([clearLegacyPaneBackgroundStorage(), loadPaneBackground(token)]).then(([, backgroundResult]) => {
            if (!active) return;
            if (backgroundResult.status === 'rejected') {
                setBackgroundStorageReady(true);
                return;
            }
            const record = backgroundResult.value;
            if (!record?.blob || !(record.blob instanceof Blob)) {
                setBackgroundStorageReady(true);
                return;
            }
            restoredUrl = URL.createObjectURL(record.blob);
            const image = new Image();
            image.onload = () => {
                if (!active || loadId !== backgroundLoadRef.current) {
                    URL.revokeObjectURL(restoredUrl);
                    restoredUrl = '';
                    if (active) setBackgroundStorageReady(true);
                    return;
                }
                setCustomBackground({ url: restoredUrl, blob: record.blob, name: record.name || 'Background image', width: image.naturalWidth, height: image.naturalHeight, size: record.size || record.blob.size });
                setBackgroundScale(normaliseBackgroundScale(record.scale));
                setBackgroundPosition(normaliseBackgroundPosition(record.position));
                setBackgroundStorageReady(true);
            };
            image.onerror = () => {
                URL.revokeObjectURL(restoredUrl);
                restoredUrl = '';
                setBackgroundStorageReady(true);
            };
            image.src = restoredUrl;
        });
        return () => {
            active = false;
            if (restoredUrl) URL.revokeObjectURL(restoredUrl);
        };
    }, [token]);
    const persistBackground = (background, scale, position) => {
        if (!backgroundStorageReady || !background?.blob) return Promise.resolve(false);
        const record = {
            blob: background.blob,
            name: background.name,
            width: background.width,
            height: background.height,
            size: background.size,
            scale,
            position
        };
        const pending = backgroundPersistenceRef.current
            .catch(() => {})
            .then(() => savePaneBackground(record, token));
        backgroundPersistenceRef.current = pending.catch(() => {});
        return pending;
    };
    React.useEffect(() => {
        void persistBackground(customBackground, backgroundScale, backgroundPosition);
    }, [backgroundStorageReady, customBackground, backgroundScale, backgroundPosition, token]);
    React.useEffect(() => () => {
        if (customBackground?.url) URL.revokeObjectURL(customBackground.url);
        if (pendingBackgroundUrlRef.current) URL.revokeObjectURL(pendingBackgroundUrlRef.current);
    }, [customBackground]);
    const selectBackground = (event) => {
        const [file] = event.target.files || [];
        event.target.value = '';
        if (!file || !file.type.startsWith('image/')) return announce('Choose an image file.');
        if (file.size > BACKGROUND_MAX_FILE_SIZE) return announce('Background image must be 5MB or smaller.');
        const objectUrl = URL.createObjectURL(file);
        const loadId = backgroundLoadRef.current + 1;
        backgroundLoadRef.current = loadId;
        if (pendingBackgroundUrlRef.current) URL.revokeObjectURL(pendingBackgroundUrlRef.current);
        pendingBackgroundUrlRef.current = objectUrl;
        const image = new Image();
        image.onload = () => {
            if (loadId !== backgroundLoadRef.current) {
                URL.revokeObjectURL(objectUrl);
                return;
            }
            pendingBackgroundUrlRef.current = '';
            setCustomBackground({ url: objectUrl, blob: file, name: file.name, width: image.naturalWidth, height: image.naturalHeight, size: file.size });
            setBackgroundScale(1);
            setBackgroundPosition(centeredBackgroundPosition());
            closeAccountMenu();
            setBackgroundEditorOpen(true);
            announce(`${file.name} is now the background.`);
        };
        image.onerror = () => {
            if (loadId !== backgroundLoadRef.current) {
                URL.revokeObjectURL(objectUrl);
                return;
            }
            pendingBackgroundUrlRef.current = '';
            URL.revokeObjectURL(objectUrl);
            announce('The background image could not be loaded.');
        };
        image.src = objectUrl;
    };
    const moveBackground = (axis, direction) => setBackgroundPosition((current) => ({ ...current, [axis]: clamp(current[axis] + direction * BACKGROUND_POSITION_STEP, 0, 100) }));
    const centerBackground = () => setBackgroundPosition(centeredBackgroundPosition());
    const changeBackgroundScale = (direction) => setBackgroundScale((current) => clamp(roundScale(current + direction * BACKGROUND_SCALE_STEP), BACKGROUND_MIN_SCALE, BACKGROUND_MAX_SCALE));
    const resetBackgroundPlacement = () => { setBackgroundScale(1); setBackgroundPosition(centeredBackgroundPosition()); };
    const clearBackground = () => {
        backgroundLoadRef.current += 1;
        if (pendingBackgroundUrlRef.current) {
            URL.revokeObjectURL(pendingBackgroundUrlRef.current);
            pendingBackgroundUrlRef.current = '';
        }
        setCustomBackground(null);
        setBackgroundEditorOpen(false);
        resetBackgroundPlacement();
        backgroundPersistenceRef.current = backgroundPersistenceRef.current
            .catch(() => {})
            .then(() => deletePaneBackground(token))
            .catch(() => {});
        announce('Using the default background.');
    };
    const saveBackgroundPlacement = async () => {
        try {
            if (!await persistBackground(customBackground, backgroundScale, backgroundPosition)) throw new Error('Background storage is unavailable.');
            setBackgroundEditorOpen(false);
            announce('Background placement saved.');
        } catch {
            announce('Unable to save background placement.');
        }
    };
    const backgroundStyle = customBackground ? {
        '--pane-background-image': `url("${customBackground.url}")`,
        '--pane-background-scale': backgroundScale,
        '--pane-background-position': `${backgroundPosition.x}% ${backgroundPosition.y}%`
    } : undefined;
    const transferVerb = transferProgress?.operation === 'copy' ? 'copy' : 'move';
    const transferTotal = Math.max(0, Number(transferProgress?.totalItems) || 0);
    const transferResolved = Math.min(transferTotal, Math.max(0, Number(transferProgress?.resolvedItems) || 0));
    const transferPercent = transferTotal ? transferResolved / transferTotal * 100 : 0;
    return <div className={`pane-explorer${customBackground ? ' has-custom-background' : ''}`} data-theme={theme} style={backgroundStyle} onContextMenu={(event) => event.preventDefault()}>
        {customBackground && <div className="pane-custom-background-clip" aria-hidden="true"><div className="pane-custom-background" /></div>}
        <header className="pane-titlebar"><span className="app-mark" /><span className="app-name">LAB File Manager</span><span className="connection-status">SECURE STORAGE</span><div className="account-control"><button className="account" onClick={(event) => { event.stopPropagation(); setAccountOpen((open) => !open); }} aria-expanded={accountOpen}>{user.username}<span className="account-role">{user.role === 'admin' ? 'Admin' : user.role === 'superuser' ? 'Superuser' : 'User'}</span><span className="account-chevron">⌄</span></button>{accountOpen && <div className="account-menu pane-account-menu"><div className="account-summary"><strong>{user.username}</strong><span>{user.role === 'admin' ? 'System administrator' : user.role === 'superuser' ? 'Superuser' : 'Standard user'}</span></div>{['admin', 'superuser'].includes(user.role) && <button type="button" onClick={() => { setAccountOpen(false); void openPrivateConsole('/dashboard'); }}>Dashboard</button>}{user.role === 'admin' && <button type="button" onClick={() => { setAccountOpen(false); void openPrivateConsole('/admin'); }}>Admin console</button>}{user.role === 'superuser' && <button type="button" onClick={() => { setAccountOpen(false); void openPrivateConsole('/super'); }}>Super panel</button>}<button type="button" className="style-settings-trigger" aria-expanded={styleSettingsOpen} onClick={() => setStyleSettingsOpen((open) => !open)}>Style settings <span aria-hidden="true">⌄</span></button>{styleSettingsOpen && <div className="pane-account-style"><h2>Interface style</h2><p>Choose the central workspace appearance.</p><label>Interface mode<select aria-label="Interface style" value="pane" onChange={(event) => onStyleChange(event.target.value)}><option value="classical">Classical Style</option><option value="pane">Pane Style</option></select></label><label>Central background<select aria-label="Central background" value={theme} onChange={(event) => setTheme(event.target.value)}><option value="default">Default Gradient</option><option value="circuit">Dark Circuit</option><option value="space">Deep Space</option><option value="ocean">Ocean Signal</option><option value="aurora">Aurora Tech</option><option value="neon">Soft Neon</option><option value="light">Clean Light</option></select></label><button type="button" className="pane-background-button" onClick={() => backgroundInput.current?.click()}>▧ Choose background image</button>{customBackground && <button type="button" className="pane-background-edit-button" onClick={() => setBackgroundEditorOpen(true)}>▣ Edit background placement</button>}<input ref={backgroundInput} className="pane-hidden-file" type="file" accept="image/*" onChange={selectBackground} />{customBackground && <button type="button" className="pane-reset-background" onClick={clearBackground}>Use default background</button>}</div>}<hr /><button type="button" className="danger" onClick={onLogout}>Log out</button></div>}</div></header>
        {customBackground && backgroundEditorOpen && <aside className="pane-background-editor" data-background-editor aria-label="Background image placement"><div className="pane-background-editor-header"><div><span className="pane-background-eyebrow">BACKGROUND PLACEMENT</span><strong title={customBackground.name}>{customBackground.name}</strong></div><button type="button" className="pane-background-close" onClick={() => setBackgroundEditorOpen(false)} aria-label="Close background editor" title="Close background editor">×</button></div><div className="pane-background-meta"><span>{customBackground.width} × {customBackground.height}px</span><span>{Math.round(customBackground.size / 1024)} KB</span></div><div className="pane-background-section"><span className="pane-background-label">Position</span><div className="pane-background-position-controls"><span /><button type="button" onClick={() => moveBackground('y', -1)} disabled={backgroundPosition.y <= 0} aria-label="Move background up" title="Move background up">↑</button><span /><button type="button" onClick={() => moveBackground('x', -1)} disabled={backgroundPosition.x <= 0} aria-label="Move background left" title="Move background left">←</button><button type="button" className="is-center" onClick={centerBackground} aria-label="Center background" title="Center background">◎</button><button type="button" onClick={() => moveBackground('x', 1)} disabled={backgroundPosition.x >= 100} aria-label="Move background right" title="Move background right">→</button><span /><button type="button" onClick={() => moveBackground('y', 1)} disabled={backgroundPosition.y >= 100} aria-label="Move background down" title="Move background down">↓</button><span /></div></div><div className="pane-background-section"><span className="pane-background-label">Scale</span><div className="pane-background-scale-controls"><button type="button" onClick={() => changeBackgroundScale(-1)} disabled={backgroundScale <= BACKGROUND_MIN_SCALE} aria-label="Shrink background" title="Shrink background">-</button><output aria-label="Background scale">{Math.round(backgroundScale * 100)}%</output><button type="button" onClick={() => changeBackgroundScale(1)} disabled={backgroundScale >= BACKGROUND_MAX_SCALE} aria-label="Expand background" title="Expand background">+</button></div></div><div className="pane-background-editor-actions"><button type="button" onClick={resetBackgroundPlacement}>Reset placement</button><button type="button" className="danger" onClick={clearBackground}>Remove image</button><button type="button" className="save" onClick={() => void saveBackgroundPlacement()}>Save</button></div></aside>}
        <main className="pane-workspace">
            <aside className="pane-side pane-locations" aria-label="Locations"><div className="pane-heading" aria-hidden="true">LOCATIONS</div><PaneTerminalLauncher onOpenTerminal={openTerminalWindow} /><div className="pane-location-list">{locations.map((location) => <button type="button" key={location.id} className={windows.some((pane) => pane.locationId === location.id) ? 'is-open' : ''} onClick={() => openWindow(location.id)} onContextMenu={(event) => showLocationContextMenu(event, location.id)}><span className="folder-icon" aria-hidden="true">▰</span><span><strong>{location.displayName || location.id}</strong><small>{location.status || 'online'}</small></span></button>)}</div></aside>
            <section className="pane-center">
                <div className="pane-window-layer">
                    {windows.map((pane) => <PaneFileWindow key={pane.id} window={pane} location={locationFor(pane.locationId)} active={activeId === pane.id && !pane.minimized} selectedItems={selectedItems(pane)} onFocus={focusWindow} onClose={closeWindow} onMinimize={minimizeWindow} onToggleMaximize={toggleMaximizeWindow} onAction={runAction} onModeChange={(id, mode) => patchWindow(id, { mode })} onQueryChange={(id, query) => patchWindow(id, { query })} onLoadFiles={loadFiles} onChoose={choose} onDrop={handleDrop} onMove={moveWindow} onContextMenu={showWindowContextMenu} />)}
                    {terminalWindows.map((pane) => <PaneTerminalWindow key={pane.id} window={pane} token={token} active={activeId === pane.id && !pane.minimized} onFocus={focusWindow} onClose={closeTerminalWindow} onMinimize={minimizeWindow} onToggleMaximize={toggleMaximizeWindow} onMove={moveWindow} onTitlePointerDown={onTitlePointerDown(pane.id)} onTitlePointerMove={onTitlePointerMove(pane.id)} onTitlePointerUp={onTitlePointerUp(pane.id)} />)}
                </div>
                {(windows.some((pane) => pane.minimized) || terminalWindows.some((pane) => pane.minimized)) && <div className="pane-minimized-dock" aria-label="Minimized windows">
                    {windows.filter((pane) => pane.minimized).map((pane) => <div className="pane-minimized-item" data-window-id={pane.id} key={pane.id}><button type="button" className="pane-minimized-restore" onClick={() => restoreWindow(pane.id)} aria-label={`Restore ${locationFor(pane.locationId)?.displayName || pane.locationId}`} title="點擊還原">{locationFor(pane.locationId)?.displayName || pane.locationId}</button><button type="button" className="pane-minimized-close" onClick={() => closeWindow(pane.id)} aria-label={`Close minimized ${locationFor(pane.locationId)?.displayName || pane.locationId}`} title="Close window">×</button></div>)}
                    {terminalWindows.filter((pane) => pane.minimized).map((pane) => <div className="pane-minimized-item" data-window-id={pane.id} key={pane.id}><button type="button" className="pane-minimized-restore" onClick={() => restoreWindow(pane.id)} aria-label={`Restore terminal ${pane.id}`} title="點擊還原">SSH Terminal</button><button type="button" className="pane-minimized-close" onClick={() => closeTerminalWindow(pane.id)} aria-label={`Close minimized terminal ${pane.id}`} title="Close window">×</button></div>)}
                </div>}
                {!windows.length && !terminalWindows.length && <div className="pane-empty-state"><strong>Open a Location</strong><span>Each Location opens as an independent floating file explorer.</span></div>}
            </section>
            <PaneTools active={activeWindow} onUpload={() => fileInput.current?.click()} onAction={(action) => activeId && void runAction(activeId, action)} />
        </main>
        <input ref={fileInput} type="file" multiple hidden onChange={upload} />
        {transferProgress && <div className="pane-transfer-cover" data-status={transferProgress.status}>
            <section className="pane-transfer-panel" role="dialog" aria-modal={transferProgress.status === 'running' ? 'true' : 'false'} aria-labelledby="pane-transfer-title" aria-describedby="pane-transfer-message">
                <header className="pane-transfer-header">
                    <div><span className="pane-transfer-eyebrow">FILE TRANSFER</span><h2 id="pane-transfer-title">{transferVerb === 'move' ? 'Move items' : 'Copy items'}</h2></div>
                    <span className="pane-transfer-indicator" aria-hidden="true">{transferProgress.status === 'completed' ? '✓' : transferProgress.status === 'running' ? '↻' : '!'}</span>
                </header>
                <div className="pane-transfer-current">
                    <span>{transferProgress.status === 'running' ? transferProgress.phase === 'preparing' ? 'Preparing transfer' : `${transferVerb === 'move' ? 'Moving' : 'Copying'} now` : 'Last item'}</span>
                    <strong title={transferProgress.currentName || ''}>{transferProgress.currentName || 'Selected items'}</strong>
                </div>
                <div className="pane-transfer-progress" role="progressbar" aria-label="Transfer progress" aria-valuemin="0" aria-valuemax={transferTotal} aria-valuenow={transferResolved} aria-valuetext={`${transferProgress.completedItems || 0} completed, ${transferProgress.remainingItems || 0} remaining`}>
                    <span style={{ width: `${transferPercent}%` }} />
                    {transferProgress.status === 'running' && <span className="pane-transfer-scan" aria-hidden="true" />}
                </div>
                <div className="pane-transfer-counts">
                    <strong>{transferProgress.completedItems || 0} of {transferTotal} items {transferVerb === 'move' ? 'moved' : 'copied'}</strong>
                    <span>{transferProgress.remainingItems || 0} remaining</span>
                    {transferProgress.failedItems > 0 && <span className="pane-transfer-failed-count">{transferProgress.failedItems} failed</span>}
                </div>
                <p id="pane-transfer-message" className="pane-transfer-message" role="status" aria-live="polite">{transferProgress.message}</p>
                {(transferProgress.failures || []).length > 0 && <ul className="pane-transfer-errors" aria-label="Failed items">
                    {(transferProgress.failures || []).map((result, index) => <li key={`${result.path || result.name}-${index}`}><strong>{result.name || result.path}</strong><span>{result.error || 'The item could not be transferred.'}</span></li>)}
                </ul>}
                {transferProgress.failedItems > (transferProgress.failures || []).length && <p className="pane-transfer-message">Showing {transferProgress.failures.length} of {transferProgress.failedItems} failed items.</p>}
                {transferProgress.status !== 'running' && <div className="pane-transfer-actions"><button type="button" onClick={dismissTransferProgress}>Close</button></div>}
            </section>
        </div>}
        {transferQueue.some(item => item.kind === 'upload') && <aside className="pane-upload-queue" aria-label="API upload queue">
            <strong>API Uploads</strong>
            {transferQueue.filter(item => item.kind === 'upload').slice(-8).map(item => <article className={`pane-upload-queue-item queue-status-${item.status}`} key={item.id}>
                <span><b>{item.label}</b><small role="status" aria-live="polite">{item.detail}</small></span>
                {item.progress && <small>{item.progress.totalBytes ? `${Math.round(item.progress.completedBytes / item.progress.totalBytes * 100)}% · ` : ''}{item.progress.completedItems || 0}/{item.progress.totalItems || 0} files</small>}
                {['queued', 'running', 'retrying'].includes(item.status) && <button type="button" onClick={() => onCancelUpload?.(item.id)}>Cancel</button>}
                {item.serverSessionId && item.status === 'needs_user_action' && <button type="button" onClick={() => {
                    const pane = windowsRef.current.find(candidate => candidate.locationId === item.locationId) || activeWindow;
                    onResumeUpload?.(item, pane ? () => loadFiles(pane.id, pane.path, pane.query) : undefined);
                }}>Resume</button>}
            </article>)}
        </aside>}
        <footer className="pane-statusbar"><span>{windows.length} open window{windows.length === 1 ? '' : 's'}</span><span>{activeWindow ? `Active: ${locationFor(activeWindow.locationId)?.displayName || activeWindow.locationId}` : 'Open a Location to begin'}</span></footer>
        {contextMenu && <div ref={menuPosition.ref} className="pane-context-menu" style={menuPosition.style} onClick={(event) => event.stopPropagation()}>{contextMenu.type === 'location' ? <button type="button" onClick={() => { openWindow(contextMenu.locationId); closeContextMenu(); }}>Open new window</button> : <>{[['upload', 'Upload'], ['new-folder', 'New Folder'], ['rename', 'Rename'], ['move', 'Move'], ['copy', 'Copy'], ['delete', 'Delete'], ['share', 'Share'], ['download', 'Download'], ['refresh', 'Refresh']].map(([action, label]) => <button type="button" key={action} onClick={() => { void runAction(contextMenu.windowId, action); closeContextMenu(); }}>{label}</button>)}</>}</div>}
        {toast && <div className="pane-toast" role="status">{toast}</div>}
        </div>;
}
