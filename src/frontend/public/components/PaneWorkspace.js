import React from 'react';
import PaneTerminalWindow from './PaneTerminalWindow.js';
import PaneTools from './PaneTools.js';
import PaneWorkspaceLegacy from './PaneWorkspaceLegacy.js';

const terminalPane = (id, z) => ({ id, targetId: '', minimized: false, maximized: false, position: null, z });

export default function PaneWorkspace(props) {
    const [terminals, setTerminals] = React.useState([]);
    const [activeId, setActiveId] = React.useState(null);
    const [nextId, setNextId] = React.useState(1);
    const [contextMenu, setContextMenu] = React.useState(null);
    const layerRef = React.useRef(null);
    const terminalsRef = React.useRef(terminals);
    terminalsRef.current = terminals;
    const nextZ = () => Math.max(...terminalsRef.current.map(pane => pane.z), 0) + 1;
    const patchTerminal = (id, patch) => setTerminals(current => current.map(pane => pane.id === id ? { ...pane, ...patch } : pane));
    const openTerminal = () => {
        const id = `terminal-${nextId}`;
        setNextId(value => value + 1);
        setTerminals(current => [...current, terminalPane(id, nextZ())]);
        setActiveId(id);
        setContextMenu(null);
    };
    const focusTerminal = id => {
        const pane = terminalsRef.current.find(item => item.id === id);
        if (!pane || pane.minimized) return;
        const z = nextZ();
        setActiveId(id);
        patchTerminal(id, { z });
    };
    const updateTerminalZ = (id, z) => {
        patchTerminal(id, { z: z || nextZ() });
    };
    const closeTerminal = id => {
        setTerminals(current => current.filter(pane => pane.id !== id));
        setActiveId(current => current === id ? null : current);
    };
    const minimizeTerminal = id => patchTerminal(id, { minimized: true });
    const restoreTerminal = id => {
        patchTerminal(id, { minimized: false, z: nextZ() });
        setActiveId(id);
    };
    const toggleMaximizeTerminal = id => {
        const pane = terminalsRef.current.find(item => item.id === id);
        if (pane && !pane.minimized) patchTerminal(id, { maximized: !pane.maximized });
        setActiveId(id);
    };
    const moveTerminal = (id, left, top) => patchTerminal(id, { position: { left, top } });
    const showContextMenu = event => {
        if (event.target.closest?.('.pane-terminal-window')) return;
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY });
    };
    const showContextMenuCapture = event => {
        if (event.target.closest?.('.pane-terminal-window')) return;
        const source = event.target.closest?.('.pane-location-list button, .pane-window');
        if (!source) return;
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY });
    };
    React.useEffect(() => {
        const close = () => setContextMenu(null);
        window.addEventListener('click', close);
        return () => window.removeEventListener('click', close);
    }, []);
    React.useEffect(() => {
        if (activeId && !terminals.some(pane => pane.id === activeId && !pane.minimized)) {
            setActiveId(terminals.filter(pane => !pane.minimized).sort((left, right) => right.z - left.z)[0]?.id || null);
        }
    }, [activeId, terminals]);

    return <div className="pane-terminal-shell" onContextMenu={showContextMenu} onContextMenuCapture={showContextMenuCapture}>
        <PaneWorkspaceLegacy {...props} onActivateTerminal={focusTerminal} />
        <div className="pane-terminal-tools-overlay"><PaneTools active={null} onUpload={() => {}} onAction={() => {}} onOpenTerminal={openTerminal} /></div>
        <div className="pane-terminal-overlay" ref={layerRef}>{terminals.map(pane => <PaneTerminalWindow key={pane.id} window={pane} token={props.token} active={activeId === pane.id && !pane.minimized} onFocus={focusTerminal} onClose={closeTerminal} onMinimize={minimizeTerminal} onToggleMaximize={toggleMaximizeTerminal} onMove={moveTerminal} onUpdateZ={updateTerminalZ} />)}</div>
        {terminals.some(pane => pane.minimized) && <div className="pane-terminal-minimized-dock" aria-label="Minimized terminal windows">{terminals.filter(pane => pane.minimized).map(pane => <div className="pane-minimized-item" key={pane.id}><button type="button" className="pane-minimized-restore" onClick={() => restoreTerminal(pane.id)}>SSH Terminal</button><button type="button" className="pane-minimized-close" onClick={() => closeTerminal(pane.id)} aria-label="Close minimized terminal">x</button></div>)}</div>}
        {contextMenu && <div className="pane-terminal-launch-menu" style={{ left: contextMenu.x + 200, top: contextMenu.y }}><button type="button" onClick={openTerminal}>Terminal</button></div>}
    </div>;
}
