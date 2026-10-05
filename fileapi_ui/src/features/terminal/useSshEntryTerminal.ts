import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import type { SshProfile } from "../ssh/ssh-contracts";
import { useSshEventBridge, type SshBridgeTab, type SshEventPayload } from "./useSshEventBridge";
import { useTerminalLifecycle } from "./useTerminalLifecycle";
import type { RecordingStats } from "./terminal-contracts";
import {
  RecordingPlainTranscript,
  SSH_SESSION_BOUNDARY_GUARD,
  VT_SESSION_BOUNDARY_GUARD,
  appendSshTabOutput,
  makeSshTabId,
  resetTerminalConnection,
  stripAnsi,
} from "./terminal-utils";

/** What the owner of an SSH entry terminal (main window / taskbar) needs to know. */
export type SshEntryTerminalState = {
  connected: boolean;
  connecting: boolean;
  /** true while a recording runs or has output that was never saved. */
  recordingUnsaved: boolean;
};

export type SshEntryOperationLog = (
  operation: string,
  status: string,
  sourceLabel: string,
  destinationLabel: string,
  detail: string,
  level?: "INFO" | "ERROR",
) => void;

export type SshEntryTerminalOptions = {
  /** The saved SSH entry. Re-read on every Connect, so edits to the entry apply to a reconnect. */
  profile: SshProfile | null;
  title: string;
  /** Origin reported to `ssh_resize` ("SSH popup" / "SSH pane"). */
  source: string;
  /** Connect once on mount. */
  autoConnect: boolean;
  bracketedPasteControlEnabled?: boolean;
  onStateChange?: (state: SshEntryTerminalState) => void;
  onOperationLog?: SshEntryOperationLog;
};

