import type { MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import type { SshProfile } from "../ssh/ssh-contracts";
import type { RecordingStats, SshTerminalTab, TerminalWorkspaceSession } from "./terminal-contracts";
import { appendSshTabOutput, makeSshTabId, stripAnsi, VT_SESSION_BOUNDARY_GUARD } from "./terminal-utils";

type OperationLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

type Props = {
  tabs: SshTerminalTab[];
  setTabs: React.Dispatch<React.SetStateAction<SshTerminalTab[]>>;
  activeTabId: string;
  setActiveTabId: (id: string) => void;
  terminalInstanceRef: MutableRefObject<Terminal | null>;
  connectAttemptRef: MutableRefObject<Record<string, string>>;
  pendingRequestsRef: MutableRefObject<Record<string, string>>;
  connectingRef: MutableRefObject<boolean>;
  recordingWriteQueuesRef: MutableRefObject<Map<string, Promise<void>>>;
  workspaces: TerminalWorkspaceSession[];
  workspaceId: string;
  setWorkspaceId: (id: string) => void;
  selectedEntryId: string;
  setSelectedEntryId: (id: string) => void;
  setSshProfileId: (id: string) => void;
  setTerminalOpen: (open: boolean) => void;
  loadSshProfileDraft: (profile: SshProfile | undefined) => void;
  onOpenWorkspaceManager: (workspaceId?: string) => void;
  onNotify: (message: string, duration?: number) => void;
  onSetNotice: (message: string) => void;
  run: (action: () => Promise<void>) => void;
  onWriteOperationLog: (operation: string, status: string, sourceLabel: string, destinationLabel: string, detail: string, level?: OperationLogLevel) => void;
  describeError: (error: unknown) => string;
  saveLogNameDraft: string;
  setSaveLogNameDraft: (value: string) => void;
  saveLogDestinationPath: string;
  setSaveLogDestinationPath: (value: string) => void;
  saveLogNameOpen: boolean;
  setSaveLogNameOpen: (open: boolean) => void;
  localPath: string;
};

/** Terminal tab lifecycle, SSH connect/disconnect, and recording start/stop.
 * Depends on Workspace/Session values via props only -- it never reaches
 * into DesktopApp state directly, keeping the Terminal feature's app-level
 * coupling limited to this explicit prop surface. */
export function useSshTerminalActions({
  tabs, setTabs, activeTabId, setActiveTabId, terminalInstanceRef, connectAttemptRef,
  pendingRequestsRef, connectingRef, recordingWriteQueuesRef, workspaces, workspaceId,
  setWorkspaceId, selectedEntryId, setSelectedEntryId, setSshProfileId, setTerminalOpen,
  loadSshProfileDraft, onOpenWorkspaceManager, onNotify, onSetNotice, run, onWriteOperationLog,
  describeError, saveLogNameDraft, setSaveLogNameDraft, saveLogDestinationPath,
  setSaveLogDestinationPath, saveLogNameOpen, setSaveLogNameOpen, localPath,
}: Props) {
  const activeTab = tabs.find((item) => item.id === activeTabId);
  const recordingHasOutput = Boolean(activeTab && (activeTab.recordingRawBytes > 0 || activeTab.recordingPlainBytes > 0));

  const createSshTab = (targetWorkspaceId = workspaceId, entryId = selectedEntryId) => {
    const workspace = workspaces.find((item) => item.id === targetWorkspaceId);
    const profile = workspace?.sshEntries.find((item) => item.id === entryId);
    if (!workspace || !profile) {
      onOpenWorkspaceManager();
      onSetNotice("Select an SSH entry before opening a terminal tab.");
      return "";
    }
    const tab: SshTerminalTab = {
      id: makeSshTabId(),
      title: profile.name || `${profile.username}@${profile.host}`,
      workspaceId: targetWorkspaceId,
      sshEntryId: profile.id,
      sessionId: "",
      connected: false,
      connecting: false,
      output: "",
      recording: false,
      recordingStartedAt: null,
      recordingRawBytes: 0,
      recordingPlainBytes: 0,
      recordingCommandCount: 0,
      savedLogPaths: [],
    };
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
    setWorkspaceId(targetWorkspaceId);
    setSelectedEntryId(entryId);
    setTerminalOpen(true);
    loadSshProfileDraft(profile);
    return tab.id;
  };

  const closeSshTab = (tabId: string) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    const hasUnsavedRecording = tab.recordingStartedAt !== null && tab.savedLogPaths.length === 0;
    if (hasUnsavedRecording && !window.confirm(`This tab has an unsaved SSH recording. Close ${tab.title} and discard it?`)) return;
    if (tab.connected && !window.confirm(`Disconnect and close ${tab.title}?`)) return;
    void run(async () => {
      if (tab.sessionId) await invoke("ssh_disconnect", { sessionId: tab.sessionId });
      // Sweep any pendingRequestsRef entries left mapped to this tab (see
      // the comment in performSshConnect's success path for why they're
      // deliberately not deleted immediately on connect) so closing a tab
      // that was reconnected many times over a long session doesn't leak
      // one stale entry per attempt indefinitely.
      for (const [requestId, mappedTabId] of Object.entries(pendingRequestsRef.current)) {
        if (mappedTabId === tabId) delete pendingRequestsRef.current[requestId];
      }
      if (hasUnsavedRecording) {
        const pending = recordingWriteQueuesRef.current.get(tabId) || Promise.resolve();
        await pending.catch(() => undefined);
        await invoke("discard_ssh_recording", { tabId }).catch(() => undefined);
        recordingWriteQueuesRef.current.delete(tabId);
      }
      setTabs((current) => {
        const remaining = current.filter((item) => item.id !== tabId);
        if (tabId === activeTabId) setActiveTabId(remaining[remaining.length - 1]?.id || "");
        return remaining;
      });
    });
  };

  const selectSshTab = (tab: SshTerminalTab) => {
    setActiveTabId(tab.id);
    setWorkspaceId(tab.workspaceId);
    setSelectedEntryId(tab.sshEntryId);
    window.requestAnimationFrame(() => terminalInstanceRef.current?.focus());
    const profile = workspaces.find((item) => item.id === tab.workspaceId)?.sshEntries.find((item) => item.id === tab.sshEntryId);
    if (profile) {
      setSshProfileId(profile.id);
      loadSshProfileDraft(profile);
    }
  };

  const performSshConnect = (tabId: string, profile: SshProfile) => {
    const attemptId = `${tabId}-${Date.now()}`;
    connectAttemptRef.current[tabId] = attemptId;
    setTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, connecting: true }));
    void run(async () => {
      connectingRef.current = true;
      pendingRequestsRef.current[attemptId] = tabId;
      try {
        const nativeProfile = {
          id: profile.id,
          name: profile.name,
          host: profile.host,
          port: profile.port,
          username: profile.username,
          privateKeyPath: profile.privateKeyPath || null,
        };
        setTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, output: appendSshTabOutput(item.output, `${VT_SESSION_BOUNDARY_GUARD}Connecting to ${profile.username}@${profile.host}:${profile.port}...\n`) }));
        const id = await invoke<string>("ssh_connect", { profile: nativeProfile, requestId: attemptId });
        if (connectAttemptRef.current[tabId] !== attemptId) {
          // Cancelled or superseded while this connect was in flight, but
          // the backend session came up anyway (cancel only stops the
          // frontend from listening, it never aborts the Rust future --
          // see cancelSshConnect). Without this, that session would stay
          // open on the server, still emitting ssh-output/keeping a
          // reader task alive, with nothing in the UI referencing it.
          void invoke("ssh_disconnect", { sessionId: id }).catch(() => undefined);
          delete pendingRequestsRef.current[attemptId];
          return;
        }
        setTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, sessionId: id, connected: true, connecting: false }));
        // Deliberately NOT deleting pendingRequestsRef[attemptId] here on
        // success. The Rust side spawns its ssh-output reader task (see
        // ssh::mod::connect) *before* it returns the session id, so the
        // very first burst of output (a shell's login banner/prompt is
        // usually printed immediately) can reach useSshEventBridge before
        // -- or in the same tick as -- this invoke() promise resolving.
        // useSshEventBridge's resolveTabId() falls back to
        // pendingRequestsRef when tabsRef hasn't been re-synced with this
        // tab's new sessionId yet (React state updates flush
        // asynchronously); deleting this entry right away would reopen
        // that race and silently drop the banner, leaving the terminal
        // showing nothing past "Connecting to...". It's harmless to leave
        // mapped indefinitely (request ids are unique per attempt) --
        // closeSshTab sweeps stale entries for this tab when it's closed.
      } catch (error) {
        if (connectAttemptRef.current[tabId] !== attemptId) return; // cancelled or superseded
        const detail = error instanceof Error ? error.message : String(error);
        setTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, output: appendSshTabOutput(item.output, `${detail}\n`), connecting: false }));
        onSetNotice(detail);
        delete pendingRequestsRef.current[attemptId];
      } finally {
        connectingRef.current = false;
      }
    });
  };

  const cancelSshConnect = (tabId: string) => {
    delete connectAttemptRef.current[tabId];
    setTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, connecting: false, output: appendSshTabOutput(item.output, "Connection attempt cancelled.\n") }));
    onNotify("Connection attempt cancelled. The connection may still complete in the background and will be ignored if it does.");
  };

  const quickConnectSsh = (targetWorkspaceId: string, entryId: string) => {
    const existingTab = tabs.find((tab) => tab.workspaceId === targetWorkspaceId && tab.sshEntryId === entryId);
    const workspace = workspaces.find((item) => item.id === targetWorkspaceId);
    const profile = workspace?.sshEntries.find((item) => item.id === entryId);
    if (existingTab) {
      selectSshTab(existingTab);
      if (!existingTab.connected && !existingTab.connecting && profile) performSshConnect(existingTab.id, profile);
      return;
    }
    if (!workspace || !profile) {
      onOpenWorkspaceManager();
      onSetNotice("Select an SSH entry before connecting.");
      return;
    }
    const tabId = createSshTab(targetWorkspaceId, entryId);
    if (tabId) performSshConnect(tabId, profile);
  };

  const reorderSshTabs = (draggedId: string, targetId: string) => {
    setTabs((current) => {
      const from = current.findIndex((item) => item.id === draggedId);
      const to = current.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const connectSsh = () => {
    const tabId = activeTabId || createSshTab();
    const tab = tabs.find((item) => item.id === tabId);
    const workspace = workspaces.find((item) => item.id === (tab?.workspaceId || workspaceId));
    const profile = workspace?.sshEntries.find((item) => item.id === (tab?.sshEntryId || selectedEntryId));
    if (!tabId || !workspace || !profile) {
      onOpenWorkspaceManager();
      onSetNotice("Select or create a Session with an SSH connection before connecting.");
      return;
    }
    performSshConnect(tabId, profile);
  };

  const disconnectSsh = () => {
    const tab = activeTab;
    if (!tab?.sessionId) return;
    void run(async () => {
      await invoke("ssh_disconnect", { sessionId: tab.sessionId });
      setTabs((current) => current.map((item) => item.id !== tab.id ? item : { ...item, connected: false, sessionId: "", output: appendSshTabOutput(item.output, "\nDisconnected.\n"), recording: false }));
      connectingRef.current = false;
    });
  };

  const startRecording = () => {
    if (!activeTab?.connected) return;
    const tab = activeTab;
    const startedAt = Date.now();
    void run(async () => {
      const stats = await invoke<RecordingStats>("start_ssh_recording", {
        tabId: tab.id,
        rawSeed: tab.output,
        plainSeed: stripAnsi(tab.output),
      });
      setTabs((current) => current.map((item) => item.id !== tab.id ? item : {
        ...item,
        recording: true,
        recordingStartedAt: startedAt,
        recordingRawBytes: stats.rawBytes,
        recordingPlainBytes: stats.plainBytes,
        recordingCommandCount: 0,
        savedLogPaths: [],
      }));
      onWriteOperationLog("ssh_recording", "started", tab.sessionId || tab.id, "LOCAL recording buffer", JSON.stringify({ operationId: tab.id, recordingId: tab.id, sessionId: tab.sessionId, startedAt: new Date(startedAt).toISOString(), seededRawBytes: stats.rawBytes }), "INFO");
      onNotify("SSH output recording started.");
    });
  };

  const stopRecording = () => {
    if (!activeTab) return;
    const tab = activeTab;
    void run(async () => {
      const pending = recordingWriteQueuesRef.current.get(tab.id) || Promise.resolve();
      await pending.catch(() => undefined);
      await invoke("stop_ssh_recording", { tabId: tab.id });
      setTabs((current) => current.map((item) => item.id === tab.id ? { ...item, recording: false } : item));
      onWriteOperationLog("ssh_recording", "stopped", tab.sessionId || tab.id, "LOCAL recording buffer", JSON.stringify({ operationId: tab.id, recordingId: tab.id, sessionId: tab.sessionId, startedAt: tab.recordingStartedAt ? new Date(tab.recordingStartedAt).toISOString() : null, endedAt: new Date().toISOString(), rawBytes: tab.recordingRawBytes, commandCount: tab.recordingCommandCount, durationMs: tab.recordingStartedAt ? Date.now() - tab.recordingStartedAt : undefined }), "INFO");
      onNotify("Recording finalized. Save the log package before disconnecting.");
    });
  };

  const saveSshLogs = () => {
    const tab = activeTab;
    const profile = workspaces.find((item) => item.id === tab?.workspaceId)?.sshEntries.find((item) => item.id === tab?.sshEntryId);
    const logName = saveLogNameDraft.trim();
    if (tab?.recording) {
      onSetNotice("Stop the SSH recording before saving the log package.");
      return;
    }
    if (!tab || !profile || (!tab.recordingRawBytes && !tab.recordingPlainBytes)) {
      onSetNotice("There is no completed SSH recording to save.");
      return;
    }
    if (!logName) {
      onSetNotice("Enter a name for the SSH log package.");
      return;
    }
    void run(async () => {
      const operationId = tab.id;
      const started = performance.now();
      try {
        const paths = await invoke<{ raw: string; plain: string; commands: string; metadata: string }>(
          "save_ssh_logs",
          {
            tabId: tab.id,
            profileName: logName,
            host: profile.host,
            destinationPath: saveLogDestinationPath,
            startedAtIso: tab.recordingStartedAt ? new Date(tab.recordingStartedAt).toISOString() : null,
          },
        );
        setTabs((current) => current.map((item) => item.id === tab.id ? { ...item, savedLogPaths: [paths.raw, paths.plain, paths.commands, paths.metadata] } : item));
        onWriteOperationLog("ssh_recording", "saved", logName, `LOCAL: ~/${saveLogDestinationPath || ""}`, JSON.stringify({ operationId, recordingId: tab.id, sessionId: tab.sessionId, packagePaths: [paths.raw, paths.plain, paths.commands, paths.metadata], durationMs: Math.round(performance.now() - started), rawBytes: tab.recordingRawBytes, commandCount: tab.recordingCommandCount }), "INFO");
        setSaveLogNameOpen(false);
        onNotify(`Saved SSH logs to ${paths.raw}`);
      } catch (error) {
        onWriteOperationLog("ssh_recording", "save_failed", logName, `LOCAL: ~/${saveLogDestinationPath || ""}`, JSON.stringify({ operationId, recordingId: tab.id, durationMs: Math.round(performance.now() - started), failureType: "save", errorMessage: describeError(error) }), "ERROR");
        throw error;
      }
    });
  };

  const openSaveLogDialog = () => {
    if (!recordingHasOutput || activeTab?.recording) return;
    const profile = workspaces.find((item) => item.id === activeTab?.workspaceId)?.sshEntries.find((item) => item.id === activeTab?.sshEntryId);
    setSaveLogNameDraft(profile?.name || "SSH session");
    void run(async () => {
      const selectedPath = await invoke<string | null>("pick_local_directory", { path: localPath });
      if (selectedPath === null) return;
      setSaveLogDestinationPath(selectedPath);
      setSaveLogNameOpen(true);
    });
  };

  return {
    activeTab,
    recordingHasOutput,
    createSshTab,
    closeSshTab,
    selectSshTab,
    performSshConnect,
    cancelSshConnect,
    quickConnectSsh,
    reorderSshTabs,
    connectSsh,
    disconnectSsh,
    startRecording,
    stopRecording,
    saveSshLogs,
    openSaveLogDialog,
  };
}
