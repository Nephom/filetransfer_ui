const formatSize = (size) => {
    if (!size) return size === 0 ? '0 B' : '--';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
    return `${(size / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
};

const formatDate = (value) => value ? new Date(value).toLocaleString() : '--';
const itemKey = (item) => item.path || item.name;
const fileIcon = (item) => item.isDirectory ? '📁' : '📄';
const normalisePath = (value) => (value || '').replace(/^\/+|\/+$/g, '');
const fileType = (item) => {
    if (item.isDirectory) return 'File folder';
    const extension = item.name?.split('.').pop();
    return extension && extension !== item.name ? `${extension.toUpperCase()} file` : 'File';
};

const readDirectoryEntries = (reader) => new Promise((resolve, reject) => {
    const entries = [];
    const read = () => reader.readEntries((batch) => {
        if (!batch.length) return resolve(entries);
        entries.push(...batch);
        read();
    }, reject);
    read();
});

const readDroppedEntry = async (entry, prefix = '') => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        return { files: [{ file, relativePath }], directories: [] };
    }

    const children = await readDirectoryEntries(entry.createReader());
    const nested = await Promise.all(children.map((child) => readDroppedEntry(child, relativePath)));
    return {
        files: nested.flatMap((result) => result.files),
        directories: [relativePath, ...nested.flatMap((result) => result.directories)]
    };
};

const collectDroppedUpload = async (dataTransfer) => {
    const entries = Array.from(dataTransfer.items || [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.webkitGetAsEntry?.())
        .filter(Boolean);

    if (entries.length) {
        const results = await Promise.all(entries.map((entry) => readDroppedEntry(entry)));
        return {
            files: results.flatMap((result) => result.files),
            directories: [...new Set(results.flatMap((result) => result.directories))]
        };
    }

    const files = Array.from(dataTransfer.files || []).map((file) => ({
        file,
        relativePath: file.webkitRelativePath || file.name
    }));
    return { files, directories: [] };
};

const FileBrowser = ({ token, user, onLogout }) => {
    const [files, setFiles] = React.useState([]);
    const [locations, setLocations] = React.useState([]);
    const [locationId, setLocationId] = React.useState('');
    const [expandedLocations, setExpandedLocations] = React.useState({});
    const [locationsLoading, setLocationsLoading] = React.useState(true);
    const [currentPath, setCurrentPath] = React.useState('');
    const [displayPath, setDisplayPath] = React.useState('/');
    const [selected, setSelected] = React.useState([]);
    const selectionAnchor = React.useRef(null);
    const [search, setSearch] = React.useState('');
    const [searching, setSearching] = React.useState(false);
    const [pathBeforeSearch, setPathBeforeSearch] = React.useState('');
    const [loading, setLoading] = React.useState(true);
    const [downloading, setDownloading] = React.useState(false);
    const [moving, setMoving] = React.useState(false);
    const [transferStatus, setTransferStatus] = React.useState('');
    const [error, setError] = React.useState('');
    const [modal, setModal] = React.useState(null);
    const [context, setContext] = React.useState(null);
    const [shareLink, setShareLink] = React.useState('');
    const [locationTrees, setLocationTrees] = React.useState({});
    const [dragItems, setDragItems] = React.useState([]);
    const [dropTarget, setDropTarget] = React.useState(null);
    const [fileDropTarget, setFileDropTarget] = React.useState(null);
    const [viewMode, setViewMode] = React.useState(() => localStorage.getItem('file-view-mode') || 'details');
    const [archiveFormat, setArchiveFormat] = React.useState(() => localStorage.getItem('archive-format') || 'tar.gz');
    const [accountOpen, setAccountOpen] = React.useState(false);
    const inputRef = React.useRef(null);
    const accountRef = React.useRef(null);
    const dragExpandTimer = React.useRef(null);
    const notificationTimer = React.useRef(null);
    const downloadInProgress = React.useRef(false);
    const locationsLoaded = React.useRef(false);
    const locationRefreshInProgress = React.useRef(false);

    const authHeaders = {
        Authorization: `Bearer ${token}`,
        ...(locationId ? { 'X-Location-ID': locationId } : {})
    };
    const headersForLocation = (requestedLocationId) => ({
        Authorization: `Bearer ${token}`,
        ...(requestedLocationId ? { 'X-Location-ID': requestedLocationId } : {})
    });
    const selectedItems = files.filter((file) => selected.includes(itemKey(file)));
    const pathForItem = (item) => normalisePath(item.path || (currentPath ? `${currentPath}/${item.name}` : item.name));

    const loadLocations = async () => {
        if (locationRefreshInProgress.current) return;
        locationRefreshInProgress.current = true;
        if (!locationsLoaded.current) setLocationsLoading(true);
        try {
            const response = await fetch('/api/locations', { headers: { Authorization: `Bearer ${token}` } });
            if (!response.ok) throw new Error('Unable to load Locations.');
            const data = await response.json();
            const available = (data.locations || []).filter((location) => location && location.id);
            locationsLoaded.current = true;
            setLocations(available);
            setLocationTrees((current) => Object.fromEntries(available.map((location) => [
                location.id,
                current[location.id] || { path: '', name: '/', expanded: true, loaded: false, children: [] }
            ])));
            setExpandedLocations((current) => Object.fromEntries(available.map((location, index) => [location.id, current[location.id] ?? index === 0])));
            setLocationId((current) => available.some((location) => location.id === current) ? current : available[0]?.id || '');
        } catch (requestError) { setError(requestError.message); }
        finally {
            locationRefreshInProgress.current = false;
            setLocationsLoading(false);
        }
    };

    const loadFiles = async (path = currentPath, requestedLocationId = locationId) => {
        setLoading(true); setError(''); setContext(null);
        try {
            const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`, { headers: headersForLocation(requestedLocationId) });
            if (!response.ok) throw new Error('Unable to load this folder.');
            const data = await response.json();
            setFiles((data.files || []).filter((file) => file && file.name));
            setCurrentPath(data.currentPath || '');
            setDisplayPath(data.currentPath || '/');
            setSearching(false); setSearch(''); setSelected([]);
        } catch (requestError) { setError(requestError.message); }
        finally { setLoading(false); }
    };

    const updateTreeNode = (node, targetPath, update) => {
        if (node.path === targetPath) return update(node);
        return { ...node, children: node.children.map((child) => updateTreeNode(child, targetPath, update)) };
    };

    const loadTreeChildren = async (requestedLocationId, path, force = false) => {
        const targetPath = normalisePath(path);
        try {
            const response = await fetch(`/api/files?path=${encodeURIComponent(targetPath)}`, { headers: headersForLocation(requestedLocationId) });
            if (!response.ok) throw new Error('Unable to load folders.');
            const data = await response.json();
            const children = (data.files || [])
                .filter((file) => file && file.name && file.isDirectory)
                .map((file) => ({ path: normalisePath(file.path), name: file.name, expanded: false, loaded: false, children: [] }))
                .sort((left, right) => left.name.localeCompare(right.name));
            setLocationTrees((current) => ({
                ...current,
                [requestedLocationId]: updateTreeNode(
                    current[requestedLocationId] || { path: '', name: '/', expanded: true, loaded: false, children: [] },
                    targetPath,
                    (node) => ({ ...node, expanded: true, loaded: true, children })
                )
            }));
        } catch (requestError) {
            if (!force) setError(requestError.message);
        }
    };

    const toggleFolder = (requestedLocationId, node) => {
        if (node.expanded) {
            setLocationTrees((current) => ({
                ...current,
                [requestedLocationId]: updateTreeNode(current[requestedLocationId], node.path, (item) => ({ ...item, expanded: false }))
            }));
        } else if (node.loaded) {
            setLocationTrees((current) => ({
                ...current,
                [requestedLocationId]: updateTreeNode(current[requestedLocationId], node.path, (item) => ({ ...item, expanded: true }))
            }));
        } else {
            loadTreeChildren(requestedLocationId, node.path);
        }
    };

    const toggleLocation = (requestedLocationId) => {
        const expanded = !expandedLocations[requestedLocationId];
        setExpandedLocations((current) => ({ ...current, [requestedLocationId]: expanded }));
        if (expanded) loadTreeChildren(requestedLocationId, '');
    };

    React.useEffect(() => { loadLocations(); }, [token]);

    React.useEffect(() => {
        if (!token) return undefined;
        const healthTimer = window.setInterval(() => { loadLocations(); }, 15000);
        return () => window.clearInterval(healthTimer);
    }, [token]);

    React.useEffect(() => {
        const handleLocationsUpdated = () => { loadLocations(); };
        window.addEventListener('locations-updated', handleLocationsUpdated);
        return () => window.removeEventListener('locations-updated', handleLocationsUpdated);
    }, [token]);
    React.useEffect(() => {
        if (!locationId) return;
        loadFiles('');
        loadTreeChildren(locationId, '');
    }, [locationId]);
    React.useEffect(() => {
        if (modal !== 'move') return;
        locations.forEach((location) => {
            if (!locationTrees[location.id]?.loaded) loadTreeChildren(location.id, '');
        });
    }, [modal, locations]);
    React.useEffect(() => {
        const close = (event) => {
            setContext(null);
            if (!accountRef.current || !accountRef.current.contains(event.target)) setAccountOpen(false);
        };
        window.addEventListener('click', close);
        return () => window.removeEventListener('click', close);
    }, []);
    React.useEffect(() => () => {
        window.clearTimeout(dragExpandTimer.current);
        window.clearTimeout(notificationTimer.current);
    }, []);
    React.useEffect(() => { localStorage.setItem('file-view-mode', viewMode); }, [viewMode]);
    React.useEffect(() => { localStorage.setItem('archive-format', archiveFormat); }, [archiveFormat]);

    const activeLocation = locations.find((location) => location.id === locationId);
    const hasCapability = (capability) => activeLocation?.capabilities?.includes(capability) === true;
    const selectLocation = (nextLocationId) => {
        if (nextLocationId === locationId) return;
        setLocationId(nextLocationId);
        setCurrentPath('');
        setDisplayPath('/');
        setSelected([]);
        setSearch('');
        setSearching(false);
        setPathBeforeSearch('');
        setContext(null);
        setDragItems([]);
        setDropTarget(null);
        setFileDropTarget(null);
        setLocationTrees((current) => ({ ...current, [nextLocationId]: { path: '', name: '/', expanded: true, loaded: false, children: [] } }));
    };

    const showSuccess = (message) => {
        window.clearTimeout(notificationTimer.current);
        setTransferStatus(message);
        notificationTimer.current = window.setTimeout(() => setTransferStatus(''), 3500);
    };

    const searchFiles = async () => {
        const query = search.trim();
        if (!query) return loadFiles(searching ? pathBeforeSearch : currentPath);
        setLoading(true); setError(''); setContext(null);
        try {
            if (!searching) setPathBeforeSearch(currentPath);
            const response = await fetch(`/api/files/search?query=${encodeURIComponent(query)}`, { headers: authHeaders });
            const data = await response.json();
            if (!response.ok || data.indexing) throw new Error(data.message || 'Search is not available yet.');
            const results = (data.files || []).filter((file) => file && typeof file.name === 'string' && file.name.trim() && typeof file.path === 'string' && file.path.trim());
            setFiles(results); setDisplayPath(`Search results for "${query}"`); setSearching(true); setSelected([]);
        } catch (requestError) { setError(requestError.message); setFiles([]); }
        finally { setLoading(false); }
    };

    const openFolder = (file) => { if (file.isDirectory) loadFiles(file.path); };
    const goUp = () => { if (searching) return loadFiles(pathBeforeSearch); if (currentPath) loadFiles(currentPath.split('/').slice(0, -1).join('/')); };
    const clearSearch = () => {
        setSearch('');
        if (searching) loadFiles(pathBeforeSearch);
    };
    const choose = (file, event) => {
        const key = itemKey(file);
        const index = files.findIndex((item) => itemKey(item) === key);
        const anchorIndex = selectionAnchor.current === null
            ? -1
            : files.findIndex((item) => itemKey(item) === selectionAnchor.current);
        if (event.shiftKey && anchorIndex >= 0 && index >= 0) {
            const start = Math.min(anchorIndex, index);
            const end = Math.max(anchorIndex, index);
            setSelected(files.slice(start, end + 1).map(itemKey));
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            selectionAnchor.current = key;
            setSelected((items) => items.includes(key) ? items.filter((item) => item !== key) : [...items, key]);
            return;
        }
        selectionAnchor.current = key;
        setSelected([key]);
    };
    const selectAll = () => setSelected(selected.length === files.length ? [] : files.map(itemKey));

    const downloadBlob = (blob, name) => {
        const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
        anchor.href = url; anchor.download = name; document.body.appendChild(anchor); anchor.click(); anchor.remove();
        // The browser needs time to claim the object URL after the synthetic click.
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    };
    const download = async (items = selectedItems) => {
        if (!items.length || downloadInProgress.current) return;
        const isArchive = items.length > 1 || items[0].isDirectory;
        downloadInProgress.current = true;
        window.clearTimeout(notificationTimer.current);
        setDownloading(true); setError('');
        setTransferStatus(isArchive ? `Preparing archive for ${items.length} item${items.length === 1 ? '' : 's'}...` : `Preparing download: ${items[0].name}...`);
        try {
            if (!isArchive) {
                const file = items[0]; const response = await fetch(`/api/files/download/${encodeURIComponent(file.path)}`, { headers: authHeaders });
                if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Download failed.'); downloadBlob(await response.blob(), file.name);
            } else {
                const response = await fetch('/api/archive', { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items.map(({ name, isDirectory, path }) => ({ name, isDirectory, path })), currentPath, format: archiveFormat }) });
                if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Archive download failed.');
                const disposition = response.headers.get('Content-Disposition') || ''; const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i);
                downloadBlob(await response.blob(), match ? decodeURIComponent(match[1]) : `archive.${archiveFormat}`);
            }
            showSuccess('Download started in your browser.');
        } catch (requestError) { setTransferStatus(''); setError(requestError.message); }
        finally { downloadInProgress.current = false; setDownloading(false); }
    };

    const isValidMoveTarget = (items, destination, destinationLocationId = locationId) => {
        const target = normalisePath(destination);
        if (destinationLocationId !== locationId) return items.length > 0;
        return items.length > 0 && items.every((item) => {
            const source = pathForItem(item);
            const sourceFolder = source.split('/').slice(0, -1).join('/');
            return target !== sourceFolder && (!item.isDirectory || (target !== source && !target.startsWith(`${source}/`)));
        });
    };

    const moveItems = async (items, destination, destinationLocationId = locationId) => {
        const targetPath = normalisePath(destination);
        if (!isValidMoveTarget(items, targetPath, destinationLocationId)) {
            setError('Choose a folder other than the current folder or a folder inside a selected folder.');
            return;
        }
        setMoving(true); setError(''); setTransferStatus(`Moving ${items.length} item${items.length === 1 ? '' : 's'} to ${destinationLocationId}:${targetPath ? `/${targetPath}` : '/'}...`);
        try {
            const response = await fetch('/api/files/paste', { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items.map((item) => ({ name: item.name, isDirectory: item.isDirectory, path: pathForItem(item), sourceLocationId: locationId })), operation: 'cut', sourceLocationId: locationId, targetLocationId: destinationLocationId, targetPath }) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Move failed.');
            setModal(null); setDragItems([]); setDropTarget(null); showSuccess(data.message || 'Move complete.');
            setLocationTrees((current) => ({
                ...current,
                [locationId]: { path: '', name: '/', expanded: true, loaded: false, children: [] },
                [destinationLocationId]: { path: '', name: '/', expanded: true, loaded: false, children: [] }
            }));
            loadTreeChildren(locationId, '', true);
            if (destinationLocationId !== locationId) loadTreeChildren(destinationLocationId, '', true);
            loadFiles(currentPath);
        } catch (requestError) { setTransferStatus(''); setError(requestError.message); }
        finally { setMoving(false); }
    };

    const beginDrag = (event, file) => {
        const items = selected.includes(itemKey(file)) ? selectedItems : [file];
        if (!selected.includes(itemKey(file))) setSelected([itemKey(file)]);
        setDragItems(items); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', items.map((item) => item.name).join(', '));
    };
    const endDrag = () => { window.clearTimeout(dragExpandTimer.current); setDragItems([]); setDropTarget(null); setFileDropTarget(null); };
    const scheduleTreeExpand = (requestedLocationId, node) => {
        if (node.expanded) return;
        window.clearTimeout(dragExpandTimer.current);
        dragExpandTimer.current = window.setTimeout(() => toggleFolder(requestedLocationId, node), 650);
    };

    const remove = async () => {
        if (!selectedItems.length || !window.confirm(`Delete ${selectedItems.length} selected item${selectedItems.length === 1 ? '' : 's'}?`)) return;
        try {
            const response = await fetch('/api/files/delete', { method: 'DELETE', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ items: selectedItems.map(({ name, isDirectory }) => ({ name, isDirectory })), currentPath }) });
            if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Delete failed.'); } showSuccess(`Deleted ${selectedItems.length} item${selectedItems.length === 1 ? '' : 's'}.`); loadFiles(currentPath); loadTreeChildren(locationId, '', true);
        } catch (requestError) { setError(requestError.message); }
    };
    const saveFolder = async (event) => {
        event.preventDefault(); const name = event.target.folderName.value.trim(); if (!name) return;
        try {
            const response = await fetch('/api/folders', { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ folderName: name, currentPath }) });
            if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Could not create folder.'); } setModal(null); showSuccess('Folder created.'); loadFiles(currentPath); loadTreeChildren(locationId, '', true);
        } catch (requestError) { setError(requestError.message); }
    };
    const saveRename = async (event) => {
        event.preventDefault(); const newName = event.target.newName.value.trim(); if (!newName || !selectedItems[0]) return;
        try {
            const response = await fetch('/api/files/rename', { method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ oldName: selectedItems[0].name, newName, currentPath }) });
            if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Rename complete.'); } setModal(null); showSuccess('Rename complete.'); loadFiles(currentPath); loadTreeChildren(locationId, '', true);
        } catch (requestError) { setError(requestError.message); }
    };
    const uploadFiles = async (items, directories = []) => {
        if (!items.length && !directories.length) return;
        const data = new FormData();
        items.forEach(({ file, relativePath }) => {
            data.append('files', file, file.name);
            data.append('filePaths[]', relativePath);
        });
        directories.forEach((directory) => data.append('directoryPaths[]', directory));
        data.append('path', currentPath);
        setLoading(true); setError(''); setTransferStatus(`Uploading ${items.length} file${items.length === 1 ? '' : 's'}...`);
        try {
            const response = await fetch('/api/upload/multiple', { method: 'POST', headers: authHeaders, body: data });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error?.message || result.error || 'Upload failed.');
            let completed = !result.batchId;
            if (result.batchId) {
                for (let attempt = 0; attempt < 600; attempt += 1) {
                    const progressResponse = await fetch(`/api/progress/batch/${encodeURIComponent(result.batchId)}`, { headers: authHeaders });
                    const progress = await progressResponse.json().catch(() => ({}));
                    if (!progressResponse.ok) throw new Error(progress.error || 'Unable to read upload progress.');
                    setTransferStatus(`Uploading: ${progress.successCount}/${progress.totalFiles} files (${Math.round(progress.progress)}%)`);
                    if (progress.status === 'completed') { completed = true; break; }
                    if (progress.status === 'failed' || progress.status === 'partial_fail') throw new Error(`Upload finished with ${progress.failedCount} failed file${progress.failedCount === 1 ? '' : 's'}.`);
                    await new Promise((resolve) => window.setTimeout(resolve, 1000));
                }
            }
            if (!completed) throw new Error('Upload progress timed out.');
            showSuccess(`Uploaded ${items.length} file${items.length === 1 ? '' : 's'} and ${directories.length} folder${directories.length === 1 ? '' : 's'}.`);
            loadFiles(currentPath); loadTreeChildren(locationId, '', true);
        } catch (requestError) { setError(requestError.message); setTransferStatus(''); }
        finally { setLoading(false); }
    };

    const confirmUpload = async (upload) => {
        if (!upload.files.length && !upload.directories.length) return;
        const answer = window.confirm(`Upload ${upload.files.length} file${upload.files.length === 1 ? '' : 's'} and ${upload.directories.length} folder${upload.directories.length === 1 ? '' : 's'} to ${currentPath ? `/${currentPath}` : '/'}?`);
        if (answer) await uploadFiles(upload.files, upload.directories);
    };

    const upload = async (event) => {
        const uploadItems = Array.from(event.target.files || []).map((file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
        event.target.value = '';
        await uploadFiles(uploadItems);
    };

    const handleExternalDrop = async (event) => {
        if (!Array.from(event.dataTransfer.types || []).includes('Files') || dragItems.length) return;
        event.preventDefault(); event.stopPropagation();
        await confirmUpload(await collectDroppedUpload(event.dataTransfer));
    };

    const handleExternalDragOver = (event) => {
        if (Array.from(event.dataTransfer.types || []).includes('Files') && !dragItems.length) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        }
    };
    const isExternalFileDrag = (event) => Array.from(event.dataTransfer.types || []).includes('Files') && !dragItems.length;
    const createShare = async (event) => {
        event.preventDefault(); const file = selectedItems[0]; if (!file) return;
        try {
            const response = await fetch('/api/files/share', { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ locationId, filePath: file.path, expiresIn: Number(event.target.expiresIn.value), maxDownloads: Number(event.target.maxDownloads.value) }) });
            const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Could not create share link.'); setShareLink(data.data.fullUrl); showSuccess('Share link created.');
        } catch (requestError) { setError(requestError.message); }
    };
    const savePassword = async (event) => {
        event.preventDefault();
        const currentPassword = event.target.currentPassword.value;
        const newPassword = event.target.newPassword.value;
        const confirmPassword = event.target.confirmPassword.value;
        if (newPassword !== confirmPassword) {
            setError('The new passwords do not match.');
            return;
        }
        try {
            const response = await fetch('/auth/change-password', { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword, newPassword }) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Could not change password.');
            setModal(null);
            onLogout();
        } catch (requestError) { setError(requestError.message); }
    };
    const crumbs = currentPath ? currentPath.split('/').filter(Boolean) : [];
    const openContext = (event, file) => { event.preventDefault(); event.stopPropagation(); setSelected((items) => items.includes(itemKey(file)) ? items : [itemKey(file)]); setContext({ x: event.clientX, y: event.clientY }); };
    const action = (fn) => { setContext(null); fn(); };

    const renderFileItem = (file) => {
        const isDropTarget = file.isDirectory && fileDropTarget === itemKey(file);
        const dropHandlers = file.isDirectory ? {
            onDragOver: (event) => {
                if (isExternalFileDrag(event)) {
                    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setFileDropTarget(itemKey(file));
                    return;
                }
                if (isValidMoveTarget(dragItems, file.path, locationId)) {
                    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setFileDropTarget(itemKey(file));
                }
            },
            onDragLeave: () => setFileDropTarget(null),
            onDrop: (event) => {
                if (isExternalFileDrag(event)) {
                    void handleExternalDrop(event);
                    return;
                }
                event.preventDefault(); endDrag(); moveItems(dragItems, file.path, locationId);
            }
        } : {};
        const sharedProps = { draggable: true, onDragStart: (event) => beginDrag(event, file), onDragEnd: endDrag, onClick: (event) => choose(file, event), onDoubleClick: () => file.isDirectory ? openFolder(file) : download([file]), onContextMenu: (event) => openContext(event, file), ...dropHandlers };
        if (viewMode === 'grid') {
            return <article key={itemKey(file)} tabIndex="0" className={`file-tile ${selected.includes(itemKey(file)) ? 'selected' : ''} ${isDropTarget ? 'drop-target' : ''}`} {...sharedProps}><span className="tile-icon">{fileIcon(file)}</span><strong>{file.name}</strong><span>{file.type || fileType(file)}</span><small>{file.isDirectory ? 'Drop files here' : formatSize(file.size)}</small></article>;
        }
        return <tr key={itemKey(file)} tabIndex="0" className={`file-row ${selected.includes(itemKey(file)) ? 'selected' : ''} ${isDropTarget ? 'drop-target' : ''}`} {...sharedProps}><td><span className="file-name-cell"><span className="file-icon">{fileIcon(file)}</span>{file.name}</span></td><td className="muted">{formatDate(file.modified || file.modifiedTime)}</td><td className="muted">{file.type || fileType(file)}</td><td className="muted">{file.isDirectory ? '--' : formatSize(file.size)}</td></tr>;
    };

     const renderTree = (requestedLocationId = locationId, onChooseDestination) => {
         const tree = locationTrees[requestedLocationId] || { path: '', name: '/', expanded: true, loaded: false, children: [] };
         return <FolderTree node={tree} currentPath={requestedLocationId === locationId ? currentPath : ''} dragItems={dragItems} dropTarget={dropTarget} onChooseDestination={onChooseDestination} onToggle={(node) => toggleFolder(requestedLocationId, node)} onNavigate={(path) => { selectLocation(requestedLocationId); loadFiles(path, requestedLocationId); }} onDragOver={(event, node) => { if (isExternalFileDrag(event)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setDropTarget(node.path); return; } if (isValidMoveTarget(dragItems, node.path, requestedLocationId)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(node.path); scheduleTreeExpand(requestedLocationId, node); } }} onDragLeave={() => setDropTarget(null)} onDrop={(event, node) => { if (isExternalFileDrag(event)) { void handleExternalDrop(event); return; } event.preventDefault(); endDrag(); moveItems(dragItems, node.path, requestedLocationId); }} />;
      };
      const renderLocationTree = (requestedLocationId) => {
          const tree = locationTrees[requestedLocationId];
          if (!tree || !tree.loaded) return <span className="tree-loading">Loading folders...</span>;
          return <div className="tree-children">{tree.children.map((node) => <FolderTree key={node.path} node={node} currentPath={requestedLocationId === locationId ? currentPath : ''} dragItems={dragItems} dropTarget={dropTarget} onToggle={(child) => toggleFolder(requestedLocationId, child)} onNavigate={(path) => { selectLocation(requestedLocationId); loadFiles(path, requestedLocationId); }} onDragOver={(event, child) => { if (isValidMoveTarget(dragItems, child.path, requestedLocationId)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(child.path); scheduleTreeExpand(requestedLocationId, child); } }} onDragLeave={() => setDropTarget(null)} onDrop={(event, child) => { event.preventDefault(); endDrag(); moveItems(dragItems, child.path, requestedLocationId); }} />)}</div>;
      };

    return <div className="explorer" onContextMenu={(event) => event.preventDefault()}>
        <header className="titlebar"><span className="app-mark" /><span className="app-name">LAB File Manager</span><span className="connection-status">SECURE STORAGE</span><div className="account-control" ref={accountRef}><button className="account" onClick={(event) => { event.stopPropagation(); setAccountOpen((open) => !open); }} aria-expanded={accountOpen}>{user.username}<span className="account-role">{user.role === 'admin' ? 'Admin' : 'User'}</span><span className="account-chevron">⌄</span></button>{accountOpen && <div className="account-menu"><div className="account-summary"><strong>{user.username}</strong><span>{user.role === 'admin' ? 'System administrator' : 'Standard user'}</span></div>{user.role === 'admin' && <button onClick={() => window.location.assign('/admin')}>Admin console</button>}<button onClick={() => { setAccountOpen(false); setModal('password'); }}>Change password</button><hr /><button className="danger" onClick={onLogout}>Log out</button></div>}</div></header>
         <nav className="commandbar">
             <button className="primary" disabled={!hasCapability('upload')} onClick={() => inputRef.current.click()}>Upload</button><input ref={inputRef} type="file" multiple hidden onChange={upload} />
             <button disabled={!hasCapability('mkdir')} onClick={() => setModal('folder')}>New folder</button><span className="divider" />
              <button disabled={!selectedItems.length || downloading || !hasCapability('read')} onClick={() => download()}>{downloading ? 'Preparing download...' : 'Download'}</button><label className="archive-format-control">Archive<select value={archiveFormat} onChange={(event) => setArchiveFormat(event.target.value)}><option value="tar.gz">tar.gz</option><option value="zip">zip</option></select></label><button disabled={!selectedItems.length || moving || !hasCapability('move')} onClick={() => setModal('move')}>Move</button><button disabled={selectedItems.length !== 1 || !hasCapability('rename')} onClick={() => setModal('rename')}>Rename</button>
             <button className="optional" disabled={selectedItems.length !== 1 || selectedItems[0].isDirectory || !hasCapability('share')} onClick={() => { setShareLink(''); setModal('share'); }}>Share</button><button disabled={!selectedItems.length || !hasCapability('delete')} onClick={remove}>Delete</button><span className="divider" />
             <button className="optional" onClick={selectAll}>Select all</button><span className="view-switch" aria-label="File view"><button className={viewMode === 'details' ? 'active' : ''} onClick={() => setViewMode('details')}>Details</button><button className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')}>Grid</button></span><button onClick={() => { loadLocations(); loadFiles(currentPath); }}>Refresh</button>
        </nav>
         <div className="navigation"><button className="nav-button" aria-label="Go up" disabled={!currentPath && !searching} onClick={goUp}>↑</button><div className="crumbs"><button onClick={() => loadFiles('')}>/</button>{crumbs.map((part, index) => <React.Fragment key={`${part}-${index}`}><span className="crumb-separator">›</span><button onClick={() => loadFiles(crumbs.slice(0, index + 1).join('/'))}>{part}</button></React.Fragment>)}</div><div className="search-control"><input className="search" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') searchFiles(); if (event.key === 'Escape') clearSearch(); }} placeholder="Search files" aria-label="Search files" />{(search || searching) && <button className="clear-search" onClick={clearSearch} aria-label="Clear search">×</button>}</div></div>
          <main className="workspace"><aside className="sidebar"><span className="sidebar-label">Locations</span>{locationsLoading && locations.length === 0 ? <span className="tree-loading">Loading Locations...</span> : locations.map((location) => <section className="location-section" key={location.id}><div className={`tree-node ${location.id === locationId ? 'active' : ''}`} onDragOver={(event) => { if (isExternalFileDrag(event)) return; if (isValidMoveTarget(dragItems, '', location.id)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(`${location.id}:`); } }} onDragLeave={() => setDropTarget(null)} onDrop={(event) => { if (isExternalFileDrag(event)) return; event.preventDefault(); endDrag(); moveItems(dragItems, '', location.id); }}><button className="tree-toggle" aria-label={`${expandedLocations[location.id] ? 'Collapse' : 'Expand'} ${location.displayName}`} onClick={() => toggleLocation(location.id)}>{expandedLocations[location.id] ? '−' : '+'}</button><button className={`tree-folder ${dropTarget === `${location.id}:` ? 'drop-target' : ''}`} onClick={() => selectLocation(location.id)}><span className="folder-mini" />{location.displayName}</button><span className={`location-status-dot ${location.status === 'online' ? 'online' : ''}`} title={location.status || 'unknown'} aria-label={location.status || 'unknown'} /></div>{expandedLocations[location.id] && renderLocationTree(location.id)}</section>)}</aside>
             <section className="content" onDragOver={handleExternalDragOver} onDrop={handleExternalDrop}><div className="content-heading"><div><span className="eyebrow">CURRENT DIRECTORY</span><h1>{displayPath}</h1></div>{selectedItems.length > 0 && <span className="selection-count">{selectedItems.length} selected</span>}</div>{error && <div className="notice error-notice">{error}</div>}{transferStatus && <div className="notice transfer-notice"><span className={downloading || moving ? 'activity-dot' : ''} />{transferStatus}</div>}
                <div className="file-area" onClick={(event) => { if (event.target === event.currentTarget) setSelected([]); }}>{loading ? <div className="empty"><span className="loading-orbit" /><strong>Loading files...</strong></div> : files.length === 0 ? <div className="empty"><strong>{searching ? 'No matching files' : 'This folder is empty'}</strong><span>{searching ? 'Try a different search term.' : 'Upload files or create a folder to get started.'}</span></div> : viewMode === 'grid' ? <div className="file-grid" onClick={(event) => { if (event.target === event.currentTarget) setSelected([]); }}>{files.map(renderFileItem)}</div> : <table className="file-table"><thead><tr><th>Name</th><th>Date modified</th><th>Type</th><th>Size</th></tr></thead><tbody>{files.map(renderFileItem)}</tbody></table>}</div>
            </section></main>
        <footer className="statusbar"><span>{files.length} item{files.length === 1 ? '' : 's'}</span><span>{searching ? 'Search results' : currentPath ? `/${currentPath}` : '/'}</span></footer>
         {context && <div className="context-menu" style={{ left: context.x, top: context.y }} onClick={(event) => event.stopPropagation()}><button disabled={downloading || !hasCapability('read')} onClick={() => action(download)}>Download</button><button disabled={moving || !hasCapability('move')} onClick={() => action(() => setModal('move'))}>Move</button><button disabled={selectedItems.length !== 1 || !hasCapability('rename')} onClick={() => action(() => setModal('rename'))}>Rename</button><button disabled={selectedItems.length !== 1 || selectedItems[0].isDirectory || !hasCapability('share')} onClick={() => action(() => { setShareLink(''); setModal('share'); })}>Share</button><hr /><button disabled={!hasCapability('delete')} onClick={() => action(remove)}>Delete</button></div>}
        {modal === 'folder' && <Dialog title="New folder" onClose={() => setModal(null)}><form onSubmit={saveFolder}><p>Create a folder in {currentPath ? `/${currentPath}` : '/'}.</p><label>Folder name<input name="folderName" autoFocus required /></label><DialogActions onClose={() => setModal(null)} label="Create" /></form></Dialog>}
         {modal === 'move' && <Dialog title="Move selected items" onClose={() => setModal(null)}><p>Choose a destination. You cannot move an item into its current folder or one of its own subfolders.</p><div className="move-tree">{locations.map((location) => <section key={location.id}><strong>{location.displayName}</strong>{renderTree(location.id, (node) => moveItems(selectedItems, node.path, location.id))}</section>)}</div><div className="modal-actions"><button type="button" onClick={() => setModal(null)}>Cancel</button></div></Dialog>}
        {modal === 'password' && <Dialog title="Change password" onClose={() => setModal(null)}><form onSubmit={savePassword}><p>Changing your password signs this device out.</p><label>Current password<input name="currentPassword" type="password" autoFocus required /></label><label>New password<input name="newPassword" type="password" minLength="6" required /></label><label>Confirm new password<input name="confirmPassword" type="password" minLength="6" required /></label><DialogActions onClose={() => setModal(null)} label="Change password" /></form></Dialog>}
        {modal === 'rename' && selectedItems[0] && <Dialog title="Rename" onClose={() => setModal(null)}><form onSubmit={saveRename}><p>Rename {selectedItems[0].name}.</p><label>New name<input name="newName" defaultValue={selectedItems[0].name} autoFocus required /></label><DialogActions onClose={() => setModal(null)} label="Rename" /></form></Dialog>}
        {modal === 'share' && selectedItems[0] && <Dialog title="Share file" onClose={() => setModal(null)}>{shareLink ? <><p>Anyone with this link can download {selectedItems[0].name}.</p><input value={shareLink} readOnly onFocus={(event) => event.target.select()} /><div className="modal-actions"><button onClick={() => navigator.clipboard.writeText(shareLink)}>Copy link</button><button className="confirm" onClick={() => setModal(null)}>Done</button></div></> : <form onSubmit={createShare}><p>Create a download link for {selectedItems[0].name}.</p><label>Expires<select name="expiresIn" defaultValue="86400"><option value="3600">In 1 hour</option><option value="86400">In 1 day</option><option value="604800">In 7 days</option><option value="0">Never</option></select></label><label>Downloads<select name="maxDownloads" defaultValue="0"><option value="0">Unlimited</option><option value="1">1 download</option><option value="10">10 downloads</option><option value="100">100 downloads</option></select></label><DialogActions onClose={() => setModal(null)} label="Create link" /></form>}</Dialog>}
    </div>;
};

