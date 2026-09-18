import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { useSshEventBridge, type SshEventPayload } from "./useSshEventBridge";
import { useTerminalLifecycle } from "./useTerminalLifecycle";
import { VT_SESSION_BOUNDARY_GUARD } from "./terminal-utils";
import type { SshTerminalTab } from "./terminal-contracts";

type PopupState = {
  tabId: string;
  sessionId: string;
  output: string;
};

const popupQuery = () => {
  const query = new URLSearchParams(window.location.search);
  return {
    tabId: query.get("tabId") || "",
    sessionId: query.get("sessionId") || "",
    title: query.get("title") || "SSH Terminal",
  };
};

export function isSshTerminalPopup() {
  return new URLSearchParams(window.location.search).get("sshPopup") === "1";
}

export function SshTerminalPopup() {
  const { tabId, sessionId, title } = popupQuery();
  const [status, setStatus] = useState("Connecting to terminal…");
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const hostRefsRef = useRef(new Map<string, HTMLDivElement>());
  const tabsRef = useRef<SshTerminalTab[]>([{
    id: tabId,
    title,
    workspaceId: "",
    sshEntryId: "",
    sessionId,
    connected: true,
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
  const initialOutputRef = useRef("");
  const writeQueueRef = useRef(Promise.resolve());

  if (host) hostRefsRef.current.set(tabId, host);
  else hostRefsRef.current.delete(tabId);

  useSshEventBridge({
    tabsRef,
    pendingRequestsRef,
    onOutput: (_resolvedTabId, payload: SshEventPayload) => {
      if (payload.sessionId !== sessionId) return;
      terminalsRef.current.get(tabId)?.write(payload.data);
      setStatus("Connected");
    },
    onExit: (_resolvedTabId, payload: SshEventPayload) => {
      if (payload.sessionId !== sessionId) return;
      setStatus(payload.data || "SSH session ended.");
    },
  });

  useTerminalLifecycle({
    enabled: Boolean(tabId && sessionId),
    layoutKey: `${title}:${Boolean(host)}`,
    tabIds: [tabId],
    activeTabId: tabId,
    hostRefsRef,
    terminalsRef,
    boundaryGuard: VT_SESSION_BOUNDARY_GUARD,
    bracketedPasteControlEnabled: true,
    getPasteSessionId: () => sessionId,
    getInitialOutput: () => initialOutputRef.current,
    onData: (_tabId, data) => {
      const next = writeQueueRef.current.catch(() => undefined).then(() => invoke<void>("ssh_write", { sessionId, data }));
      writeQueueRef.current = next.catch(() => undefined);
    },
    onResize: (_tabId, cols, rows) => {
      void invoke("ssh_resize", { sessionId, cols, rows }).catch((error) => {
        setStatus(`Terminal resize failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    onNotice: setStatus,
  });

  useEffect(() => {
    if (!tabId || !sessionId) {
      setStatus("Invalid SSH terminal window parameters.");
      return undefined;
    }
    const currentWindow = getCurrentWebviewWindow();
    document.title = title;
    void currentWindow.setTitle(title);
    let active = true;
    const unlistenState = currentWindow.listen<PopupState>("ssh-popup-state", (event) => {
      if (!active || event.payload.tabId !== tabId || event.payload.sessionId !== sessionId) return;
      initialOutputRef.current = event.payload.output;
      terminalsRef.current.get(tabId)?.write(`${event.payload.output}${VT_SESSION_BOUNDARY_GUARD}`);
      setStatus("Connected");
    });
    const unlistenClose = currentWindow.onCloseRequested(() => {
      void emit("ssh-popup-closed", { tabId, label: currentWindow.label });
    });
    void emit("ssh-popup-ready", { tabId, sessionId, label: currentWindow.label });
    return () => {
      active = false;
      void unlistenState.then((dispose) => dispose());
      void unlistenClose.then((dispose) => dispose());
    };
  }, [sessionId, tabId, title]);

  return <main className="ssh-terminal-popup" aria-label={title}>
    <header className="ssh-terminal-popup-header">
      <h1>{title}</h1>
      <span>{status}</span>
    </header>
    <div className="ssh-terminal-popup-host" ref={setHost} />
  </main>;
}
