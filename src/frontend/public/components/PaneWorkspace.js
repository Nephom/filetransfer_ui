import React from 'react';
import PaneTerminalWindow from './PaneTerminalWindow.js';
import PaneTools from './PaneTools.js';
import PaneWorkspaceLegacy from './PaneWorkspaceLegacy.js';

export default function PaneWorkspace(props) {
    const [contextMenu, setContextMenu] = React.useState(null);
    const [terminals, setTerminals] = React.useState([]);
    const [nextTerminalId, setNextTerminalId] = React.useState(1);
    const nextZ = () => Math.max(...[...terminals.map(t => t.z), ...props.terminals?.map(t => t.z) || [], 0]) + 1;
    const openTerminal = () => {
        const id = `terminal-${nextTerminalId}`;
        setNextTerminalId(value => value + 1);
        setTerminals(current => [...current, { id, targetId: '', minimized: false, maximized: false, position: null, z: nextZ() }]);
        if (props.onActivateTerminal) props.onActivateTerminal(id);
    };
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
        <div className="pane-terminal-tools-overlay"><PaneTools active={null} onUpload={() => {}} onAction={() => {}} onOpenTerminal={openTerminal} /></div>
        {contextMenu && <div className="pane-terminal-launch-menu" style={{ left: contextMenu.x + 200, top: contextMenu.y }}><button type="button" onClick={openTerminal}>Terminal</button></div>}
    </div>;
}
