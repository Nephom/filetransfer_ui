import React, { useRef, useState, type RefObject } from "react";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, CollapseIcon, ExpandIcon, ChevronUpIcon } from "../../ui/icons";
import { Dropdown } from "../../ui/Dropdown";

type TerminalEntry = {
  id: string;
  name: string;
};

type TerminalWorkspaceGroup = {
  id: string;
  name: string;
  sshEntries: TerminalEntry[];
};

type TerminalTab = {
  id: string;
  title: string;
  workspaceId: string;
  sshEntryId: string;
  sessionId: string;
  connected: boolean;
  connecting?: boolean;
  output: string;
  recording: boolean;
  recordingStartedAt: number | null;
  recordingCommandCount: number;
  recordingRawBytes: number;
  recordingPlainBytes: number;
  savedLogPaths: string[];
};

type Props = {
  open: boolean;
  height: number;
  maximized: boolean;
  quickListOpen: boolean;
  tabs: TerminalTab[];
  activeTabId: string;
  activeTab?: TerminalTab;
  workspaces: TerminalWorkspaceGroup[];
  activeWorkspaceId: string;
  activeWorkspace?: TerminalWorkspaceGroup;
  connected: boolean;
  recording: boolean;
  recordingHasOutput: boolean;
  savedLogPaths: string[];
  activeQueueCount: number;
  terminalHostRef: RefObject<HTMLDivElement>;
  onToggleQuickList: () => void;
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  onSelectTab: (tab: TerminalTab) => void;
  onReorderTabs: (draggedId: string, targetId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCreateTab: () => void;
  onQuickConnect: (workspaceId: string, entryId: string) => void;
  onSelectWorkspace: (id: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onCancelConnect: (tabId: string) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onSaveLog: () => void;
  onOpenSavedLog: (path: string) => void;
  onOpenWorkspaceManager: () => void;
  onOpenQueue: () => void;
  onToggleMaximized: () => void;
  onClose: () => void;
  onRestore: () => void;
};

export function TerminalWorkspace({
  open,
  height,
  maximized,
  quickListOpen,
  tabs,
  activeTabId,
  activeTab,
  workspaces,
  activeWorkspaceId,
  activeWorkspace,
  connected,
  recording,
  recordingHasOutput,
  savedLogPaths,
  activeQueueCount,
  terminalHostRef,
  onToggleQuickList,
  onResizeStart,
  onSelectTab,
  onReorderTabs,
  onCloseTab,
  onCreateTab,
  onQuickConnect,
  onSelectWorkspace,
  onConnect,
  onDisconnect,
  onCancelConnect,
  onStartRecording,
  onStopRecording,
  onSaveLog,
  onOpenSavedLog,
  onOpenWorkspaceManager,
  onOpenQueue,
  onToggleMaximized,
  onClose,
  onRestore,
}: Props) {
  const draggedTabIdRef = useRef<string | null>(null);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  if (!open) {
    return <button className="terminal-restore" onClick={onRestore} aria-label="Restore terminal">
      Terminal <ChevronUpIcon size={12} />
    </button>;
  }

  return <section className={`terminal-dock${maximized ? " terminal-maximized" : ""}`} style={{ height: `${height}px` }} aria-label="Terminal panel">
    <div className="terminal-resize-handle" onPointerDown={onResizeStart} role="separator" aria-label="Resize terminal" />
    <header className="terminal-header">
      <div className="terminal-tabs">
        <button className={quickListOpen ? "active" : ""} aria-pressed={quickListOpen} onClick={onToggleQuickList}>
          Workspaces
        </button>
        {tabs.map((tab) => (
          <span
            className={`ssh-tab ${tab.id === activeTabId ? "active" : ""}${tab.id === draggedTabId ? " dragging" : ""}${tab.id === dropTargetId ? " drop-target" : ""}`}
            key={tab.id}
            draggable
            onDragStart={(event) => {
              draggedTabIdRef.current = tab.id;
              setDraggedTabId(tab.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", tab.id);
            }}
            onDragOver={(event) => {
              if (draggedTabIdRef.current && draggedTabIdRef.current !== tab.id) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropTargetId(tab.id);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const draggedId = draggedTabIdRef.current;
              if (!draggedId || draggedId === tab.id) return;
              onReorderTabs(draggedId, tab.id);
              draggedTabIdRef.current = null;
              setDraggedTabId(null);
              setDropTargetId(null);
            }}
            onDragEnd={() => {
              draggedTabIdRef.current = null;
              setDraggedTabId(null);
              setDropTargetId(null);
            }}
          >
            <button type="button" onClick={() => onSelectTab(tab)} draggable={false}>
              <span className={`ssh-tab-status ${tab.connected ? "connected" : "disconnected"}`} aria-label={tab.connected ? "Connected" : "Disconnected"} title={tab.connected ? "Connected" : "Disconnected"} />
              {tab.title}
            </button>
            <button type="button" className="ssh-tab-close" aria-label={`Close ${tab.title}`} draggable={false} onClick={() => onCloseTab(tab.id)}><CloseIcon size={11} /></button>
          </span>
        ))}
        <button type="button" aria-label="New SSH terminal tab" onClick={onCreateTab}>+</button>
      </div>
      <div className="terminal-actions">
        <button onClick={onOpenWorkspaceManager}>Workspace Manager</button>
        <button onClick={onOpenQueue}>Transfer Queue ({activeQueueCount})</button>
        <button aria-label={maximized ? "Restore terminal size" : "Maximize terminal"} aria-pressed={maximized} onClick={onToggleMaximized}>{maximized ? <CollapseIcon /> : <ExpandIcon />}</button>
        <button aria-label="Collapse terminal" onClick={onClose}><ChevronDownIcon /></button>
      </div>
    </header>
    <div className="terminal-body">
      {quickListOpen && <aside className="ssh-quick-list" aria-label="Saved SSH sessions">
        <div className="ssh-quick-list-heading">Workspaces</div>
        {workspaces.length === 0 && <p className="terminal-inline-note">No saved SSH entries yet. Use Workspace Manager to add one.</p>}
        {workspaces.map((workspace) => <div className="ssh-quick-list-group" key={workspace.id}>
          <span className="ssh-quick-list-group-label">{workspace.name}</span>
          {workspace.sshEntries.map((entry) => {
            const entryConnected = tabs.some((tab) => tab.workspaceId === workspace.id && tab.sshEntryId === entry.id && tab.connected);
            const isActive = activeTab?.workspaceId === workspace.id && activeTab?.sshEntryId === entry.id;
            return <button type="button" key={entry.id} className={`ssh-quick-list-entry ${isActive ? "active" : ""}`} onClick={() => onQuickConnect(workspace.id, entry.id)}>
              <span className={`ssh-tab-status ${entryConnected ? "connected" : "disconnected"}`} aria-hidden="true" />
              {entry.name}
            </button>;
          })}
        </div>)}
      </aside>}
      <div className="terminal-content ssh-terminal-content">
        <div className="ssh-controls">
          <Dropdown className="palette-select-control" label="Select a Workspace" value={activeWorkspaceId} options={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))} onChange={onSelectWorkspace} />
          {!activeTab?.connected ? <button className="confirm" onClick={onConnect} disabled={activeTab?.connecting}>{activeTab?.connecting ? "Connecting…" : "Connect"}</button> : <button className="danger" onClick={onDisconnect}>Disconnect</button>}
          {activeTab?.connecting && <button className="danger" onClick={() => onCancelConnect(activeTab.id)}>Cancel</button>}
        </div>
        {!activeWorkspace && <p className="terminal-inline-note">Create or open a Session with an SSH connection before connecting.</p>}
        <div ref={terminalHostRef} className="xterm-host" aria-label="SSH terminal" />
        <div className="ssh-recording-actions">
          {!recording ? <button disabled={!connected} onClick={onStartRecording}>Start Recording</button> : <button className="danger" onClick={onStopRecording}>Stop Recording</button>}
          <button disabled={recording || !recordingHasOutput} onClick={onSaveLog}>Save Log</button>
          {savedLogPaths.length > 0 && <details className="saved-log-paths"><summary>Saved log files</summary>{savedLogPaths.map((savedPath) => <button type="button" key={savedPath} onClick={() => onOpenSavedLog(savedPath)}><code>{savedPath}</code></button>)}</details>}
          {recording && <span className="recording-indicator">Recording</span>}
        </div>
      </div>
    </div>
  </section>;
}
