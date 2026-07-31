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

const FileBrowser = ({ token, user, onLogout }) => {
    const [files, setFiles] = React.useState([]);
    const [currentPath, setCurrentPath] = React.useState('');
    const [displayPath, setDisplayPath] = React.useState('/');
    const [selected, setSelected] = React.useState([]);
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
    const [folderTree, setFolderTree] = React.useState({ path: '', name: '/', expanded: true, loaded: false, children: [] });
    const [dragItems, setDragItems] = React.useState([]);
    const [dropTarget, setDropTarget] = React.useState(null);
    const [fileDropTarget, setFileDropTarget] = React.useState(null);
    const [viewMode, setViewMode] = React.useState(() => localStorage.getItem('file-view-mode') || 'details');
    const [accountOpen, setAccountOpen] = React.useState(false);
    const inputRef = React.useRef(null);
    const accountRef = React.useRef(null);
    const dragExpandTimer = React.useRef(null);
    const notificationTimer = React.useRef(null);
    const downloadInProgress = React.useRef(false);

    const authHeaders = { Authorization: `Bearer ${token}` };
    const selectedItems = files.filter((file) => selected.includes(itemKey(file)));
    const pathForItem = (item) => normalisePath(item.path || (currentPath ? `${currentPath}/${item.name}` : item.name));

    const loadFiles = async (path = currentPath) => {
        setLoading(true); setError(''); setContext(null);
        try {
            const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`, { headers: authHeaders });
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

    const loadTreeChildren = async (path, force = false) => {
        const targetPath = normalisePath(path);
        try {
            const response = await fetch(`/api/files?path=${encodeURIComponent(targetPath)}`, { headers: authHeaders });
            if (!response.ok) throw new Error('Unable to load folders.');
            const data = await response.json();
            const children = (data.files || [])
                .filter((file) => file && file.name && file.isDirectory)
                .map((file) => ({ path: normalisePath(file.path), name: file.name, expanded: false, loaded: false, children: [] }))
                .sort((left, right) => left.name.localeCompare(right.name));
            setFolderTree((tree) => updateTreeNode(tree, targetPath, (node) => ({ ...node, expanded: true, loaded: true, children })));
        } catch (requestError) {
            if (!force) setError(requestError.message);
        }
    };

    const toggleFolder = (node) => {
        if (node.expanded) {
            setFolderTree((tree) => updateTreeNode(tree, node.path, (item) => ({ ...item, expanded: false })));
        } else if (node.loaded) {
            setFolderTree((tree) => updateTreeNode(tree, node.path, (item) => ({ ...item, expanded: true })));
        } else {
            loadTreeChildren(node.path);
        }
    };

    React.useEffect(() => { loadFiles(''); loadTreeChildren(''); }, []);
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
        if (event.ctrlKey || event.metaKey) setSelected((items) => items.includes(key) ? items.filter((item) => item !== key) : [...items, key]);
        else setSelected([key]);
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
                const response = await fetch('/api/archive', { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items.map(({ name, isDirectory, path }) => ({ name, isDirectory, path })), currentPath }) });
                if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Archive download failed.');
                const disposition = response.headers.get('Content-Disposition') || ''; const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i);
                downloadBlob(await response.blob(), match ? decodeURIComponent(match[1]) : 'archive.zip');
            }
            showSuccess('Download started in your browser.');
        } catch (requestError) { setTransferStatus(''); setError(requestError.message); }
        finally { downloadInProgress.current = false; setDownloading(false); }
    };

    const isValidMoveTarget = (items, destination) => {
        const target = normalisePath(destination);
        return items.length > 0 && items.every((item) => {
            const source = pathForItem(item);
            const sourceFolder = source.split('/').slice(0, -1).join('/');
            return target !== sourceFolder && (!item.isDirectory || (target !== source && !target.startsWith(`${source}/`)));
        });
    };

    const moveItems = async (items, destination) => {
        const targetPath = normalisePath(destination);
        if (!isValidMoveTarget(items, targetPath)) {
            setError('Choose a folder other than the current folder or a folder inside a selected folder.');
            return;
        }
        setMoving(true); setError(''); setTransferStatus(`Moving ${items.length} item${items.length === 1 ? '' : 's'} to /${targetPath}...`);
        try {
            const response = await fetch('/api/files/paste', { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items.map((item) => ({ name: item.name, isDirectory: item.isDirectory, path: pathForItem(item) })), operation: 'cut', targetPath }) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Move failed.');
            setModal(null); setDragItems([]); setDropTarget(null); showSuccess(data.message || 'Move complete.');
            setFolderTree({ path: '', name: '/', expanded: true, loaded: false, children: [] });
            loadTreeChildren('', true); loadFiles(currentPath);
        } catch (requestError) { setTransferStatus(''); setError(requestError.message); }
        finally { setMoving(false); }
    };

    const beginDrag = (event, file) => {
        const items = selected.includes(itemKey(file)) ? selectedItems : [file];
        if (!selected.includes(itemKey(file))) setSelected([itemKey(file)]);
        setDragItems(items); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', items.map((item) => item.name).join(', '));
    };
    const endDrag = () => { window.clearTimeout(dragExpandTimer.current); setDragItems([]); setDropTarget(null); setFileDropTarget(null); };
    const scheduleTreeExpand = (node) => {
        if (node.expanded) return;
        window.clearTimeout(dragExpandTimer.current);
        dragExpandTimer.current = window.setTimeout(() => toggleFolder(node), 650);
    };

    const remove = async () => {
        if (!selectedItems.length || !window.confirm(`Delete ${selectedItems.length} selected item${selectedItems.length === 1 ? '' : 's'}?`)) return;
        try {
            const response = await fetch('/api/files/delete', { method: 'DELETE', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ items: selectedItems.map(({ name, isDirectory }) => ({ name, isDirectory })), currentPath }) });
            if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Delete failed.'); } showSuccess(`Deleted ${selectedItems.length} item${selectedItems.length === 1 ? '' : 's'}.`); loadFiles(currentPath); loadTreeChildren('', true);
        } catch (requestError) { setError(requestError.message); }
    };
    const saveFolder = async (event) => {
        event.preventDefault(); const name = event.target.folderName.value.trim(); if (!name) return;
        try {
            const response = await fetch('/api/folders', { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ folderName: name, currentPath }) });
            if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Could not create folder.'); } setModal(null); showSuccess('Folder created.'); loadFiles(currentPath); loadTreeChildren('', true);
        } catch (requestError) { setError(requestError.message); }
    };
    const saveRename = async (event) => {
        event.preventDefault(); const newName = event.target.newName.value.trim(); if (!newName || !selectedItems[0]) return;
        try {
            const response = await fetch('/api/files/rename', { method: 'PUT', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ oldName: selectedItems[0].name, newName, currentPath }) });
            if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Rename complete.'); } setModal(null); showSuccess('Rename complete.'); loadFiles(currentPath); loadTreeChildren('', true);
        } catch (requestError) { setError(requestError.message); }
    };
    const upload = async (event) => {
        const uploadFiles = Array.from(event.target.files || []); event.target.value = ''; if (!uploadFiles.length) return;
        const data = new FormData(); uploadFiles.forEach((file) => data.append('files', file)); data.append('path', currentPath);
        setLoading(true); setError('');
        try { const response = await fetch('/api/upload/multiple', { method: 'POST', headers: authHeaders, body: data }); if (!response.ok) throw new Error('Upload failed.'); showSuccess(`Uploaded ${uploadFiles.length} item${uploadFiles.length === 1 ? '' : 's'}.`); loadFiles(currentPath); loadTreeChildren('', true); }
        catch (requestError) { setError(requestError.message); setLoading(false); }
    };
    const createShare = async (event) => {
        event.preventDefault(); const file = selectedItems[0]; if (!file) return;
        try {
            const response = await fetch('/api/files/share', { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: file.path, expiresIn: Number(event.target.expiresIn.value), maxDownloads: Number(event.target.maxDownloads.value) }) });
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
                if (isValidMoveTarget(dragItems, file.path)) {
                    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setFileDropTarget(itemKey(file));
                }
            },
            onDragLeave: () => setFileDropTarget(null),
            onDrop: (event) => { event.preventDefault(); endDrag(); moveItems(dragItems, file.path); }
        } : {};
        const sharedProps = { draggable: true, onDragStart: (event) => beginDrag(event, file), onDragEnd: endDrag, onClick: (event) => choose(file, event), onDoubleClick: () => file.isDirectory ? openFolder(file) : download([file]), onContextMenu: (event) => openContext(event, file), ...dropHandlers };
        if (viewMode === 'grid') {
            return <article key={itemKey(file)} tabIndex="0" className={`file-tile ${selected.includes(itemKey(file)) ? 'selected' : ''} ${isDropTarget ? 'drop-target' : ''}`} {...sharedProps}><span className="tile-icon">{fileIcon(file)}</span><strong>{file.name}</strong><span>{file.type || fileType(file)}</span><small>{file.isDirectory ? 'Drop files here' : formatSize(file.size)}</small></article>;
        }
        return <tr key={itemKey(file)} tabIndex="0" className={`file-row ${selected.includes(itemKey(file)) ? 'selected' : ''} ${isDropTarget ? 'drop-target' : ''}`} {...sharedProps}><td><span className="file-name-cell"><span className="file-icon">{fileIcon(file)}</span>{file.name}</span></td><td className="muted">{formatDate(file.modified || file.modifiedTime)}</td><td className="muted">{file.type || fileType(file)}</td><td className="muted">{file.isDirectory ? '--' : formatSize(file.size)}</td></tr>;
    };

    const renderTree = (onChooseDestination) => <FolderTree node={folderTree} currentPath={currentPath} dragItems={dragItems} dropTarget={dropTarget} onChooseDestination={onChooseDestination} onToggle={toggleFolder} onNavigate={loadFiles} onDragOver={(event, node) => { if (isValidMoveTarget(dragItems, node.path)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(node.path); scheduleTreeExpand(node); } }} onDragLeave={() => setDropTarget(null)} onDrop={(event, node) => { event.preventDefault(); endDrag(); moveItems(dragItems, node.path); }} />;
    const tree = renderTree();

    return <div className="explorer" onContextMenu={(event) => event.preventDefault()}>
        <header className="titlebar"><span className="app-mark" /><span className="app-name">LAB File Manager</span><span className="connection-status">SECURE STORAGE</span><div className="account-control" ref={accountRef}><button className="account" onClick={(event) => { event.stopPropagation(); setAccountOpen((open) => !open); }} aria-expanded={accountOpen}>{user.username}<span className="account-role">{user.role === 'admin' ? 'Admin' : 'User'}</span><span className="account-chevron">⌄</span></button>{accountOpen && <div className="account-menu"><div className="account-summary"><strong>{user.username}</strong><span>{user.role === 'admin' ? 'System administrator' : 'Standard user'}</span></div>{user.role === 'admin' && <button onClick={() => window.location.assign('/admin')}>Admin console</button>}<button onClick={() => { setAccountOpen(false); setModal('password'); }}>Change password</button><hr /><button className="danger" onClick={onLogout}>Log out</button></div>}</div></header>
        <nav className="commandbar">
            <button className="primary" onClick={() => inputRef.current.click()}>Upload</button><input ref={inputRef} type="file" multiple hidden onChange={upload} />
            <button onClick={() => setModal('folder')}>New folder</button><span className="divider" />
            <button disabled={!selectedItems.length || downloading} onClick={() => download()}>{downloading ? 'Preparing download...' : 'Download'}</button><button disabled={!selectedItems.length || moving} onClick={() => setModal('move')}>Move</button><button disabled={selectedItems.length !== 1} onClick={() => setModal('rename')}>Rename</button>
            <button className="optional" disabled={selectedItems.length !== 1 || selectedItems[0].isDirectory} onClick={() => { setShareLink(''); setModal('share'); }}>Share</button><button disabled={!selectedItems.length} onClick={remove}>Delete</button><span className="divider" />
            <button className="optional" onClick={selectAll}>Select all</button><span className="view-switch" aria-label="File view"><button className={viewMode === 'details' ? 'active' : ''} onClick={() => setViewMode('details')}>Details</button><button className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')}>Grid</button></span><button onClick={() => loadFiles(currentPath)}>Refresh</button>
        </nav>
        <div className="navigation"><button className="nav-button" aria-label="Go up" disabled={!currentPath && !searching} onClick={goUp}>↑</button><div className="crumbs"><button onClick={() => loadFiles('')}>/</button>{crumbs.map((part, index) => <React.Fragment key={`${part}-${index}`}><span className="crumb-separator">›</span><button onClick={() => loadFiles(crumbs.slice(0, index + 1).join('/'))}>{part}</button></React.Fragment>)}</div><div className="search-control"><input className="search" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') searchFiles(); if (event.key === 'Escape') clearSearch(); }} placeholder="Search files" aria-label="Search files" />{(search || searching) && <button className="clear-search" onClick={clearSearch} aria-label="Clear search">×</button>}</div></div>
        <main className="workspace"><aside className="sidebar"><span className="sidebar-label">Locations</span>{tree}</aside>
            <section className="content"><div className="content-heading"><div><span className="eyebrow">CURRENT DIRECTORY</span><h1>{displayPath}</h1></div>{selectedItems.length > 0 && <span className="selection-count">{selectedItems.length} selected</span>}</div>{error && <div className="notice error-notice">{error}</div>}{transferStatus && <div className="notice transfer-notice"><span className={downloading || moving ? 'activity-dot' : ''} />{transferStatus}</div>}
                <div className="file-area" onClick={(event) => { if (event.target === event.currentTarget) setSelected([]); }}>{loading ? <div className="empty"><span className="loading-orbit" /><strong>Loading files...</strong></div> : files.length === 0 ? <div className="empty"><strong>{searching ? 'No matching files' : 'This folder is empty'}</strong><span>{searching ? 'Try a different search term.' : 'Upload files or create a folder to get started.'}</span></div> : viewMode === 'grid' ? <div className="file-grid" onClick={(event) => { if (event.target === event.currentTarget) setSelected([]); }}>{files.map(renderFileItem)}</div> : <table className="file-table"><thead><tr><th>Name</th><th>Date modified</th><th>Type</th><th>Size</th></tr></thead><tbody>{files.map(renderFileItem)}</tbody></table>}</div>
            </section></main>
        <footer className="statusbar"><span>{files.length} item{files.length === 1 ? '' : 's'}</span><span>{searching ? 'Search results' : currentPath ? `/${currentPath}` : '/'}</span></footer>
        {context && <div className="context-menu" style={{ left: context.x, top: context.y }} onClick={(event) => event.stopPropagation()}><button disabled={downloading} onClick={() => action(download)}>Download</button><button disabled={moving} onClick={() => action(() => setModal('move'))}>Move</button><button disabled={selectedItems.length !== 1} onClick={() => action(() => setModal('rename'))}>Rename</button><button disabled={selectedItems.length !== 1 || selectedItems[0].isDirectory} onClick={() => action(() => { setShareLink(''); setModal('share'); })}>Share</button><hr /><button onClick={() => action(remove)}>Delete</button></div>}
        {modal === 'folder' && <Dialog title="New folder" onClose={() => setModal(null)}><form onSubmit={saveFolder}><p>Create a folder in {currentPath ? `/${currentPath}` : '/'}.</p><label>Folder name<input name="folderName" autoFocus required /></label><DialogActions onClose={() => setModal(null)} label="Create" /></form></Dialog>}
        {modal === 'move' && <Dialog title="Move selected items" onClose={() => setModal(null)}><p>Choose a destination. You cannot move an item into its current folder or one of its own subfolders.</p><div className="move-tree">{renderTree((node) => moveItems(selectedItems, node.path))}</div><div className="modal-actions"><button type="button" onClick={() => setModal(null)}>Cancel</button></div></Dialog>}
        {modal === 'password' && <Dialog title="Change password" onClose={() => setModal(null)}><form onSubmit={savePassword}><p>Changing your password signs this device out.</p><label>Current password<input name="currentPassword" type="password" autoFocus required /></label><label>New password<input name="newPassword" type="password" minLength="6" required /></label><label>Confirm new password<input name="confirmPassword" type="password" minLength="6" required /></label><DialogActions onClose={() => setModal(null)} label="Change password" /></form></Dialog>}
        {modal === 'rename' && selectedItems[0] && <Dialog title="Rename" onClose={() => setModal(null)}><form onSubmit={saveRename}><p>Rename {selectedItems[0].name}.</p><label>New name<input name="newName" defaultValue={selectedItems[0].name} autoFocus required /></label><DialogActions onClose={() => setModal(null)} label="Rename" /></form></Dialog>}
        {modal === 'share' && selectedItems[0] && <Dialog title="Share file" onClose={() => setModal(null)}>{shareLink ? <><p>Anyone with this link can download {selectedItems[0].name}.</p><input value={shareLink} readOnly onFocus={(event) => event.target.select()} /><div className="modal-actions"><button onClick={() => navigator.clipboard.writeText(shareLink)}>Copy link</button><button className="confirm" onClick={() => setModal(null)}>Done</button></div></> : <form onSubmit={createShare}><p>Create a download link for {selectedItems[0].name}.</p><label>Expires<select name="expiresIn" defaultValue="86400"><option value="3600">In 1 hour</option><option value="86400">In 1 day</option><option value="604800">In 7 days</option><option value="0">Never</option></select></label><label>Downloads<select name="maxDownloads" defaultValue="0"><option value="0">Unlimited</option><option value="1">1 download</option><option value="10">10 downloads</option><option value="100">100 downloads</option></select></label><DialogActions onClose={() => setModal(null)} label="Create link" /></form>}</Dialog>}
    </div>;
};

const FolderTree = ({ node, currentPath, dragItems, dropTarget, onChooseDestination, onToggle, onNavigate, onDragOver, onDragLeave, onDrop }) => <div className="folder-tree"><div className={`tree-node ${currentPath === node.path ? 'active' : ''} ${dropTarget === node.path ? 'drop-target' : ''}`} onDragOver={(event) => onDragOver(event, node)} onDragLeave={onDragLeave} onDrop={(event) => onDrop(event, node)}><button className="tree-toggle" aria-label={`${node.expanded ? 'Collapse' : 'Expand'} ${node.name}`} onClick={() => onToggle(node)}>{node.expanded ? '−' : '+'}</button><button className="tree-folder" onClick={() => onChooseDestination ? onChooseDestination(node) : onNavigate(node.path)}><span className="folder-mini" />{node.name}</button>{dragItems.length > 0 && dropTarget === node.path && <span className="drop-label">Move here</span>}</div>{node.expanded && <div className="tree-children">{node.loaded ? node.children.map((child) => <FolderTree key={child.path} node={child} currentPath={currentPath} dragItems={dragItems} dropTarget={dropTarget} onChooseDestination={onChooseDestination} onToggle={onToggle} onNavigate={onNavigate} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} />) : <span className="tree-loading">Loading folders...</span>}</div>}</div>;

const Dialog = ({ title, onClose, children }) => <div className="modal-cover" onMouseDown={onClose}><div className="modal" onMouseDown={(event) => event.stopPropagation()}><h2>{title}</h2>{children}</div></div>;
const DialogActions = ({ onClose, label }) => <div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="confirm" type="submit">{label}</button></div>;
