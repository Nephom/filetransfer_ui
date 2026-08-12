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
const fileTimestamp = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
};
const formatRate = (bytesPerSecond) => {
    if (!bytesPerSecond || bytesPerSecond < 1) return '--';
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let value = bytesPerSecond;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
};
const compareFileNames = (left, right) => String(left || '').localeCompare(String(right || ''), undefined, { numeric: true, sensitivity: 'base' });
const compareFiles = (left, right, key, direction, directoriesFirst = false) => {
    if (directoriesFirst && Boolean(left.isDirectory) !== Boolean(right.isDirectory)) return left.isDirectory ? -1 : 1;
    let result = key === 'modified'
        ? fileTimestamp(left.modified) - fileTimestamp(right.modified)
        : key === 'size'
            ? (Number(left.size) || 0) - (Number(right.size) || 0)
            : compareFileNames(left.name, right.name);
    if (!result) result = compareFileNames(left.name, right.name) || String(left.path || '').localeCompare(String(right.path || ''));
    return direction === 'desc' ? -result : result;
};
const sortFiles = (items, key = 'name', direction = 'asc', directoriesFirst = false) => [...items].sort((left, right) => compareFiles(left, right, key, direction, directoriesFirst));
const fileType = (item) => {
    if (item.isDirectory) return 'File folder';
    const extension = item.name?.split('.').pop();
    return extension && extension !== item.name ? `${extension.toUpperCase()} file` : 'File';
};
const classifyTransferError = (error) => {
    const message = String(error?.message || error || '').toLowerCase();
    const status = Number(error?.status || error?.statusCode || message.match(/\b(401|403|404|409|5\d\d)\b/)?.[1] || 0);
    if (status >= 500) return 'server_error';
    if (message.includes('401') || message.includes('unauthor')) return 'authentication';
    if (message.includes('403') || message.includes('permission')) return 'permission';
    if (message.includes('404') || message.includes('not found')) return 'source_missing';
    if (message.includes('409') || message.includes('conflict')) return 'conflict';
    if (message.includes('source changed') || message.includes('modified after')) return 'source_changed';
    if (message.includes('destination') && (message.includes('unavailable') || message.includes('missing'))) return 'destination_unavailable';
    if (message.includes('invalid') || message.includes('validation')) return 'validation';
    if (message.includes('timeout') || message.includes('timed out')) return 'timeout';
    if (message.includes('network') || message.includes('connect') || message.includes('fetch')) return 'network';
    if (message.includes('cancel')) return 'cancelled';
    return 'unknown';
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
    const [createdShareLinks, setCreatedShareLinks] = React.useState(null);
    const [shareLinks, setShareLinks] = React.useState([]);
    const [shareLinksLoading, setShareLinksLoading] = React.useState(false);
    const [locationTrees, setLocationTrees] = React.useState({});
    const [dragItems, setDragItems] = React.useState([]);
    const [dropTarget, setDropTarget] = React.useState(null);
    const [fileDropTarget, setFileDropTarget] = React.useState(null);
    const [viewMode, setViewMode] = React.useState(() => localStorage.getItem('file-view-mode') || 'details');
    const [archiveFormat, setArchiveFormat] = React.useState(() => localStorage.getItem('archive-format') || 'tar.gz');
    const [sortKey, setSortKey] = React.useState('name');
    const [sortDirection, setSortDirection] = React.useState('asc');
    const [downloadModeDraft, setDownloadModeDraft] = React.useState('tar.gz');
    const [queueItems, setQueueItems] = React.useState([]);
    const [queueOpen, setQueueOpen] = React.useState(false);
    const [accountOpen, setAccountOpen] = React.useState(false);
    const inputRef = React.useRef(null);
    const accountRef = React.useRef(null);
    const dragExpandTimer = React.useRef(null);
    const notificationTimer = React.useRef(null);
    const downloadInProgress = React.useRef(false);
    const locationsLoaded = React.useRef(false);
    const locationRefreshInProgress = React.useRef(false);
    const queueItemsRef = React.useRef([]);
    const queueJobsRef = React.useRef(new Map());
    const queueAbortControllersRef = React.useRef(new Map());
    const queueRunningRef = React.useRef(false);
    const queueRetryTimersRef = React.useRef(new Map());
    const queueStoreRef = React.useRef(new window.FileTransferWebQueueStore());
    queueItemsRef.current = queueItems;
    React.useEffect(() => { queueStoreRef.current.replace(queueItems); }, [queueItems]);

    const authHeaders = {
        Authorization: `Bearer ${token}`,
        ...(locationId ? { 'X-Location-ID': locationId } : {})
    };
    const headersForLocation = (requestedLocationId) => ({
        Authorization: `Bearer ${token}`,
        ...(requestedLocationId ? { 'X-Location-ID': requestedLocationId } : {})
    });
    const sortedFiles = sortFiles(files, sortKey, sortDirection);
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
            const response = await fetch(`/api/files?path=${encodeURIComponent(path)}&sort=${encodeURIComponent(sortKey)}&order=${sortDirection}`, { headers: headersForLocation(requestedLocationId) });
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
                .sort((left, right) => compareFileNames(left.name, right.name));
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
        if (!locationId || searching) return;
        loadFiles(currentPath);
    }, [sortKey, sortDirection]);
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
        queueRetryTimersRef.current.forEach((timer) => window.clearTimeout(timer));
        queueRetryTimersRef.current.clear();
        queueAbortControllersRef.current.forEach((controller) => controller.abort());
        queueAbortControllersRef.current.clear();
        queueJobsRef.current.clear();
    }, []);
    React.useEffect(() => { localStorage.setItem('file-view-mode', viewMode); }, [viewMode]);
    React.useEffect(() => { localStorage.setItem('archive-format', archiveFormat); }, [archiveFormat]);

    const activeLocation = locations.find((location) => location.id === locationId);
    const hasCapability = (capability) => activeLocation?.capabilities?.includes(capability) === true;
    const selectLocation = (nextLocationId) => {
        if (nextLocationId === locationId) {
            setCurrentPath('');
            setDisplayPath('/');
            setSelected([]);
            setSearch('');
            setSearching(false);
            setPathBeforeSearch('');
            setContext(null);
            loadFiles('', nextLocationId);
            return;
        }
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

    const loadShareLinks = async () => {
        setShareLinksLoading(true);
        setError('');
        try {
            const response = await fetch('/api/files/shares', { headers: { Authorization: `Bearer ${token}` } });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.message || 'Unable to load share links.');
            const statusRank = (link) => link.isExpired ? 2 : link.isActive ? 0 : 1;
            setShareLinks([...(data.data || [])].sort((left, right) => statusRank(left) - statusRank(right)));
        } catch (requestError) {
            setError(requestError.message);
        } finally {
            setShareLinksLoading(false);
        }
    };

    const openShareLinks = () => {
        if (!hasCapability('share')) return;
        setModal('shareLinks');
        void loadShareLinks();
    };

    const revokeShareLink = async (shareToken) => {
        if (!window.confirm('Revoke this share link? Existing downloads will stop working.')) return;
        try {
            const response = await fetch(`/api/files/share/${encodeURIComponent(shareToken)}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.message || 'Unable to revoke share link.');
            showSuccess('Share link revoked.');
            await loadShareLinks();
        } catch (requestError) {
            setError(requestError.message);
        }
    };

    const deleteExpiredShareLink = async (shareToken) => {
        try {
            const response = await fetch(`/api/files/share/${encodeURIComponent(shareToken)}/history`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.message || 'Unable to remove expired share link.');
            showSuccess('Expired share link removed from history.');
            await loadShareLinks();
        } catch (requestError) {
            setError(requestError.message);
        }
    };

    const deleteRevokedShareLink = async (shareToken) => {
        try {
            const response = await fetch(`/api/files/share/${encodeURIComponent(shareToken)}/history/revoked`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.message || 'Unable to remove revoked share link.');
            showSuccess('Revoked share link removed from history.');
            await loadShareLinks();
        } catch (requestError) {
            setError(requestError.message);
        }
    };

    const shareLinkUrl = (link, kind) => `${window.location.origin}${kind === 'direct' ? link.directDownloadUrl : link.shareUrl}`;
    const copyShareLink = async (link, kind) => {
        await navigator.clipboard.writeText(shareLinkUrl(link, kind));
        showSuccess(`${kind === 'direct' ? 'Direct' : 'Secure'} link copied.`);
    };
    const shareLinkStatus = (link) => link.isExpired ? 'Expired' : link.isExhausted ? 'Exhausted' : link.isActive ? 'Active' : 'Revoked';
    const shareLinkGroups = [
        { key: 'active', label: 'Active', links: shareLinks.filter((link) => shareLinkStatus(link) === 'Active') },
        { key: 'revoked', label: 'Revoked', links: shareLinks.filter((link) => shareLinkStatus(link) === 'Revoked') },
        { key: 'expired', label: 'Expired', links: shareLinks.filter((link) => shareLinkStatus(link) === 'Expired') },
        { key: 'exhausted', label: 'Exhausted', links: shareLinks.filter((link) => shareLinkStatus(link) === 'Exhausted') }
    ].filter((group) => group.links.length > 0);

    const searchFiles = async () => {
        if (!hasCapability('list')) {
            setError('List permission is required to search files.');
            return;
        }
        const query = search.trim();
        if (!query) return loadFiles(searching ? pathBeforeSearch : currentPath);
        setLoading(true); setError(''); setContext(null);
        try {
            if (!searching) setPathBeforeSearch(currentPath);
            const response = await fetch(`/api/files/search?query=${encodeURIComponent(query)}`, { headers: authHeaders });
            const data = await response.json();
            if (!response.ok || data.indexing) throw new Error(data.message || 'Search is not available yet.');
            const results = (data.files || []).filter((file) => file && typeof file.name === 'string' && file.name.trim() && typeof file.path === 'string' && file.path.trim());
            setFiles(sortFiles(results, sortKey, sortDirection)); setDisplayPath(`Search results for "${query}"`); setSearching(true); setSelected([]);
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
        const index = sortedFiles.findIndex((item) => itemKey(item) === key);
        const anchorIndex = selectionAnchor.current === null
            ? -1
            : sortedFiles.findIndex((item) => itemKey(item) === selectionAnchor.current);
        if (event.shiftKey && anchorIndex >= 0 && index >= 0) {
            const start = Math.min(anchorIndex, index);
            const end = Math.max(anchorIndex, index);
            setSelected(sortedFiles.slice(start, end + 1).map(itemKey));
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
    const updateQueueItem = (id, patch) => {
        const next = queueItemsRef.current.map((item) => {
            if (item.id !== id) return item;
            if (item.status === 'cancelled' && patch.status && patch.status !== 'cancelled') return item;
            return { ...item, ...patch };
        });
        queueItemsRef.current = next;
        queueStoreRef.current.replace(next);
        setQueueItems(next);
    };
    const pruneQueueItems = () => {
        const now = Date.now();
        const policies = {
            completed: { max: 20, ttl: 24 * 60 * 60 * 1000 },
            cancelled: { max: 10, ttl: 24 * 60 * 60 * 1000 },
            failed: { max: 20, ttl: 7 * 24 * 60 * 60 * 1000 }
        };
        const next = [];
        Object.keys(policies).forEach((status) => {
            const policy = policies[status];
            queueItemsRef.current.filter((item) => item.status === status)
                .sort((left, right) => (right.finishedAt || 0) - (left.finishedAt || 0))
                .filter((item, index) => index < policy.max && (!item.finishedAt || now - item.finishedAt < policy.ttl))
                .forEach((item) => next.push(item));
        });
        queueItemsRef.current.filter((item) => !policies[item.status]).forEach((item) => next.push(item));
        queueItemsRef.current = next;
        setQueueItems(next);
    };
    const finishQueueItem = (id, status, detail) => {
        if (queueItemsRef.current.find((item) => item.id === id)?.status === 'cancelled') return;
        updateQueueItem(id, { status, detail, finishedAt: Date.now() });
        if (!['failed', 'needs_user_action'].includes(status)) queueJobsRef.current.delete(id);
        window.setTimeout(pruneQueueItems, 0);
    };
    const runNextQueueItem = async () => {
        if (queueRunningRef.current) return;
        const item = queueItemsRef.current.find((candidate) => candidate.status === 'queued');
        if (!item) return;
        const job = queueJobsRef.current.get(item.id);
        if (!job) {
            finishQueueItem(item.id, 'failed', 'Queue executor is unavailable.');
            return;
        }
        queueRunningRef.current = true;
        const controller = new AbortController();
        queueAbortControllersRef.current.set(item.id, controller);
        updateQueueItem(item.id, { status: 'running', detail: 'Preparing transfer...' });
        setDownloading(true);
        let retryScheduled = false;
        try {
            const detail = await job(item.id, controller.signal);
            finishQueueItem(item.id, 'completed', detail || 'Transfer completed.');
        } catch (requestError) {
            if (controller.signal.aborted) {
                finishQueueItem(item.id, 'cancelled', 'Cancelled by user.');
                return;
            }
            const category = classifyTransferError(requestError);
            const retryCount = item.retryCount || 0;
            const retryable = ['network', 'timeout', 'server_error'].includes(category) && retryCount < 3;
            if (retryable) {
                retryScheduled = true;
                updateQueueItem(item.id, { status: 'retrying', retryCount: retryCount + 1, detail: `[${category}] Retry ${retryCount + 1}/3 scheduled`, errorCategory: category });
                const timer = window.setTimeout(() => {
                    queueRetryTimersRef.current.delete(item.id);
                    if (queueItemsRef.current.find((candidate) => candidate.id === item.id)?.status !== 'retrying') return;
                    updateQueueItem(item.id, { status: 'queued', detail: 'Retry starting' });
                    void runNextQueueItem();
                }, Math.min(30_000, 1000 * (2 ** retryCount)));
                queueRetryTimersRef.current.set(item.id, timer);
            } else {
                updateQueueItem(item.id, { errorCategory: category });
                const needsUserAction = ['authentication', 'permission', 'conflict', 'source_missing', 'source_changed', 'destination_unavailable', 'validation', 'unknown'].includes(category);
                finishQueueItem(item.id, needsUserAction ? 'needs_user_action' : 'failed', `[${category}] ${requestError.message || 'Transfer failed.'}`);
            }
        } finally {
            queueRunningRef.current = false;
            queueAbortControllersRef.current.delete(item.id);
            setDownloading(false);
            if (!retryScheduled) void runNextQueueItem();
        }
    };
    const enqueueTransfer = (item, job) => {
        queueJobsRef.current.set(item.id, job);
        const next = [...queueItemsRef.current, item];
        queueItemsRef.current = next;
        setQueueItems(next);
        setQueueOpen(true);
        void runNextQueueItem();
    };
    const streamResponse = async (id, response, totalBytes = null) => {
        if (!response.body) return response.blob();
        const reader = response.body.getReader();
        const chunks = [];
        let completedBytes = 0;
        const samples = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            completedBytes += value.byteLength;
            const now = Date.now();
            samples.push({ bytes: completedBytes, at: now });
            while (samples.length > 1 && now - samples[0].at > 3000) samples.shift();
            const oldest = samples[0];
            const elapsed = oldest ? now - oldest.at : 0;
            if (elapsed >= 300) {
                const bytesPerSecond = oldest ? (completedBytes - oldest.bytes) / (elapsed / 1000) : 0;
                const percentage = totalBytes ? Math.min(100, completedBytes / totalBytes * 100) : null;
                const eta = totalBytes && bytesPerSecond > 0 ? (totalBytes - completedBytes) / bytesPerSecond : null;
                updateQueueItem(id, {
                    detail: `Downloading ${formatSize(completedBytes)}${totalBytes ? ` / ${formatSize(totalBytes)}` : ''}${percentage === null ? '' : ` (${Math.round(percentage)}%)`} · ${formatRate(bytesPerSecond)}${eta === null ? '' : ` · ETA ${Math.ceil(eta)}s`}`,
                    progress: { completedBytes, totalBytes, percentage, bytesPerSecond, etaSeconds: eta, completedItems: 0, totalItems: 1, updatedAt: now }
                });
            }
        }
        const percentage = totalBytes ? Math.min(100, completedBytes / totalBytes * 100) : null;
        updateQueueItem(id, {
            detail: `Transferred ${formatSize(completedBytes)}${totalBytes ? ` / ${formatSize(totalBytes)}` : ''}${percentage === null ? '' : ` (${Math.round(percentage)}%)`}`,
            progress: { completedBytes, totalBytes, percentage, bytesPerSecond: null, etaSeconds: null, completedItems: 0, totalItems: 1, updatedAt: Date.now() }
        });
        return new Blob(chunks);
    };
    const download = (items = selectedItems) => {
        if (!items.length) return;
        const isArchive = items.length > 1 || items[0].isDirectory;
        const id = `queue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const label = isArchive ? `${items.length} selected items` : items[0].name;
        const totalBytes = !isArchive ? Number(items[0].size) || null : null;
        enqueueTransfer({ id, label, status: 'queued', detail: 'Waiting to start', kind: 'download', finishedAt: null, progress: { completedBytes: 0, totalBytes, percentage: totalBytes ? 0 : null, bytesPerSecond: null, etaSeconds: null, completedItems: 0, totalItems: 1, updatedAt: Date.now() } }, async (queueId, signal) => {
            const response = isArchive
                ? await fetch('/api/archive', { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items.map(({ name, isDirectory, path }) => ({ name, isDirectory, path })), currentPath, format: archiveFormat }), signal })
                : await fetch(`/api/files/download/${encodeURIComponent(items[0].path)}`, { headers: authHeaders, signal });
            if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || (isArchive ? 'Archive download failed.' : 'Download failed.'));
            const disposition = response.headers.get('Content-Disposition') || '';
            const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i);
            const blob = await streamResponse(queueId, response, Number(response.headers.get('Content-Length')) || totalBytes);
            downloadBlob(blob, isArchive ? (match ? decodeURIComponent(match[1]) : `archive.${archiveFormat}`) : items[0].name);
            return `Downloaded ${label}.`;
        });
    };

    // "Queue" download mode: fetch every individual file under the selection
    // (via /api/files/flatten) and track each one in the Transfer Queue,
    // instead of always bundling the selection into a single archive first.
    const supportsDirectoryPicker = () => typeof window.showDirectoryPicker === 'function';

    const writeFileIntoDirectoryHandle = async (rootHandle, relativePath, blob) => {
        const segments = relativePath.split('/').filter(Boolean);
        const fileName = segments.pop();
        let directoryHandle = rootHandle;
        for (const segment of segments) {
            directoryHandle = await directoryHandle.getDirectoryHandle(segment, { create: true });
        }
        const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
    };

    const enqueueQueueDownload = async (items) => {
        const id = `queue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const label = items.length === 1 ? items[0].name : `${items.length} selected items`;
        setModal(null);
        enqueueTransfer({ id, label, status: 'queued', detail: 'Waiting to prepare file list...', kind: 'download-set', finishedAt: null }, async (queueId, signal) => {
            updateQueueItem(queueId, { detail: 'Preparing file list...' });
            const flattenResponse = await fetch('/api/files/flatten', {
                method: 'POST',
                headers: { ...authHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: items.map(({ name, isDirectory, path }) => ({ name, isDirectory, path })), currentPath })
            });
            const flattenData = await flattenResponse.json().catch(() => ({}));
            if (!flattenResponse.ok) throw new Error(flattenData.error || 'Unable to list files for the queue.');
            const targetFiles = flattenData.files || [];
            if (!targetFiles.length) throw new Error('The selection has no files to download.');
            const totalBytes = targetFiles.reduce((sum, file) => sum + (Number(file.size) || 0), 0) || null;

            let directoryHandle = null;
            const useFileSystemAccess = supportsDirectoryPicker();
            if (useFileSystemAccess) {
                try {
                    directoryHandle = await window.showDirectoryPicker();
                } catch (pickerError) {
                    throw new Error('Destination folder selection was cancelled.');
                }
            }

            let completed = 0;
            for (const file of targetFiles) {
                updateQueueItem(id, { detail: `Downloading ${completed}/${targetFiles.length} files...` });
                const response = await fetch(`/api/files/download/${encodeURIComponent(file.remotePath)}`, { headers: authHeaders, signal });
                if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Failed to download ${file.relativePath}.`);
                const blob = await streamResponse(queueId, response, Number(response.headers.get('Content-Length')) || file.size || null);
                if (directoryHandle) {
                    await writeFileIntoDirectoryHandle(directoryHandle, file.relativePath, blob);
                } else {
                    // No File System Access API support (Firefox/Safari): fall
                    // back to individual browser downloads. Folder structure
                    // cannot be preserved this way, so flatten the name.
                    downloadBlob(blob, file.relativePath.replace(/\//g, '_'));
                    await new Promise((resolve) => window.setTimeout(resolve, 150));
                }
                completed += 1;
                const completedBytes = targetFiles.slice(0, completed).reduce((sum, current) => sum + (Number(current.size) || 0), 0);
                const percentage = totalBytes ? completedBytes / totalBytes * 100 : null;
                updateQueueItem(id, { detail: `Downloading ${completed}/${targetFiles.length} files${percentage === null ? '' : ` (${Math.round(percentage)}%)`}`, progress: { completedBytes, totalBytes, percentage, bytesPerSecond: null, etaSeconds: null, completedItems: completed, totalItems: targetFiles.length, updatedAt: Date.now() } });
            }
            return directoryHandle ? `Downloaded ${completed} file(s) into the selected folder.` : `Downloaded ${completed} file(s) individually (folder structure not preserved in this browser).`;
        });
    };
    const cancelQueueItem = (id) => {
        const item = queueItemsRef.current.find((candidate) => candidate.id === id);
        if (!item || !['queued', 'running', 'retrying'].includes(item.status)) return;
        const controller = queueAbortControllersRef.current.get(id);
        controller?.abort();
        const retryTimer = queueRetryTimersRef.current.get(id);
        if (retryTimer) window.clearTimeout(retryTimer);
        queueRetryTimersRef.current.delete(id);
        queueJobsRef.current.delete(id);
        updateQueueItem(id, { status: 'cancelled', detail: 'Cancelled by user.', finishedAt: Date.now() });
        window.setTimeout(pruneQueueItems, 0);
    };
    const retryQueueItem = (id) => {
        const item = queueItemsRef.current.find((candidate) => candidate.id === id);
        if (!item || !['failed', 'needs_user_action'].includes(item.status) || !queueJobsRef.current.has(id)) return;
        updateQueueItem(id, { status: 'queued', detail: 'Retry queued', finishedAt: null });
        void runNextQueueItem();
    };
    const removeQueueItem = (id) => {
        const item = queueItemsRef.current.find((candidate) => candidate.id === id);
        if (item && ['queued', 'running', 'retrying'].includes(item.status)) {
            cancelQueueItem(id);
            return;
        }
        queueJobsRef.current.delete(id);
        const next = queueItemsRef.current.filter((item) => item.id !== id);
        queueItemsRef.current = next;
        setQueueItems(next);
    };
    const clearQueueHistory = () => {
        const next = queueItemsRef.current.filter((item) => !['completed', 'failed', 'cancelled'].includes(item.status));
        queueItemsRef.current = next;
        setQueueItems(next);
    };
    const clearQueueStatus = (status) => {
        const next = queueItemsRef.current.filter((item) => item.status !== status);
        queueItemsRef.current = next;
        setQueueItems(next);
    };
    const uploadFormData = (queueId, data, totalBytes, signal) => new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('POST', '/api/upload/multiple');
        Object.entries(authHeaders).forEach(([name, value]) => request.setRequestHeader(name, value));
        const samples = [];
        request.upload.onprogress = (event) => {
            if (!event.lengthComputable) {
                updateQueueItem(queueId, { detail: 'Uploading file data... total size is being determined.' });
                return;
            }
            const now = Date.now();
            samples.push({ bytes: event.loaded, at: now });
            while (samples.length > 1 && now - samples[0].at > 3000) samples.shift();
            const oldest = samples[0];
            const bytesPerSecond = oldest && now > oldest.at
                ? (event.loaded - oldest.bytes) / ((now - oldest.at) / 1000)
                : null;
            const eta = bytesPerSecond && totalBytes ? Math.max(0, (totalBytes - event.loaded) / bytesPerSecond) : null;
            const percentage = event.total > 0 ? event.loaded / event.total * 100 : null;
            updateQueueItem(queueId, {
                detail: `Uploading file data ${formatSize(event.loaded)} / ${formatSize(event.total)}${percentage === null ? '' : ` (${Math.round(percentage)}%)`}${bytesPerSecond ? ` · ${formatRate(bytesPerSecond)}` : ''}${eta ? ` · ETA ${Math.ceil(eta)}s` : ''}`,
                progress: { completedBytes: event.loaded, totalBytes: totalBytes || event.total || null, percentage: totalBytes ? event.loaded / totalBytes * 100 : percentage, bytesPerSecond, etaSeconds: eta, completedItems: 0, totalItems: 1, updatedAt: now }
            });
        };
        const abort = () => request.abort();
        signal?.addEventListener('abort', abort, { once: true });
        request.onerror = () => { signal?.removeEventListener('abort', abort); reject(new Error('Upload network request failed.')); };
        request.onabort = () => { signal?.removeEventListener('abort', abort); reject(new Error('Upload request was cancelled.')); };
        request.onload = () => {
            let result = {};
            try { result = JSON.parse(request.responseText || '{}'); } catch { /* handled as an API error below */ }
            if (request.status < 200 || request.status >= 300) {
                reject(new Error(result.error?.message || result.error || 'Upload failed.'));
                return;
            }
            signal?.removeEventListener('abort', abort);
            resolve(result);
        };
        request.send(data);
    });

    const startDownload = () => {
        if (!selectedItems.length) return;
        const isArchive = selectedItems.length > 1 || selectedItems[0].isDirectory;
        if (!isArchive) return download(selectedItems);
        setDownloadModeDraft(archiveFormat);
        setModal('downloadMode');
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
        const id = `queue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const totalBytes = items.reduce((sum, item) => sum + (Number(item.file.size) || 0), 0) || null;
        enqueueTransfer({
            id,
            label: `Upload ${items.length} file${items.length === 1 ? '' : 's'}`,
            status: 'queued',
            detail: 'Waiting to start',
            kind: 'upload',
            finishedAt: null,
            progress: { completedBytes: 0, totalBytes, percentage: totalBytes ? 0 : null, bytesPerSecond: null, etaSeconds: null, completedItems: 0, totalItems: items.length, updatedAt: Date.now() }
        }, async (queueId, signal) => {
            const data = new FormData();
            items.forEach(({ file, relativePath }) => {
                data.append('files', file, file.name);
                data.append('filePaths[]', relativePath);
            });
            directories.forEach((directory) => data.append('directoryPaths[]', directory));
            data.append('path', currentPath);
            const result = await uploadFormData(queueId, data, totalBytes, signal);
            let completed = !result.batchId;
            if (result.batchId) {
                for (let attempt = 0; attempt < 600; attempt += 1) {
                    const progressResponse = await fetch(`/api/progress/batch/${encodeURIComponent(result.batchId)}`, { headers: authHeaders, signal });
                    const progress = await progressResponse.json().catch(() => ({}));
                    if (!progressResponse.ok) throw new Error(progress.error || 'Unable to read upload progress.');
                    const completedBytes = totalBytes ? Math.round(totalBytes * (Number(progress.progress) || 0) / 100) : 0;
                    const now = Date.now();
                    updateQueueItem(queueId, {
                        detail: `Uploading ${progress.successCount}/${progress.totalFiles} files (${Math.round(progress.progress)}%)${totalBytes ? ` · ${formatSize(completedBytes)} / ${formatSize(totalBytes)}` : ''}`,
                        progress: { completedBytes, totalBytes, percentage: totalBytes ? Number(progress.progress) : null, bytesPerSecond: null, etaSeconds: null, completedItems: progress.successCount || 0, totalItems: progress.totalFiles || items.length, updatedAt: now }
                    });
                    if (progress.status === 'completed') { completed = true; break; }
                    if (progress.status === 'failed' || progress.status === 'partial_fail') throw new Error(`Upload finished with ${progress.failedCount} failed file${progress.failedCount === 1 ? '' : 's'}.`);
                    await new Promise((resolve) => window.setTimeout(resolve, 1000));
                }
            }
            if (!completed) throw new Error('Upload progress timed out.');
            if (totalBytes) updateQueueItem(queueId, { progress: { completedBytes: totalBytes, totalBytes, percentage: 100, bytesPerSecond: null, etaSeconds: null, completedItems: items.length, totalItems: items.length, updatedAt: Date.now() } });
            loadFiles(currentPath); loadTreeChildren(locationId, '', true);
            return `Uploaded ${items.length} file${items.length === 1 ? '' : 's'} and ${directories.length} folder${directories.length === 1 ? '' : 's'}.`;
        });
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
            const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Could not create share link.'); setCreatedShareLinks({ secure: data.data.fullUrl, direct: data.data.directDownloadFullUrl }); showSuccess('Share links created.');
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
       const renderQueueItem = (item) => <li key={item.id} className={`queue-panel-item queue-status-${item.status}`}><strong>{item.label}</strong><span>{item.detail}</span>{item.progress && <small>{item.progress.completedBytes ? `${formatSize(item.progress.completedBytes)}${item.progress.totalBytes ? ` / ${formatSize(item.progress.totalBytes)}` : ''}` : 'Preparing'}{item.progress.percentage === null ? '' : ` (${Math.round(item.progress.percentage)}%)`}</small>}{['queued', 'running', 'retrying'].includes(item.status) && <button type="button" onClick={() => cancelQueueItem(item.id)}>Cancel</button>}{['failed', 'needs_user_action'].includes(item.status) && <button type="button" onClick={() => retryQueueItem(item.id)}>Retry</button>}{['completed', 'failed', 'cancelled'].includes(item.status) && <button type="button" onClick={() => removeQueueItem(item.id)}>Remove</button>}</li>;

     return <div className="explorer" onContextMenu={(event) => event.preventDefault()}>
             <header className="titlebar"><span className="app-mark" /><span className="app-name">LAB File Manager</span><span className="connection-status">SECURE STORAGE</span><div className="account-control" ref={accountRef}><button className="account" onClick={(event) => { event.stopPropagation(); setAccountOpen((open) => !open); }} aria-expanded={accountOpen}>{user.username}<span className="account-role">{user.role === 'admin' ? 'Admin' : user.role === 'superuser' ? 'Superuser' : 'User'}</span><span className="account-chevron">⌄</span></button>{accountOpen && <div className="account-menu"><div className="account-summary"><strong>{user.username}</strong><span>{user.role === 'admin' ? 'System administrator' : user.role === 'superuser' ? 'Superuser' : 'Standard user'}</span></div>{user.role === 'admin' && <button onClick={() => window.location.assign('/admin')}>Admin console</button>}{user.role === 'superuser' && <button onClick={() => window.location.assign('/super')}>Super Panel</button>}{user.role !== 'admin' && <button onClick={() => { setAccountOpen(false); setModal('password'); }}>Change password</button>}<hr /><button className="danger" onClick={onLogout}>Log out</button></div>}</div></header>
         <nav className="commandbar">
             <button className="primary" disabled={!hasCapability('upload')} onClick={() => inputRef.current.click()}>Upload</button><input ref={inputRef} type="file" multiple hidden onChange={upload} />
             <button disabled={!hasCapability('mkdir')} onClick={() => setModal('folder')}>New folder</button><span className="divider" />
              <button disabled={!selectedItems.length || downloading || !hasCapability('read')} onClick={startDownload}>{downloading ? 'Preparing download...' : 'Download'}</button><button className="optional" onClick={() => setQueueOpen((open) => !open)}>Transfer Queue{queueItems.some((item) => ['queued', 'running', 'retrying'].includes(item.status)) ? ` (${queueItems.filter((item) => ['queued', 'running', 'retrying'].includes(item.status)).length})` : ''}</button><button disabled={!selectedItems.length || moving || !hasCapability('move')} onClick={() => setModal('move')}>Move</button><button disabled={selectedItems.length !== 1 || !hasCapability('rename')} onClick={() => setModal('rename')}>Rename</button>
              <button className="optional" disabled={selectedItems.length !== 1 || selectedItems[0].isDirectory || !hasCapability('share')} onClick={() => { setCreatedShareLinks(null); setModal('share'); }}>Share</button><button disabled={!selectedItems.length || !hasCapability('delete')} onClick={remove}>Delete</button><span className="divider" />
               <button className="optional" onClick={selectAll}>Select all</button><label className="sort-control">Sort<select value={sortKey} onChange={(event) => setSortKey(event.target.value)} aria-label="Sort files"><option value="name">Name</option><option value="modified">Modified</option><option value="size">Size</option><option value="directory">Directory first</option></select><button type="button" onClick={() => setSortDirection((current) => current === 'asc' ? 'desc' : 'asc')} aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}>{sortDirection === 'asc' ? 'Ascending' : 'Descending'}</button></label><span className="view-switch" aria-label="File view"><button className={viewMode === 'details' ? 'active' : ''} onClick={() => setViewMode('details')}>Details</button><button className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')}>Grid</button></span><button className="optional" onClick={openShareLinks}>Share Links</button><button onClick={() => { loadLocations(); loadFiles(currentPath); }}>Refresh</button>
        </nav>
         <div className="navigation"><button className="nav-button" aria-label="Go up" disabled={!currentPath && !searching} onClick={goUp}>↑</button><div className="crumbs"><button onClick={() => loadFiles('')}>/</button>{crumbs.map((part, index) => <React.Fragment key={`${part}-${index}`}><span className="crumb-separator">›</span><button onClick={() => loadFiles(crumbs.slice(0, index + 1).join('/'))}>{part}</button></React.Fragment>)}</div><div className="search-control"><input className="search" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') searchFiles(); if (event.key === 'Escape') clearSearch(); }} placeholder="Search files" aria-label="Search files" />{(search || searching) && <button className="clear-search" onClick={clearSearch} aria-label="Clear search">×</button>}</div></div>
          <main className="workspace"><aside className="sidebar"><span className="sidebar-label">Locations</span>{locationsLoading && locations.length === 0 ? <span className="tree-loading">Loading Locations...</span> : locations.map((location) => <section className="location-section" key={location.id}><div className={`tree-node ${location.id === locationId ? 'active' : ''}`} onDragOver={(event) => { if (isExternalFileDrag(event)) return; if (isValidMoveTarget(dragItems, '', location.id)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(`${location.id}:`); } }} onDragLeave={() => setDropTarget(null)} onDrop={(event) => { if (isExternalFileDrag(event)) return; event.preventDefault(); endDrag(); moveItems(dragItems, '', location.id); }}><button className="tree-toggle" aria-label={`${expandedLocations[location.id] ? 'Collapse' : 'Expand'} ${location.displayName}`} onClick={() => toggleLocation(location.id)}>{expandedLocations[location.id] ? '−' : '+'}</button><button className={`tree-folder ${dropTarget === `${location.id}:` ? 'drop-target' : ''}`} onClick={() => selectLocation(location.id)}><span className="folder-mini" />{location.displayName}</button><span className={`location-status-dot ${location.status === 'online' ? 'online' : ''}`} title={location.status || 'unknown'} aria-label={location.status || 'unknown'} /></div>{expandedLocations[location.id] && renderLocationTree(location.id)}</section>)}</aside>
             <section className="content" onDragOver={handleExternalDragOver} onDrop={handleExternalDrop}><div className="content-heading"><div><span className="eyebrow">CURRENT DIRECTORY</span><h1>{displayPath}</h1></div>{selectedItems.length > 0 && <span className="selection-count">{selectedItems.length} selected</span>}</div>{error && <div className="notice error-notice">{error}</div>}{transferStatus && <div className="notice transfer-notice"><span className={downloading || moving ? 'activity-dot' : ''} />{transferStatus}</div>}
                 <div className="file-area" onClick={(event) => { if (event.target === event.currentTarget) setSelected([]); }}>{loading ? <div className="empty"><span className="loading-orbit" /><strong>Loading files...</strong></div> : files.length === 0 ? <div className="empty"><strong>{searching ? 'No matching files' : 'This folder is empty'}</strong><span>{searching ? 'Try a different search term.' : 'Upload files or create a folder to get started.'}</span></div> : viewMode === 'grid' ? <div className="file-grid" onClick={(event) => { if (event.target === event.currentTarget) setSelected([]); }}>{sortedFiles.map(renderFileItem)}</div> : <table className="file-table"><thead><tr><th>Name</th><th>Date modified</th><th>Type</th><th>Size</th></tr></thead><tbody>{sortedFiles.map(renderFileItem)}</tbody></table>}</div>
            </section></main>
        <footer className="statusbar"><span>{files.length} item{files.length === 1 ? '' : 's'}</span><span>{searching ? 'Search results' : currentPath ? `/${currentPath}` : '/'}</span></footer>
          {context && <div className="context-menu" style={{ left: context.x, top: context.y }} onClick={(event) => event.stopPropagation()}><button disabled={downloading || !hasCapability('read')} onClick={() => action(startDownload)}>Download</button><button disabled={moving || !hasCapability('move')} onClick={() => action(() => setModal('move'))}>Move</button><button disabled={selectedItems.length !== 1 || !hasCapability('rename')} onClick={() => action(() => setModal('rename'))}>Rename</button><button disabled={selectedItems.length !== 1 || selectedItems[0].isDirectory || !hasCapability('share')} onClick={() => action(() => { setCreatedShareLinks(null); setModal('share'); })}>Share</button><hr /><button disabled={!hasCapability('delete')} onClick={() => action(remove)}>Delete</button></div>}
        {modal === 'folder' && <Dialog title="New folder" onClose={() => setModal(null)}><form onSubmit={saveFolder}><p>Create a folder in {currentPath ? `/${currentPath}` : '/'}.</p><label>Folder name<input name="folderName" autoFocus required /></label><DialogActions onClose={() => setModal(null)} label="Create" /></form></Dialog>}
         {modal === 'move' && <Dialog title="Move selected items" onClose={() => setModal(null)}><p>Choose a destination. You cannot move an item into its current folder or one of its own subfolders.</p><div className="move-tree">{locations.map((location) => <section key={location.id}><strong>{location.displayName}</strong>{renderTree(location.id, (node) => moveItems(selectedItems, node.path, location.id))}</section>)}</div><div className="modal-actions"><button type="button" onClick={() => setModal(null)}>Cancel</button></div></Dialog>}
        {modal === 'password' && <Dialog title="Change password" onClose={() => setModal(null)}><form onSubmit={savePassword}><p>Changing your password signs this device out.</p><label>Current password<input name="currentPassword" type="password" autoFocus required /></label><label>New password<input name="newPassword" type="password" minLength="6" required /></label><label>Confirm new password<input name="confirmPassword" type="password" minLength="6" required /></label><DialogActions onClose={() => setModal(null)} label="Change password" /></form></Dialog>}
        {modal === 'rename' && selectedItems[0] && <Dialog title="Rename" onClose={() => setModal(null)}><form onSubmit={saveRename}><p>Rename {selectedItems[0].name}.</p><label>New name<input name="newName" defaultValue={selectedItems[0].name} autoFocus required /></label><DialogActions onClose={() => setModal(null)} label="Rename" /></form></Dialog>}
        {modal === 'share' && selectedItems[0] && <Dialog title="Share file" onClose={() => setModal(null)}>{createdShareLinks ? <><p>Anyone with either link can download {selectedItems[0].name}.</p><label>Secure link<input value={createdShareLinks.secure} readOnly onFocus={(event) => event.target.select()} /></label><label>Direct download link<input value={createdShareLinks.direct} readOnly onFocus={(event) => event.target.select()} /></label><div className="modal-actions"><button type="button" onClick={() => navigator.clipboard.writeText(createdShareLinks.secure)}>Copy secure</button><button type="button" onClick={() => navigator.clipboard.writeText(createdShareLinks.direct)}>Copy direct</button><button className="confirm" onClick={() => setModal(null)}>Done</button></div></> : <form onSubmit={createShare}><p>Create download links for {selectedItems[0].name}.</p><label>Expires<select name="expiresIn" defaultValue="86400"><option value="3600">In 1 hour</option><option value="86400">In 1 day</option><option value="604800">In 7 days</option><option value="0">Never</option></select></label><label>Downloads<select name="maxDownloads" defaultValue="0"><option value="0">Unlimited</option><option value="1">1 download</option><option value="10">10 downloads</option><option value="100">100 downloads</option></select></label><DialogActions onClose={() => setModal(null)} label="Create links" /></form>}</Dialog>}
        {modal === 'downloadMode' && <Dialog title="Choose download mode" onClose={() => setModal(null)}>
            <p>Download {selectedItems.length} selected item{selectedItems.length === 1 ? '' : 's'} as a single archive, or queue every file individually (preserving the original folder structure where your browser supports it).</p>
            <label className="archive-format-option"><input type="radio" name="downloadMode" checked={downloadModeDraft === 'tar.gz'} onChange={() => setDownloadModeDraft('tar.gz')} /><span><strong>tar.gz archive</strong></span></label>
            <label className="archive-format-option"><input type="radio" name="downloadMode" checked={downloadModeDraft === 'zip'} onChange={() => setDownloadModeDraft('zip')} /><span><strong>zip archive</strong></span></label>
            <label className="archive-format-option"><input type="radio" name="downloadMode" checked={downloadModeDraft === 'queue'} onChange={() => setDownloadModeDraft('queue')} /><span><strong>Queue (one file at a time)</strong>{!supportsDirectoryPicker() && <small> Your browser cannot preserve folder structure for queued downloads; files will download individually with flattened names.</small>}</span></label>
            <div className="modal-actions">
                <button type="button" className="confirm" onClick={() => {
                    if (downloadModeDraft === 'queue') { setModal(null); void enqueueQueueDownload(selectedItems); return; }
                    setArchiveFormat(downloadModeDraft);
                    setModal(null);
                    void download(selectedItems);
                }}>Start download</button>
                <button type="button" onClick={() => setModal(null)}>Cancel</button>
            </div>
        </Dialog>}
         {modal === 'shareLinks' && <Dialog title="Share Links" onClose={() => setModal(null)}><div className="share-links-dialog"><div className="share-links-toolbar"><p>Links created by {user.username}.</p><button type="button" onClick={loadShareLinks} disabled={shareLinksLoading}>{shareLinksLoading ? 'Refreshing...' : 'Refresh'}</button></div>{shareLinksLoading && !shareLinks.length ? <p className="muted">Loading share links...</p> : !shareLinks.length ? <p className="muted">No share links created yet.</p> : <div className="share-link-groups">{shareLinkGroups.map((group) => <section className="share-link-group" key={group.key}><div className="share-link-group-heading"><h3>{group.label}</h3><span>{group.links.length}</span>{group.key === 'revoked' && <button type="button" onClick={() => void Promise.all(group.links.map((link) => deleteRevokedShareLink(link.shareToken)))}>Clear all revoked</button>}{group.key === 'expired' && <button type="button" onClick={() => void Promise.all(group.links.map((link) => deleteExpiredShareLink(link.shareToken)))}>Clear all expired</button>}</div><div className="share-links-list">{group.links.map((link) => { const secureUrl = shareLinkUrl(link, 'secure'); const directUrl = shareLinkUrl(link, 'direct'); const status = shareLinkStatus(link); return <article className="share-link-card" key={link.shareToken}><div className="share-link-card-heading"><strong>{link.fileName}</strong><span className={`share-link-status ${status.toLowerCase()}`}>{status}</span></div><small>Location: {link.locationId || '--'} · Created: {formatDate(link.createdAt)}</small><small>Downloads: {link.downloadCount || 0}{link.maxDownloads > 0 ? ` / ${link.maxDownloads}` : ' / unlimited'} · Expires: {link.expiresAt ? formatDate(link.expiresAt) : 'never'}</small><label>Secure link<input readOnly value={secureUrl} onFocus={(event) => event.target.select()} /></label><label>Direct download<input readOnly value={directUrl} onFocus={(event) => event.target.select()} /></label><div className="modal-actions">{status === 'Active' && <><button type="button" onClick={() => void copyShareLink(link, 'secure')}>Copy secure</button><button type="button" onClick={() => void copyShareLink(link, 'direct')}>Copy direct</button><button type="button" className="danger" onClick={() => void revokeShareLink(link.shareToken)}>Revoke</button></>}{status === 'Revoked' && <button type="button" onClick={() => void deleteRevokedShareLink(link.shareToken)}>Clear revoked</button>}{status === 'Expired' && <button type="button" onClick={() => void deleteExpiredShareLink(link.shareToken)}>Clear expired</button>}</div></article>; })}</div></section>)}</div>}</div></Dialog>}
          {queueOpen && <div className="queue-panel"><div className="queue-panel-header"><strong>Transfer Queue ({queueItems.filter((item) => ['queued', 'running', 'retrying'].includes(item.status)).length} active)</strong><button onClick={() => setQueueOpen(false)}>×</button></div>{queueItems.length === 0 ? <p className="muted">No transfers in history.</p> : <><strong>Active</strong><ul className="queue-panel-list">{queueItems.filter((item) => ['queued', 'running', 'retrying', 'needs_user_action'].includes(item.status)).map(renderQueueItem)}</ul>{queueItems.some((item) => ['completed', 'failed', 'cancelled'].includes(item.status)) && <><strong>History</strong><ul className="queue-panel-list">{queueItems.filter((item) => ['completed', 'failed', 'cancelled'].includes(item.status)).map(renderQueueItem)}</ul></>}</>}{queueItems.some((item) => item.status === 'completed') && <button type="button" onClick={() => clearQueueStatus('completed')}>Clear completed</button>}{queueItems.some((item) => item.status === 'failed') && <button type="button" onClick={() => clearQueueStatus('failed')}>Clear failed</button>}{queueItems.some((item) => item.status === 'cancelled') && <button type="button" onClick={() => clearQueueStatus('cancelled')}>Clear cancelled</button>}{queueItems.some((item) => ['completed', 'failed', 'cancelled'].includes(item.status)) && <button type="button" onClick={clearQueueHistory}>Clear history</button>}</div>}
    </div>;
};


const FolderTree = ({ node, currentPath, dragItems, dropTarget, onChooseDestination, onToggle, onNavigate, onDragOver, onDragLeave, onDrop }) => <div className="folder-tree"><div className={`tree-node ${currentPath === node.path ? 'active' : ''} ${dropTarget === node.path ? 'drop-target' : ''}`} onDragOver={(event) => onDragOver(event, node)} onDragLeave={onDragLeave} onDrop={(event) => onDrop(event, node)}><button className="tree-toggle" aria-label={`${node.expanded ? 'Collapse' : 'Expand'} ${node.name}`} onClick={() => onToggle(node)}>{node.expanded ? '−' : '+'}</button><button className="tree-folder" onClick={() => onChooseDestination ? onChooseDestination(node) : onNavigate(node.path)}><span className="folder-mini" />{node.name}</button>{dragItems.length > 0 && dropTarget === node.path && <span className="drop-label">Move here</span>}</div>{node.expanded && <div className="tree-children">{node.loaded ? node.children.map((child) => <FolderTree key={child.path} node={child} currentPath={currentPath} dragItems={dragItems} dropTarget={dropTarget} onChooseDestination={onChooseDestination} onToggle={onToggle} onNavigate={onNavigate} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} />) : <span className="tree-loading">Loading folders...</span>}</div>}</div>;

const Dialog = ({ title, onClose, children }) => <div className="modal-cover" onMouseDown={onClose}><div className="modal" onMouseDown={(event) => event.stopPropagation()}><h2>{title}</h2>{children}</div></div>;
const DialogActions = ({ onClose, label }) => <div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="confirm" type="submit">{label}</button></div>;
