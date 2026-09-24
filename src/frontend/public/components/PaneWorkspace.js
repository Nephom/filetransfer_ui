import React from 'react';
import PaneTerminalWindow from './PaneTerminalWindow.js';
import PaneTools from './PaneTools.js';
import PaneWorkspaceLegacy from './PaneWorkspaceLegacy.js';

export default function PaneWorkspace(props) {
    const [contextMenu, setContextMenu] = React.useState(null);
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
        <div className="pane-terminal-tools-overlay"><PaneTools active={null} onUpload={() => {}} onAction={() => {}} onOpenTerminal={() => { if (window.__paneWorkspaceOpenTerminal) window.__paneWorkspaceOpenTerminal(); }} /></div>
        {contextMenu && <div className="pane-terminal-launch-menu" style={{ left: contextMenu.x + 200, top: contextMenu.y }}><button type="button" onClick={() => { if (window.__paneWorkspaceOpenTerminal) window.__paneWorkspaceOpenTerminal(); }}>Terminal</button></div>}
    </div>;
}
