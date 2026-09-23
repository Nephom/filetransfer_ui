import React from 'react';

const tools = [['terminal', 'Terminal'], ['upload', 'Upload'], ['new-folder', 'New Folder'], ['rename', 'Rename'], ['move', 'Move'], ['copy', 'Copy'], ['delete', 'Delete'], ['share', 'Share'], ['download', 'Download'], ['refresh', 'Refresh'], ['select-all', 'Select All']];
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

export default function PaneTools({ active, onUpload, onAction, onOpenTerminal }) {
    return <aside className="pane-side pane-tools"><div className="pane-heading">TOOLS</div><div className="pane-tool-grid">{tools.map(([action, label]) => <button type="button" aria-label={`Pane ${label}`} key={action} onClick={() => action === 'terminal' ? onOpenTerminal() : action === 'upload' ? onUpload() : onAction(action)} disabled={action !== 'terminal' && !active}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{iconPaths[action]}</svg><strong>{label}</strong></button>)}</div></aside>;
}
