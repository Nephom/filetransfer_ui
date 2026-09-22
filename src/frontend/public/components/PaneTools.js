import React from 'react';

const tools = [['upload', 'Upload'], ['new-folder', 'New Folder'], ['rename', 'Rename'], ['move', 'Move'], ['copy', 'Copy'], ['delete', 'Delete'], ['share', 'Share'], ['download', 'Download'], ['refresh', 'Refresh'], ['select-all', 'Select All']];

export default function PaneTools({ active, onUpload, onAction }) {
    return <aside className="pane-side pane-tools"><div className="pane-heading">TOOLS</div><div className="pane-tool-grid">{tools.map(([action, label]) => <button type="button" aria-label={`Pane ${label}`} key={action} onClick={() => action === 'upload' ? onUpload() : onAction(action)} disabled={!active}><span>{label === 'New Folder' ? '+' : action === 'delete' ? '×' : action === 'download' ? '↓' : '▣'}</span><strong>{label}</strong></button>)}</div></aside>;
}
