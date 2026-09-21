import { useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { useSshEventBridge, type SshEventPayload } from "./useSshEventBridge";
import { useTerminalLifecycle } from "./useTerminalLifecycle";
import { RecordingPlainTranscript, VT_SESSION_BOUNDARY_GUARD, appendSshTabOutput, stripAnsi } from "./terminal-utils";
import type { SshProfile } from "../ssh/ssh-contracts";
import type { RecordingStats, SshTerminalTab } from "./terminal-contracts";

const popupQuery = () => {
  const query = new URLSearchParams(window.location.search);
  let profile: SshProfile | null = null;
  try {
    profile = JSON.parse(query.get("profile") || "null") as SshProfile | null;
  } catch {
    profile = null;
  }
  return {
    tabId: `popup-${crypto.randomUUID()}`,
    profile,
    title: query.get("title") || "SSH Terminal",
  };
};

export function isSshTerminalPopup() {
  return new URLSearchParams(window.location.search).get("sshPopup") === "1";
}

export function SshTerminalPopup() {
  const [popup] = useState(popupQuery);
  const { tabId, profile, title } = popup;
  const [status, setStatus] = useState("Connecting to terminal…");
  const [sessionId, setSessionId] = useState("");
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
  const hostRefsRef = useRef(new Map<string, HTMLDivElement>());
  const tabsRef = useRef<SshTerminalTab[]>([{
    id: tabId,
    title,
    workspaceId: "",
    sshEntryId: profile?.id || "",
    sessionId: "",
    connected: false,
    output: "",
    recording: false,
    recordingStartedAt: null,
    recordingRawBytes: 0,
    recordingPlainBytes: 0,
    recordingCommandCount: 0,
    savedLogPaths: [],
  }]);
  const pendingRequestsRef = useRef<Record<string, string>>({});
  const terminalsRef = useRef(new Map());
  const outputRef = useRef("");
  const sessionIdRef = useRef("");
  const requestIdRef = useRef("");
  const writeQueueRef = useRef(Promise.resolve());
  const recordingRef = useRef(false);
  const recordingStartedAtRef = useRef<number | null>(null);
  const recordingStatsRef = useRef({ rawBytes: 0, plainBytes: 0, commandCount: 0, saved: false });
  const recordingParserRef = useRef<RecordingPlainTranscript | null>(null);
  const recordingWriteQueueRef = useRef(Promise.resolve());
  const shellInputRef = useRef("");
  const secretPromptRef = useRef(false);
  const closePromiseRef = useRef<Promise<void> | null>(null);
  const currentWindow = getCurrentWebviewWindow();

  const updateRecordingStats = (stats: RecordingStats) => {
    setRecordingRawBytes(stats.rawBytes);
    setRecordingPlainBytes(stats.plainBytes);
    recordingStatsRef.current = { ...stats, saved: false };
  };

  const cleanupRecording = async () => {
    const pending = recordingWriteQueueRef.current;
    await pending.catch(() => undefined);
    if (recordingRef.current) {
      await invoke("stop_ssh_recording", { tabId }).catch(() => undefined);
      recordingRef.current = false;
      setRecording(false);
    }
    await invoke("discard_ssh_recording", { tabId }).catch(() => undefined);
    recordingParserRef.current = null;
    recordingStartedAtRef.current = null;
    shellInputRef.current = "";
    secretPromptRef.current = false;
    recordingStatsRef.current = { rawBytes: 0, plainBytes: 0, commandCount: 0, saved: false };
  };

  const closePopup = () => {
    if (closePromiseRef.current) return closePromiseRef.current;
    const id = sessionIdRef.current;
    sessionIdRef.current = "";
    tabsRef.current[0].sessionId = "";
    tabsRef.current[0].connected = false;
    const closing = cleanupRecording()
      .then(() => id
        ? invoke("ssh_disconnect", { sessionId: id }).catch((error) => {
          setStatus(`SSH disconnect failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        : undefined)
      .then(() => currentWindow.destroy())
      .catch((error) => {
        setStatus(`Unable to close SSH window: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        closePromiseRef.current = null;
      });
    closePromiseRef.current = closing;
    return closing;
  };

  if (host) hostRefsRef.current.set(tabId, host);
  else hostRefsRef.current.delete(tabId);

  useSshEventBridge({
    tabsRef,
    pendingRequestsRef,
    onOutput: (_resolvedTabId, payload: SshEventPayload) => {
      if (payload.sessionId !== sessionIdRef.current && payload.requestId !== requestIdRef.current) return;
      outputRef.current = appendSshTabOutput(outputRef.current, payload.data);
      tabsRef.current[0].output = outputRef.current;
      terminalsRef.current.get(tabId)?.write(payload.data);
      const promptText = stripAnsi(outputRef.current.slice(-240)).replace(/\r/g, "").trimEnd();
      secretPromptRef.current = /(password|passphrase|verification code|token)[^\n:]*[:?]\s*$/i.test(promptText);
      if (recordingRef.current) {
        const parser = recordingParserRef.current;
        const plainChunk = parser ? parser.consume(payload.data) : stripAnsi(payload.data);
        const next = recordingWriteQueueRef.current
          .catch(() => undefined)
          .then(() => invoke<RecordingStats>("append_ssh_recording", { tabId, rawChunk: payload.data, plainChunk }))
          .then(updateRecordingStats)
          .catch(() => undefined);
        recordingWriteQueueRef.current = next;
      }
      setStatus("Connected");
    },
    onExit: (_resolvedTabId, payload: SshEventPayload) => {
      if (payload.sessionId !== sessionIdRef.current) return;
      setStatus(payload.data || "SSH session ended.");
      void closePopup();
    },
  });

  useTerminalLifecycle({
    enabled: Boolean(tabId && sessionId),
    layoutKey: `${title}:${Boolean(host)}:${Boolean(sessionId)}`,
    tabIds: [tabId],
    activeTabId: tabId,
    hostRefsRef,
    terminalsRef,
    boundaryGuard: VT_SESSION_BOUNDARY_GUARD,
    bracketedPasteControlEnabled: true,
    getPasteSessionId: () => sessionIdRef.current,
    getInitialOutput: () => outputRef.current,
    onData: (_tabId, data) => {
      const currentSessionId = sessionIdRef.current;
      if (!currentSessionId) return;
      const next = writeQueueRef.current
        .catch(() => undefined)
        .then(() => invoke<void>("ssh_write", { sessionId: currentSessionId, data }))
        .catch((error) => {
          setStatus(`Terminal input failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      writeQueueRef.current = next.catch(() => undefined);
      if (recordingRef.current && !secretPromptRef.current) {
        if (data === "\r" || data === "\n") {
          if (shellInputRef.current.trim()) {
            const line = `[${new Date().toISOString()}] ${shellInputRef.current}\n`;
            const recordingNext = recordingWriteQueueRef.current
              .catch(() => undefined)
              .then(() => invoke<RecordingStats>("append_ssh_recording_command", { tabId, line }))
              .then(updateRecordingStats)
              .catch(() => undefined);
            recordingWriteQueueRef.current = recordingNext;
          }
          shellInputRef.current = "";
        } else if (data === "\u007f") {
          shellInputRef.current = shellInputRef.current.slice(0, -1);
        } else if (!data.startsWith("\u001b")) {
          shellInputRef.current += data;
        }
      }
    },
    onResize: (_tabId, cols, rows) => {
      const currentSessionId = sessionIdRef.current;
      if (!currentSessionId) return;
      void invoke("ssh_resize", { sessionId: currentSessionId, entryName: profile?.name || title, source: "SSH popup", cols, rows }).catch((error) => {
        setStatus(`Terminal resize failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    onNotice: setStatus,
  });

  const startRecording = async () => {
    if (!sessionIdRef.current || recordingRef.current || startingRecording) return;
    const parser = new RecordingPlainTranscript();
    const plainSeed = parser.consume(outputRef.current);
    setStartingRecording(true);
    try {
      const stats = await invoke<RecordingStats>("start_ssh_recording", {
        tabId,
        rawSeed: outputRef.current,
        plainSeed,
      });
      recordingParserRef.current = parser;
      recordingRef.current = true;
      recordingStartedAtRef.current = Date.now();
      recordingStatsRef.current = { ...stats, saved: false };
      setRecordingRawBytes(stats.rawBytes);
      setRecordingPlainBytes(stats.plainBytes);
      setSavedLogPaths([]);
      setRecording(true);
      setStatus("Recording");
    } catch (error) {
      setStatus(`Recording failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setStartingRecording(false);
    }
  };

  const stopRecording = async () => {
    if (!recordingRef.current) return;
    await recordingWriteQueueRef.current.catch(() => undefined);
    try {
      await invoke("stop_ssh_recording", { tabId });
      recordingRef.current = false;
      recordingParserRef.current = null;
      setRecording(false);
      setStatus("Recording stopped");
    } catch (error) {
      setStatus(`Unable to stop recording: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const openSaveLogDialog = async () => {
    if (recording || (!recordingRawBytes && !recordingPlainBytes)) return;
    try {
      const destination = await invoke<string | null>("pick_local_directory", { path: "" });
      if (destination === null) return;
      setSaveLogDestination(destination);
      setSaveLogName(profile?.name || title);
      setSaveLogNameOpen(true);
    } catch (error) {
      setStatus(`Unable to choose log destination: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const saveLog = async () => {
    const name = saveLogName.trim();
    if (!name || recording || (!recordingRawBytes && !recordingPlainBytes)) return;
    setSavingLog(true);
    try {
      const paths = await invoke<{ raw: string; plain: string; commands: string; metadata: string }>("save_ssh_logs", {
        tabId,
        profileName: name,
        host: profile?.host || "",
        destinationPath: saveLogDestination,
        startedAtIso: recordingStartedAtRef.current ? new Date(recordingStartedAtRef.current).toISOString() : null,
      });
      setSavedLogPaths([paths.raw, paths.plain, paths.commands, paths.metadata]);
      recordingStatsRef.current.saved = true;
      setSaveLogNameOpen(false);
      setStatus("Log saved");
    } catch (error) {
      setStatus(`Unable to save log: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSavingLog(false);
    }
  };

  useEffect(() => {
    document.title = title;
    void currentWindow.setTitle(title);
    if (!profile) {
      setStatus("Invalid SSH entry parameters.");
      return undefined;
    }
    const requestId = `${tabId}-connect`;
    requestIdRef.current = requestId;
    pendingRequestsRef.current[requestId] = tabId;
    let active = true;
    void invoke<string>("ssh_connect", {
      profile: {
        id: profile.id,
        name: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        privateKeyPath: profile.privateKeyPath || null,
      },
      requestId,
    }).then((id) => {
      if (!active) {
        void invoke("ssh_disconnect", { sessionId: id }).catch(() => undefined);
        return;
      }
      sessionIdRef.current = id;
      tabsRef.current[0].sessionId = id;
      tabsRef.current[0].connected = true;
      setSessionId(id);
      setStatus("Connected");
    }).catch((error) => {
      if (active) setStatus(`SSH connection failed: ${error instanceof Error ? error.message : String(error)}`);
      delete pendingRequestsRef.current[requestId];
    });
    const unlistenClose = currentWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      if ((recordingRef.current || (recordingStatsRef.current.rawBytes > 0 && !recordingStatsRef.current.saved)) &&
        !window.confirm("This SSH recording has not been saved. Close and discard it?")) return;
      await closePopup();
    });
    return () => {
      active = false;
      delete pendingRequestsRef.current[requestId];
      void unlistenClose.then((dispose) => dispose());
      void closePopup();
    };
  }, [profile, tabId, title]);

  return <main className="ssh-terminal-popup" aria-label={title}>
    <header className="ssh-terminal-popup-header">
      <h1>{title}</h1>
      <div className="ssh-terminal-popup-header-status">
        <span>{status}</span>
        <button
          type="button"
          className={recording ? "ssh-popup-record recording" : "ssh-popup-record"}
          disabled={!sessionId || savingLog || startingRecording}
          onClick={() => void (recording ? stopRecording() : startRecording())}
        >
          {recording ? "Recording" : "Record"}
        </button>
        <button type="button" disabled={recording || (!recordingRawBytes && !recordingPlainBytes) || savingLog} onClick={() => void openSaveLogDialog()}>Save Log</button>
      </div>
    </header>
    <div
      className="ssh-terminal-popup-host"
      ref={setHost}
      onMouseDown={() => terminalsRef.current.get(tabId)?.focus()}
    />
    {saveLogNameOpen && <div className="modal-cover" onMouseDown={() => setSaveLogNameOpen(false)}>
      <div className="modal log-name-modal" onMouseDown={(event) => event.stopPropagation()}>
        <h2>Name SSH log package</h2>
        <p>Choose the base name for the raw output, text, command, and metadata files.</p>
        <form onSubmit={(event) => { event.preventDefault(); void saveLog(); }}>
          <label>
            Log name
            <input autoFocus value={saveLogName} onChange={(event) => setSaveLogName(event.target.value)} maxLength={120} required />
          </label>
          <small className="field-help">Save location: LOCAL {saveLogDestination || "~"}</small>
          <div className="modal-actions">
            <button type="button" onClick={() => setSaveLogNameOpen(false)} disabled={savingLog}>Cancel</button>
            <button className="confirm" type="submit" disabled={savingLog}>{savingLog ? "Saving…" : "Save Log"}</button>
          </div>
        </form>
      </div>
    </div>}
    {savedLogPaths.length > 0 && <div className="ssh-popup-saved-logs">Saved: {savedLogPaths.join(" · ")}</div>}
  </main>;
}