type SaveLogPaths = { raw: string; plain: string; commands: string; metadata: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One SSH entry = one terminal: connection, xterm, recording and Save Log.
 * Used by both the native "Open a new Window" window and the in-app SSH pane,
 * so the two behave identically. The window stays usable after the session
 * ends: `connect()` starts a fresh session in the same xterm.
 */
export function useSshEntryTerminal({
  profile, title, source, autoConnect, bracketedPasteControlEnabled = true, onStateChange, onOperationLog,
}: SshEntryTerminalOptions) {
  const [tabId] = useState(() => `ssh-${makeSshTabId()}`);
  const [notice, setNotice] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingRawBytes, setRecordingRawBytes] = useState(0);
  const [recordingPlainBytes, setRecordingPlainBytes] = useState(0);
  const [savedLogPaths, setSavedLogPaths] = useState<string[]>([]);
  const [saveLogNameOpen, setSaveLogNameOpen] = useState(false);
  const [saveLogName, setSaveLogName] = useState("");
  const [saveLogDestination, setSaveLogDestination] = useState("");
  const [savingLog, setSavingLog] = useState(false);
  const [startingRecording, setStartingRecording] = useState(false);

  const profileRef = useRef(profile);
  profileRef.current = profile;
  const titleRef = useRef(title);
  titleRef.current = title;
  const logRef = useRef(onOperationLog);
  logRef.current = onOperationLog;

  const tabsRef = useRef<SshBridgeTab[]>([{ id: tabId, sessionId: "" }]);
  const hostRefsRef = useRef(new Map<string, HTMLDivElement>());
  const pendingRequestsRef = useRef<Record<string, string>>({});
  const terminalsRef = useRef(new Map<string, Terminal>());
  const outputRef = useRef("");
  const sessionIdRef = useRef("");
  const attemptRef = useRef("");
  const connectingRef = useRef(false);
  const writeQueueRef = useRef(Promise.resolve());
  const recordingRef = useRef(false);
  const recordingStartedAtRef = useRef<number | null>(null);
  const recordingStatsRef = useRef({ rawBytes: 0, plainBytes: 0, commandCount: 0, saved: false });
  const recordingParserRef = useRef<RecordingPlainTranscript | null>(null);
  const recordingWriteQueueRef = useRef(Promise.resolve());
  const shellInputRef = useRef("");
  const secretPromptRef = useRef(false);
  const lastSizeRef = useRef<{ sessionId: string; cols: number; rows: number } | null>(null);
  const disposeRef = useRef<Promise<void> | null>(null);

  if (host) hostRefsRef.current.set(tabId, host);
  else hostRefsRef.current.delete(tabId);

  const liveTerminal = () => terminalsRef.current.get(tabId);

  const updateRecordingStats = (stats: RecordingStats) => {
    setRecordingRawBytes(stats.rawBytes);
    setRecordingPlainBytes(stats.plainBytes);
    recordingStatsRef.current = { ...stats, saved: false };
  };

  // Stops a running recording but keeps what was recorded, so it can still be saved.
  const finishRecording = useCallback(async () => {
    await recordingWriteQueueRef.current.catch(() => undefined);
    if (!recordingRef.current) return;
    recordingRef.current = false;
    recordingParserRef.current = null;
    setRecording(false);
    await invoke("stop_ssh_recording", { tabId }).catch(() => undefined);
  }, [tabId]);

  // Drops the recording completely (the window is closing).
  const discardRecording = useCallback(async () => {
    await finishRecording();
    await invoke("discard_ssh_recording", { tabId }).catch(() => undefined);
    recordingParserRef.current = null;
    recordingStartedAtRef.current = null;
    shellInputRef.current = "";
    secretPromptRef.current = false;
    recordingStatsRef.current = { rawBytes: 0, plainBytes: 0, commandCount: 0, saved: false };
  }, [finishRecording, tabId]);

  const hasUnsavedRecording = useCallback(
    () => recordingRef.current || (recordingStatsRef.current.rawBytes > 0 && !recordingStatsRef.current.saved),
    [],
  );

  // The session is over (remote exit, user Disconnect). Idempotent: the exit
  // event and the Disconnect command may both report the same end.
  const endSession = (endedSessionId: string, message: string) => {
    if (!endedSessionId || sessionIdRef.current !== endedSessionId) return;
    sessionIdRef.current = "";
    tabsRef.current[0].sessionId = "";
    lastSizeRef.current = null;
    secretPromptRef.current = false;
    shellInputRef.current = "";
    outputRef.current = appendSshTabOutput(outputRef.current, `${SSH_SESSION_BOUNDARY_GUARD}\n${message}\n`);
    const terminal = liveTerminal();
    resetTerminalConnection(terminal);
    terminal?.write(`\n${message}\n`);
    void finishRecording();
    setSessionId("");
    setConnecting(false);
    setNotice(message);
  };

  const reportSize = (cols: number, rows: number) => {
    const id = sessionIdRef.current;
    if (!id) return;
    const last = lastSizeRef.current;
    if (last && last.sessionId === id && last.cols === cols && last.rows === rows) return;
    lastSizeRef.current = { sessionId: id, cols, rows };
    void invoke("ssh_resize", { sessionId: id, entryName: profileRef.current?.name || titleRef.current, source, cols, rows }).catch((error) => {
      console.warn("SSH terminal resize failed.", errorText(error));
    });
  };

  useSshEventBridge({
    tabsRef,
    pendingRequestsRef,
    onOutput: (_resolvedTabId, payload: SshEventPayload) => {
      const belongsToSession = Boolean(sessionIdRef.current) && payload.sessionId === sessionIdRef.current;
      const belongsToAttempt = Boolean(attemptRef.current) && payload.requestId === attemptRef.current;
      // Late output of an older session or a cancelled attempt must not reach this terminal.
      if (!belongsToSession && !belongsToAttempt) return;
      outputRef.current = appendSshTabOutput(outputRef.current, payload.data);
      liveTerminal()?.write(payload.data);
      const promptText = stripAnsi(outputRef.current.slice(-240)).replace(/\r/g, "").trimEnd();
      secretPromptRef.current = /(password|passphrase|verification code|token)[^\n:]*[:?]\s*$/i.test(promptText);
      if (recordingRef.current) {
        const parser = recordingParserRef.current;
        const plainChunk = parser ? parser.consume(payload.data) : stripAnsi(payload.data);
        recordingWriteQueueRef.current = recordingWriteQueueRef.current
          .catch(() => undefined)
          .then(() => invoke<RecordingStats>("append_ssh_recording", { tabId, rawChunk: payload.data, plainChunk }))
          .then(updateRecordingStats)
          .catch(() => undefined);
      }
    },
    onExit: (_resolvedTabId, payload: SshEventPayload) => {
      endSession(payload.sessionId, payload.data || "SSH session ended.");
    },
  });

  useTerminalLifecycle({
    // The xterm lives as long as its host: it survives Disconnect and keeps the
    // old output on screen, so a reconnect continues in the same terminal.
    enabled: Boolean(host),
    tabIds: [tabId],
    activeTabId: tabId,
    hostRefsRef,
    terminalsRef,
    boundaryGuard: VT_SESSION_BOUNDARY_GUARD,
    bracketedPasteControlEnabled,
    getPasteSessionId: () => sessionIdRef.current,
    getInitialOutput: () => outputRef.current,
    onData: (_tabId, data) => {
      const currentSessionId = sessionIdRef.current;
      if (!currentSessionId) return;
      writeQueueRef.current = writeQueueRef.current
        .catch(() => undefined)
        .then(() => invoke<void>("ssh_write", { sessionId: currentSessionId, data }))
        .catch((error) => { setNotice(`Terminal input failed: ${errorText(error)}`); });
      if (recordingRef.current && !secretPromptRef.current) {
        if (data === "\r" || data === "\n") {
          if (shellInputRef.current.trim()) {
            const line = `[${new Date().toISOString()}] ${shellInputRef.current}\n`;
            recordingWriteQueueRef.current = recordingWriteQueueRef.current
              .catch(() => undefined)
              .then(() => invoke<RecordingStats>("append_ssh_recording_command", { tabId, line }))
              .then(updateRecordingStats)
              .catch(() => undefined);
          }
          shellInputRef.current = "";
        } else if (data === "\u007f") {
          shellInputRef.current = shellInputRef.current.slice(0, -1);
        } else if (!data.startsWith("\u001b")) {
          shellInputRef.current += data;
        }
      }
    },
    onResize: (_tabId, cols, rows) => reportSize(cols, rows),
    onNotice: setNotice,
  });

  // xterm is measured before the session id exists, so that first size is skipped
  // by reportSize. Once the session is up, hand the known size to the remote PTY.
  useEffect(() => {
    if (!sessionId) return;
    const terminal = terminalsRef.current.get(tabId);
    if (terminal) reportSize(terminal.cols, terminal.rows);
  }, [sessionId]);

  const connect = () => {
    const target = profileRef.current;
    if (!target) {
      setNotice("Invalid SSH entry parameters.");
      return;
    }
    if (sessionIdRef.current || connectingRef.current) return;
    const attemptId = `${tabId}-${Date.now()}`;
    attemptRef.current = attemptId;
    connectingRef.current = true;
    pendingRequestsRef.current[attemptId] = tabId;
    setConnecting(true);
    setNotice("");
    const banner = `Connecting to ${target.username}@${target.host}:${target.port}...\n`;
    outputRef.current = appendSshTabOutput(outputRef.current, `${SSH_SESSION_BOUNDARY_GUARD}${banner}`);
    const terminal = liveTerminal();
    resetTerminalConnection(terminal);
    terminal?.write(banner);
    void invoke<string>("ssh_connect", {
      profile: {
        id: target.id,
        name: target.name,
        host: target.host,
        port: target.port,
        username: target.username,
        privateKeyPath: target.privateKeyPath || null,
      },
      requestId: attemptId,
    }).then((id) => {
      if (attemptRef.current !== attemptId) {
        // Cancelled, superseded or closed while in flight: the backend session came
        // up anyway, so it has to be closed or it would stay open unseen.
        void invoke("ssh_disconnect", { sessionId: id }).catch(() => undefined);
        delete pendingRequestsRef.current[attemptId];
        return;
      }
      // pendingRequestsRef[attemptId] is kept on purpose: the first burst of output
      // can reach the event bridge before this promise resolves (see dispose()).
      sessionIdRef.current = id;
      tabsRef.current[0].sessionId = id;
      connectingRef.current = false;
      setSessionId(id);
      setConnecting(false);
      setNotice("");
    }).catch((error) => {
      if (attemptRef.current !== attemptId) return;
      const detail = errorText(error);
      connectingRef.current = false;
      outputRef.current = appendSshTabOutput(outputRef.current, `${SSH_SESSION_BOUNDARY_GUARD}${detail}\n`);
      const current = liveTerminal();
      resetTerminalConnection(current);
      current?.write(`${detail}\n`);
      delete pendingRequestsRef.current[attemptId];
      setConnecting(false);
      setNotice(`SSH connection failed: ${detail}`);
    });
  };

  const cancelConnect = () => {
    if (!connectingRef.current) return;
    attemptRef.current = "";
    connectingRef.current = false;
    const message = "Connection attempt cancelled.";
    outputRef.current = appendSshTabOutput(outputRef.current, `${SSH_SESSION_BOUNDARY_GUARD}${message}\n`);
    const terminal = liveTerminal();
    resetTerminalConnection(terminal);
    terminal?.write(`${message}\n`);
    setConnecting(false);
    setNotice(message);
  };

  const disconnect = async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    // Invalidate clipboard reads that were started for this session before the command goes out.
    resetTerminalConnection(liveTerminal());
    try {
      await invoke("ssh_disconnect", { sessionId: id });
    } catch (error) {
      // The session is not known to be closed, so the terminal keeps claiming it is live.
      setNotice(`SSH disconnect failed: ${errorText(error)}`);
      return;
    }
    endSession(id, "Disconnected.");
  };

  // Closes everything this terminal owns. Used when its window closes or unmounts.
  const dispose = useCallback((): Promise<void> => {
    if (disposeRef.current) return disposeRef.current;
    attemptRef.current = "";
    connectingRef.current = false;
    const id = sessionIdRef.current;
    sessionIdRef.current = "";
    tabsRef.current[0].sessionId = "";
    const closing = (async () => {
      await discardRecording();
      if (id) await invoke("ssh_disconnect", { sessionId: id }).catch((error) => console.warn("SSH disconnect failed.", errorText(error)));
      // Sweep the request ids kept for the output race above.
      for (const [requestId, mappedTabId] of Object.entries(pendingRequestsRef.current)) {
        if (mappedTabId === tabId) delete pendingRequestsRef.current[requestId];
      }
    })().finally(() => { disposeRef.current = null; });
    disposeRef.current = closing;
    return closing;
  }, [discardRecording, tabId]);

  useEffect(() => {
    if (autoConnect) connect();
    return () => { void dispose(); };
  }, [tabId]);

  const startRecording = async () => {
    if (!sessionIdRef.current || recordingRef.current || startingRecording) return;
    const parser = new RecordingPlainTranscript();
    const plainSeed = parser.consume(outputRef.current);
    const startedAt = Date.now();
    const recordingSessionId = sessionIdRef.current;
    setStartingRecording(true);
    try {
      const stats = await invoke<RecordingStats>("start_ssh_recording", { tabId, rawSeed: outputRef.current, plainSeed });
      recordingParserRef.current = parser;
      recordingRef.current = true;
      recordingStartedAtRef.current = startedAt;
      recordingStatsRef.current = { ...stats, saved: false };
      setRecordingRawBytes(stats.rawBytes);
      setRecordingPlainBytes(stats.plainBytes);
      setSavedLogPaths([]);
      setRecording(true);
      setNotice("");
      logRef.current?.("ssh_recording", "started", recordingSessionId || tabId, "LOCAL recording buffer", JSON.stringify({ operationId: tabId, recordingId: tabId, sessionId: recordingSessionId, startedAt: new Date(startedAt).toISOString(), seededRawBytes: stats.rawBytes }), "INFO");
    } catch (error) {
      setNotice(`Recording failed: ${errorText(error)}`);
    } finally {
      setStartingRecording(false);
    }
  };

  const stopRecording = async () => {
    if (!recordingRef.current) return;
    const stoppedSessionId = sessionIdRef.current;
    await finishRecording();
    setNotice("Recording stopped");
    const stats = recordingStatsRef.current;
    const startedAt = recordingStartedAtRef.current;
    logRef.current?.("ssh_recording", "stopped", stoppedSessionId || tabId, "LOCAL recording buffer", JSON.stringify({ operationId: tabId, recordingId: tabId, sessionId: stoppedSessionId, startedAt: startedAt ? new Date(startedAt).toISOString() : null, endedAt: new Date().toISOString(), rawBytes: stats.rawBytes, commandCount: stats.commandCount, durationMs: startedAt ? Date.now() - startedAt : undefined }), "INFO");
  };

  const hasRecordedOutput = recordingRawBytes > 0 || recordingPlainBytes > 0;

  const openSaveLogDialog = async () => {
    if (recording || !hasRecordedOutput) return;
    try {
      const destination = await invoke<string | null>("pick_local_directory", { path: "" });
      if (destination === null) return;
      setSaveLogDestination(destination);
      setSaveLogName(profileRef.current?.name || titleRef.current);
      setSaveLogNameOpen(true);
    } catch (error) {
      setNotice(`Unable to choose log destination: ${errorText(error)}`);
    }
  };

  const saveLog = async () => {
    const name = saveLogName.trim();
    if (!name || recording || !hasRecordedOutput) return;
    setSavingLog(true);
    const started = performance.now();
    const stats = recordingStatsRef.current;
    try {
      const paths = await invoke<SaveLogPaths>("save_ssh_logs", {
        tabId,
        profileName: name,
        host: profileRef.current?.host || "",
        destinationPath: saveLogDestination,
        startedAtIso: recordingStartedAtRef.current ? new Date(recordingStartedAtRef.current).toISOString() : null,
      });
      const packagePaths = [paths.raw, paths.plain, paths.commands, paths.metadata];
      setSavedLogPaths(packagePaths);
      recordingStatsRef.current = { ...recordingStatsRef.current, saved: true };
      setSaveLogNameOpen(false);
      setNotice("Log saved");
      logRef.current?.("ssh_recording", "saved", name, `LOCAL: ~/${saveLogDestination || ""}`, JSON.stringify({ operationId: tabId, recordingId: tabId, sessionId: sessionIdRef.current, packagePaths, durationMs: Math.round(performance.now() - started), rawBytes: stats.rawBytes, commandCount: stats.commandCount }), "INFO");
    } catch (error) {
      setNotice(`Unable to save log: ${errorText(error)}`);
      logRef.current?.("ssh_recording", "save_failed", name, `LOCAL: ~/${saveLogDestination || ""}`, JSON.stringify({ operationId: tabId, recordingId: tabId, durationMs: Math.round(performance.now() - started), failureType: "save", errorMessage: errorText(error) }), "ERROR");
    } finally {
      setSavingLog(false);
    }
  };

  const connected = Boolean(sessionId);
  const recordingUnsaved = recording || (recordingRawBytes > 0 && savedLogPaths.length === 0);

  const stateRef = useRef(onStateChange);
  stateRef.current = onStateChange;
  useEffect(() => {
    stateRef.current?.({ connected, connecting, recordingUnsaved });
  }, [connected, connecting, recordingUnsaved]);

  const status = connecting
    ? "Connecting…"
    : connected
      ? (recording ? "Recording" : notice || "Connected")
      : notice || "Disconnected";

  return {
    status,
    connected,
    connecting,
    recording,
    recordingUnsaved,
    hasRecordedOutput,
    startingRecording,
    savingLog,
    savedLogPaths,
    saveLogDialog: {
      open: saveLogNameOpen,
      name: saveLogName,
      destination: saveLogDestination,
      setName: setSaveLogName,
      close: () => setSaveLogNameOpen(false),
    },
    setHost,
    focus: () => liveTerminal()?.focus(),
    connect,
    disconnect,
    cancelConnect,
    startRecording,
    stopRecording,
    openSaveLogDialog,
    saveLog,
    dispose,
    hasUnsavedRecording,
  };
}

export type SshEntryTerminalController = ReturnType<typeof useSshEntryTerminal>;
