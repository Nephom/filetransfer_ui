import React from 'react';
import { formatPaneSize, paneItemKey } from './pane-workspace-utils.js';

export default function PaneFileWindow({ window: pane, location, active, selectedItems, onFocus, onClose, onAction, onModeChange, onQueryChange, onLoadFiles, onChoose, onDrop, onMove, onContextMenu }) {
    const run = (action) => { void onAction(pane.id, action); };
    const dragRef = React.useRef(null);
    const onTitlePointerDown = (event) => {
        if (event.target.closest('button')) return;
        if (dragRef.current) return;
        const windowElement = event.currentTarget.closest('.pane-window');
        const layer = windowElement?.parentElement;
        if (!windowElement || !layer) return;
        event.preventDefault();
        onFocus(pane.id);
        const windowRect = windowElement.getBoundingClientRect();
        const layerRect = layer.getBoundingClientRect();
        dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - windowRect.left, offsetY: event.clientY - windowRect.top, layerRect };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const onTitlePointerMove = (event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const windowElement = event.currentTarget.closest('.pane-window');
        if (!windowElement) return;
        const left = Math.max(0, Math.min(drag.layerRect.width - windowElement.offsetWidth, event.clientX - drag.layerRect.left - drag.offsetX));
        const top = Math.max(0, Math.min(drag.layerRect.height - windowElement.offsetHeight, event.clientY - drag.layerRect.top - drag.offsetY));
        onMove(pane.id, left, top);
    };
    const onTitlePointerUp = (event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        dragRef.current = null;
    };
    React.useEffect(() => () => { dragRef.current = null; }, []);
    return <article className={`pane-window ${active ? 'is-active' : ''}`} style={{ zIndex: pane.z, ...(pane.position ? { left: `${pane.position.left}px`, top: `${pane.position.top}px` } : {}) }} onPointerDown={() => onFocus(pane.id)} onContextMenu={(event) => onContextMenu(event, pane.id)}>
        <header className="pane-window-titlebar" onPointerDown={onTitlePointerDown} onPointerMove={onTitlePointerMove} onPointerUp={onTitlePointerUp}>
            <div><span className="folder-icon" aria-hidden="true">▰</span><strong>{location?.displayName || pane.locationId}</strong><small>{active ? 'ACTIVE' : 'Remote API'}</small></div>
            <button type="button" onClick={() => onClose(pane.id)} aria-label="Close window">×</button>
        </header>
        <div className="pane-window-toolbar"><span className="pane-view-switch"><button type="button" className={pane.mode === 'details' ? 'active' : ''} onClick={() => onModeChange(pane.id, 'details')}>Details</button><button type="button" className={pane.mode === 'grid' ? 'active' : ''} onClick={() => onModeChange(pane.id, 'grid')}>Grid</button></span></div>
        <div className="pane-window-navigation"><button type="button" onClick={() => onLoadFiles(pane.id, pane.path.split('/').slice(0, -1).join('/'))} disabled={!pane.path}>↑</button><span>/{pane.path}</span><input value={pane.query} placeholder="Search this directory" onChange={(event) => onQueryChange(pane.id, event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') onLoadFiles(pane.id, pane.path, pane.query.trim()); if (event.key === 'Escape') onLoadFiles(pane.id, pane.path); }} /></div>
        {pane.error && <div className="pane-error" role="alert">{pane.error}</div>}
        <div className={`pane-files ${pane.mode}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }} onDrop={(event) => onDrop(event, pane.id)}>
            {pane.loading ? <div className="pane-empty">Loading files...</div> : !pane.files.length ? <div className="pane-empty">This folder is empty.</div> : pane.mode === 'grid' ? pane.files.map((file) => <button type="button" draggable key={paneItemKey(file)} className={`pane-file-tile ${pane.selected.includes(paneItemKey(file)) ? 'selected' : ''}`} onClick={(event) => onChoose(pane.id, paneItemKey(file), event)} onDoubleClick={() => file.isDirectory && onLoadFiles(pane.id, file.path)} onDragStart={(event) => event.dataTransfer.setData('application/x-pane-file', JSON.stringify({ windowId: pane.id, key: paneItemKey(file) }))}><span className="pane-file-icon">{file.isDirectory ? '▰' : '▱'}</span><strong>{file.name}</strong><small>{file.isDirectory ? 'Folder' : formatPaneSize(file.size)}</small></button>) : <table><thead><tr><th>Name</th><th>Type</th><th>Size</th></tr></thead><tbody>{pane.files.map((file) => <tr draggable key={paneItemKey(file)} className={pane.selected.includes(paneItemKey(file)) ? 'selected' : ''} onClick={(event) => onChoose(pane.id, paneItemKey(file), event)} onDoubleClick={() => file.isDirectory && onLoadFiles(pane.id, file.path)} onDragStart={(event) => event.dataTransfer.setData('application/x-pane-file', JSON.stringify({ windowId: pane.id, key: paneItemKey(file) }))}><td><span className="pane-file-icon">{file.isDirectory ? '▰' : '▱'}</span>{file.name}</td><td>{file.isDirectory ? 'Folder' : 'File'}</td><td>{file.isDirectory ? '--' : formatPaneSize(file.size)}</td></tr>)}</tbody></table>}
        </div>
    </article>;
}
