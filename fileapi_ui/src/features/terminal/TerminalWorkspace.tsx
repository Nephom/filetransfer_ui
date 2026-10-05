import React, { useEffect, useRef, useState } from "react";
import { CloseIcon } from "../../ui/icons";
import type { SshTerminalTab } from "./terminal-contracts";

type TerminalTab = SshTerminalTab;

type Props = {
  tabs: TerminalTab[];
  activeTabId: string;
  activeTab?: TerminalTab;
  connected: boolean;
  recording: boolean;
  recordingHasOutput: boolean;
  savedLogPaths: string[];
  activeQueueCount: number;
  registerHostRef: (tabId: string, el: HTMLDivElement | null) => void;
  onSelectTab: (tab: TerminalTab) => void;
  onCopySession: (tab: TerminalTab) => void;
  onReorderTabs: (draggedId: string, targetId: string) => void;
  onCloseTab: (tabId: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onCancelConnect: (tabId: string) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onSaveLog: () => void;
  onOpenSavedLog: (path: string) => void;
  onOpenQueue: () => void;
};

export function TerminalWorkspace({
  tabs,
  activeTabId,
  activeTab,
  connected,
  recording,
  recordingHasOutput,
  savedLogPaths,
  activeQueueCount,
  registerHostRef,
  onSelectTab,
  onCopySession,
  onReorderTabs,
  onCloseTab,
  onConnect,
  onDisconnect,
  onCancelConnect,
  onStartRecording,
  onStopRecording,
  onSaveLog,
  onOpenSavedLog,
  onOpenQueue,
}: Props) {
  const draggedTabIdRef = useRef<string | null>(null);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ tab: TerminalTab; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  return <div className="terminal-embedded">
    <section className="terminal-dock">
    <header className="terminal-header">
      <div className="terminal-tabs">
        {tabs.map((tab) => (
          <span
            className={`ssh-tab ${tab.id === activeTabId ? "active" : ""}${tab.id === draggedTabId ? " dragging" : ""}${tab.id === dropTargetId ? " drop-target" : ""}`}
            key={tab.id}
            draggable
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({ tab, x: event.clientX, y: event.clientY });
            }}
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
      </div>
      <div className="terminal-actions">
        <button onClick={onOpenQueue}>Transfer Queue ({activeQueueCount})</button>
      </div>
    </header>
    <div className="terminal-body">
      <div className="terminal-content ssh-terminal-content">
        {activeTab && <div className="ssh-controls">
          {!activeTab.connected ? <button className="confirm" onClick={onConnect} disabled={activeTab.connecting}>{activeTab.connecting ? "Connecting…" : "Connect"}</button> : <button className="danger" onClick={onDisconnect}>Disconnect</button>}
          {activeTab.connecting && <button className="danger" onClick={() => onCancelConnect(activeTab.id)}>Cancel</button>}
        </div>}
        <div className="xterm-host-stack">
          {tabs.length === 0
            ? <div className="xterm-host-empty"><p className="terminal-inline-note">Use the Terminal button on the dock to pick an SSH Entry.</p></div>
            // Issue #239: every tab keeps its own permanently-mounted host
            // div/Terminal instance (see useTerminalLifecycle) -- switching
            // tabs only toggles which one has the `active` class (see
            // .xterm-host in terminal.css), it never unmounts/recreates
            // any of them.
            : tabs.map((tab) => (
              <div
                key={tab.id}
                ref={(el) => registerHostRef(tab.id, el)}
                className={`xterm-host${tab.id === activeTabId ? " active" : ""}`}
                aria-label="SSH terminal"
                aria-hidden={tab.id === activeTabId ? undefined : true}
              />
            ))}
        </div>
        <div className="ssh-recording-actions">
          {!recording ? <button disabled={!connected} onClick={onStartRecording}>Start Recording</button> : <button className="danger" onClick={onStopRecording}>Stop Recording</button>}
          <button disabled={recording || !recordingHasOutput} onClick={onSaveLog}>Save Log</button>
          {savedLogPaths.length > 0 && <details className="saved-log-paths"><summary>Saved log files</summary>{savedLogPaths.map((savedPath) => <button type="button" key={savedPath} onClick={() => onOpenSavedLog(savedPath)}><code>{savedPath}</code></button>)}</details>}
          {recording && <span className="recording-indicator">Recording</span>}
        </div>
      </div>
    </div>
    </section>
    {contextMenu && <div
      className="terminal-context-menu"
      role="menu"
      style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" role="menuitem" onClick={() => {
        setContextMenu(null);
        onCopySession(contextMenu.tab);
      }}>
        Copy Session
      </button>
    </div>}
  </div>;
}
