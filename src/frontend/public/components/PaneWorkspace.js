import React from 'react';
import PaneWorkspaceLegacy from './PaneWorkspaceLegacy.js';
import { usePaneMenuPosition } from './pane-workspace-utils.js';

export default function PaneWorkspace(props) {
    const [contextMenu, setContextMenu] = React.useState(null);
    const menuPosition = usePaneMenuPosition(contextMenu, 200);
    React.useEffect(() => {
        const close = () => setContextMenu(null);
        window.addEventListener('click', close);
        return () => window.removeEventListener('click', close);
    }, []);
    return <div className="pane-terminal-shell" onContextMenu={event => {
        if (event.target.closest?.('.pane-terminal-window')) return;
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY });
    }} onContextMenuCapture={event => {
        if (event.target.closest?.('.pane-terminal-window')) return;
        const source = event.target.closest?.('.pane-location-list button, .pane-window');
        if (!source) return;
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY });
    }}>
        <PaneWorkspaceLegacy {...props} />
        {contextMenu && <div ref={menuPosition.ref} className="pane-terminal-launch-menu" style={menuPosition.style}><button type="button" onClick={() => { if (window.__paneWorkspaceOpenTerminal) window.__paneWorkspaceOpenTerminal(); }}>Terminal</button></div>}
    </div>;
}
