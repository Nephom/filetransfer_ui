import React from 'react';

const tools = [['upload', 'Upload'], ['new-folder', 'New Folder'], ['rename', 'Rename'], ['move', 'Move'], ['copy', 'Copy'], ['delete', 'Delete'], ['share', 'Share'], ['download', 'Download'], ['refresh', 'Refresh'], ['select-all', 'Select All']];
const iconPaths = {
    terminal: <path d="M4 5h16v14H4zM7 9l3 3-3 3m5 0h4" />,
    upload: <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 14v5h16v-5" />,
    'new-folder': <path d="M3.5 6.5h6l2 2h9v10h-17zM12 11v5m-2.5-2.5h5" />,
    rename: <path d="m14 5 5 5M4 20l3.7-.8L19.5 7.4a2.1 2.1 0 0 0-3-3L4.7 16.2z" />,
    move: <path d="M5 8h14M15 4l4 4-4 4M19 16H5m4-4-4 4 4 4" />,
    copy: <><rect x="8" y="8" width="11" height="11" rx="1.5" /><path d="M16 8V5H5a1 1 0 0 0-1 1v10h4" /></>,
    delete: <path d="M5 7h14M10 4h4l1 3H9zm-2 3 1 13h6l1-13M10 11v5m4-5v5" />,
    share: <><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="m8.3 10.8 7.4-4.5m-7.4 6.9 7.4 4.5" /></>,
    download: <path d="M12 4v12m0 0-4.5-4.5M12 16l4.5-4.5M4 20h16" />,
    refresh: <path d="M20 11a8 8 0 0 0-14-4L4 9m0-4v4h4M4 13a8 8 0 0 0 14 4l2-2m0 4v-4h-4" />,
    'select-all': <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="m8 12 2.5 2.5L16 9" /></>
};

export function PaneTerminalLauncher({ onOpenTerminal }) {
    return <button className="pane-terminal-launch-card" type="button" aria-label="Open SSH Terminal" onClick={onOpenTerminal}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{iconPaths.terminal}</svg>
        <span><strong>Terminal</strong><small>Open SSH terminal</small></span>
    </button>;
}

export default function PaneTools({ active, onUpload, onAction }) {
    const viewportRef = React.useRef(null);
    const trackRef = React.useRef(null);
    const cycleRef = React.useRef(null);
    const cycleDistanceRef = React.useRef(0);
    const loopEnabledRef = React.useRef(false);
    const [loopEnabled, setLoopEnabled] = React.useState(false);

    const measureLoop = React.useCallback(() => {
        const viewport = viewportRef.current;
        const cycle = cycleRef.current;
        if (!viewport || !cycle) return;
        const nextLoopEnabled = cycle.getBoundingClientRect().height > viewport.clientHeight + 1;
        if (nextLoopEnabled !== loopEnabledRef.current) {
            loopEnabledRef.current = nextLoopEnabled;
            setLoopEnabled(nextLoopEnabled);
            return;
        }
        const groups = trackRef.current?.children;
        if (nextLoopEnabled && groups?.length === 3) {
            cycleDistanceRef.current = groups[1].offsetTop - groups[0].offsetTop;
        }
    }, []);

    React.useLayoutEffect(() => {
        const viewport = viewportRef.current;
        const cycle = cycleRef.current;
        if (!viewport || !cycle) return undefined;
        const observer = new ResizeObserver(measureLoop);
        observer.observe(viewport);
        observer.observe(cycle);
        measureLoop();
        return () => observer.disconnect();
    }, [measureLoop, loopEnabled]);

    React.useLayoutEffect(() => {
        const viewport = viewportRef.current;
        const groups = trackRef.current?.children;
        if (!viewport) return;
        if (!loopEnabled || groups?.length !== 3) {
            viewport.scrollTop = 0;
            cycleDistanceRef.current = 0;
            return;
        }
        const distance = groups[1].offsetTop - groups[0].offsetTop;
        cycleDistanceRef.current = distance;
        viewport.scrollTop = groups[1].offsetTop;
    }, [loopEnabled]);

    const handleLoopScroll = () => {
        if (!loopEnabledRef.current) return;
        const viewport = viewportRef.current;
        const distance = cycleDistanceRef.current;
        if (!viewport || !distance) return;
        // Rebase from the cached cycle offset synchronously so momentum scrolling never paints a list edge.
        if (viewport.scrollTop < distance / 2) viewport.scrollTop += distance;
        else if (viewport.scrollTop > distance * 1.5) viewport.scrollTop -= distance;
    };

    const renderCycle = (cycleName, clone = false) => <div className="pane-tool-cycle" key={cycleName} aria-hidden={clone || undefined}>
        {tools.map(([action, label]) => <button type="button" aria-label={`Pane ${label}`} key={`${cycleName}-${action}`} data-tool-action={action} tabIndex={clone ? -1 : undefined} onClick={() => action === 'upload' ? onUpload() : onAction(action)} disabled={!active}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{iconPaths[action]}</svg><strong>{label}</strong>
        </button>)}
    </div>;

    return <aside className="pane-side pane-tools" aria-label="File tools">
        <div className="pane-heading" aria-hidden="true">TOOLS</div>
        <div className={`pane-tool-grid${loopEnabled ? ' is-looping' : ''}`} ref={viewportRef} onScroll={handleLoopScroll} aria-label={loopEnabled ? 'File tools, continuous scrolling' : 'File tools'}>
            <div className="pane-tool-track" ref={trackRef}>
                {loopEnabled && renderCycle('before', true)}
                <div className="pane-tool-cycle" key="original" ref={cycleRef}>
                    {tools.map(([action, label]) => <button type="button" aria-label={`Pane ${label}`} key={action} data-tool-action={action} onClick={() => action === 'upload' ? onUpload() : onAction(action)} disabled={!active}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{iconPaths[action]}</svg><strong>{label}</strong>
                    </button>)}
                </div>
                {loopEnabled && renderCycle('after', true)}
            </div>
        </div>
    </aside>;
}
