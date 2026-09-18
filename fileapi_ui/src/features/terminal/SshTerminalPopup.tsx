import { useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { useSshEventBridge, type SshEventPayload } from "./useSshEventBridge";
import { useTerminalLifecycle } from "./useTerminalLifecycle";
import { VT_SESSION_BOUNDARY_GUARD, appendSshTabOutput } from "./terminal-utils";
import type { SshProfile } from "../ssh/ssh-contracts";
import type { SshTerminalTab } from "./terminal-contracts";

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
  const disconnectStartedRef = useRef(false);

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
      setStatus("Connected");
    },
    onExit: (_resolvedTabId, payload: SshEventPayload) => {
      if (payload.sessionId !== sessionIdRef.current) return;
      setStatus(payload.data || "SSH session ended.");
      sessionIdRef.current = "";
      setSessionId("");
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
      const next = writeQueueRef.current.catch(() => undefined).then(() => invoke<void>("ssh_write", { sessionId: currentSessionId, data }));
      writeQueueRef.current = next.catch(() => undefined);
    },
    onResize: (_tabId, cols, rows) => {
      const currentSessionId = sessionIdRef.current;
      if (!currentSessionId) return;
      void invoke("ssh_resize", { sessionId: currentSessionId, cols, rows }).catch((error) => {
        setStatus(`Terminal resize failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    onNotice: setStatus,
  });

  useEffect(() => {
    const currentWindow = getCurrentWebviewWindow();
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
    const disconnect = () => {
      const id = sessionIdRef.current;
      if (disconnectStartedRef.current || !id) return;
      disconnectStartedRef.current = true;
      void invoke("ssh_disconnect", { sessionId: id }).catch(() => undefined);
    };
    const unlistenClose = currentWindow.onCloseRequested(() => disconnect());
    return () => {
      active = false;
      delete pendingRequestsRef.current[requestId];
      void unlistenClose.then((dispose) => dispose());
      disconnect();
    };
  }, [profile, tabId, title]);

  return <main className="ssh-terminal-popup" aria-label={title}>
    <header className="ssh-terminal-popup-header">
      <h1>{title}</h1>
      <span>{status}</span>
    </header>
    <div className="ssh-terminal-popup-host" ref={setHost} />
  </main>;
}