const FolderTree = ({ node, currentPath, dragItems, dropTarget, onChooseDestination, onToggle, onNavigate, onDragOver, onDragLeave, onDrop }) => <div className="folder-tree"><div className={`tree-node ${currentPath === node.path ? 'active' : ''} ${dropTarget === node.path ? 'drop-target' : ''}`} onDragOver={(event) => onDragOver(event, node)} onDragLeave={onDragLeave} onDrop={(event) => onDrop(event, node)}><button className="tree-toggle" aria-label={`${node.expanded ? 'Collapse' : 'Expand'} ${node.name}`} onClick={() => onToggle(node)}>{node.expanded ? '−' : '+'}</button><button className="tree-folder" onClick={() => onChooseDestination ? onChooseDestination(node) : onNavigate(node.path)}><span className="folder-mini" />{node.name}</button>{dragItems.length > 0 && dropTarget === node.path && <span className="drop-label">Move here</span>}</div>{node.expanded && <div className="tree-children">{node.loaded ? node.children.map((child) => <FolderTree key={child.path} node={child} currentPath={currentPath} dragItems={dragItems} dropTarget={dropTarget} onChooseDestination={onChooseDestination} onToggle={onToggle} onNavigate={onNavigate} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} />) : <span className="tree-loading">Loading folders...</span>}</div>}</div>;

const Dialog = ({ title, onClose, children }) => <div className="modal-cover" onMouseDown={onClose}><div className="modal" onMouseDown={(event) => event.stopPropagation()}><h2>{title}</h2>{children}</div></div>;
const DialogActions = ({ onClose, label }) => <div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="confirm" type="submit">{label}</button></div>;
