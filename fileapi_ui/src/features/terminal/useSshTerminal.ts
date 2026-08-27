import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import { useTerminalLifecycle } from "./useTerminalLifecycle";
import { useSshEventBridge } from "./useSshEventBridge";
import type { RecordingStats, SshTerminalTab } from "./terminal-contracts";
import { appendSshTabOutput, stripAnsi, VT_SESSION_BOUNDARY_GUARD } from "./terminal-utils";

type NativeRefs = {
  tabsRef: MutableRefObject<SshTerminalTab[]>;
  pendingRequestsRef: MutableRefObject<Record<string, string>>;
  terminalRef: MutableRefObject<Terminal | null>;
  hostRef: RefObject<HTMLDivElement>;
  activeTabIdRef: MutableRefObject<string>;
  outputRef: MutableRefObject<string>;
  sessionIdRef: MutableRefObject<string>;
  connectingRef: MutableRefObject<boolean>;
  writeQueuesRef: MutableRefObject<Map<string, Promise<void>>>;
  recordingWriteQueuesRef: MutableRefObject<Map<string, Promise<void>>>;
  recordingRef: MutableRefObject<boolean>;
  secretPromptRef: MutableRefObject<boolean>;
  shellInputRef: MutableRefObject<string>;
};

type Props = NativeRefs & {
  enabled: boolean;
  activeTabId: string;
  replayOutput: string;
  replayKey: string;
  bracketedPasteControlEnabled: boolean;
  setTabs: React.Dispatch<React.SetStateAction<SshTerminalTab[]>>;
  setConnected: (connected: boolean) => void;
  setNotice: (message: string) => void;
};

/** Owns the two browser-side SSH terminal bridges and their event routing.
 * Connection commands and tab CRUD remain in DesktopApp for this first
 * extraction because they also coordinate Workspace Manager state. */
export function useSshTerminal({
  enabled, activeTabId, replayOutput, replayKey, bracketedPasteControlEnabled,
  setTabs, setConnected, setNotice, tabsRef, pendingRequestsRef, terminalRef,
  hostRef, activeTabIdRef, outputRef, sessionIdRef, connectingRef, writeQueuesRef,
  recordingWriteQueuesRef, recordingRef, secretPromptRef, shellInputRef,
}: Props) {
  useSshEventBridge({
    tabsRef,
    pendingRequestsRef,
    onOutput: (tabId, payload) => {
      const data = payload.data;
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!tab) return;
      if (tab.sessionId !== payload.sessionId) setTabs((current) => current.map((item) => item.id === tabId ? { ...item, sessionId: payload.sessionId, connected: true } : item));
      setTabs((current) => current.map((item) => item.id === tabId ? { ...item, output: appendSshTabOutput(item.output, data) } : item));
      if (tab.recording) {
        const plainChunk = stripAnsi(data);
        const previous = recordingWriteQueuesRef.current.get(tabId) || Promise.resolve();
        const next = previous.catch(() => undefined).then(() => invoke<RecordingStats>("append_ssh_recording", { tabId, rawChunk: data, plainChunk }).then((stats) => {
          setTabs((current) => current.map((item) => item.id === tabId ? { ...item, recordingRawBytes: stats.rawBytes, recordingPlainBytes: stats.plainBytes } : item));
        }).catch(() => undefined));
        recordingWriteQueuesRef.current.set(tabId, next);
      }
      if (tabId === activeTabIdRef.current) {
        outputRef.current = appendSshTabOutput(outputRef.current, data);
        terminalRef.current?.write(data);
        const promptText = stripAnsi(outputRef.current.slice(-240)).replace(/\r/g, "").trimEnd();
        secretPromptRef.current = /(password|passphrase|verification code|token)[^\n:]*[:?]\s*$/i.test(promptText);
      }
    },
    onExit: (tabId, payload) => {
      setTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, connected: false, sessionId: "", output: appendSshTabOutput(item.output, `${VT_SESSION_BOUNDARY_GUARD}\n${payload.data}\n`) }));
      if (tabId === activeTabIdRef.current) {
        setConnected(false);
        connectingRef.current = false;
      }
    },
  });

  useTerminalLifecycle({
    enabled,
    hostRef,
    terminalRef,
    replayOutput,
    replayKey,
    boundaryGuard: VT_SESSION_BOUNDARY_GUARD,
    bracketedPasteControlEnabled,
    onResize: (cols, rows) => {
      const tab = tabsRef.current.find((item) => item.id === activeTabId);
      if (tab?.sessionId) void invoke("ssh_resize", { sessionId: tab.sessionId, cols, rows });
    },
    onData: (data, replaying) => {
      if (replaying) return;
      const tab = tabsRef.current.find((item) => item.id === activeTabId);
      if (!tab?.sessionId) return;
      const previous = writeQueuesRef.current.get(tab.sessionId) || Promise.resolve();
      const next = previous.catch(() => undefined).then(() => invoke<void>("ssh_write", { sessionId: tab.sessionId, data }));
      writeQueuesRef.current.set(tab.sessionId, next.catch(() => undefined));
      if (recordingRef.current && !secretPromptRef.current) {
        if (data === "\r" || data === "\n") {
          if (shellInputRef.current.trim()) {
            const command = `[${new Date().toISOString()}] ${shellInputRef.current}\n`;
            const tabId = tab.id;
            const previous = recordingWriteQueuesRef.current.get(tabId) || Promise.resolve();
            const next = previous.catch(() => undefined).then(() => invoke<RecordingStats>("append_ssh_recording_command", { tabId, line: command }).then((stats) => {
              setTabs((current) => current.map((item) => item.id === tabId ? { ...item, recordingCommandCount: stats.commandCount } : item));
            }).catch(() => undefined));
            recordingWriteQueuesRef.current.set(tabId, next);
          }
          shellInputRef.current = "";
        } else if (data === "\u007f") shellInputRef.current = shellInputRef.current.slice(0, -1);
        else if (!data.startsWith("\u001b")) shellInputRef.current += data;
      }
    },
  });

  useEffect(() => {
    sessionIdRef.current = tabsRef.current.find((item) => item.id === activeTabId)?.sessionId || "";
  }, [activeTabId, sessionIdRef, tabsRef]);

  return { boundaryGuard: VT_SESSION_BOUNDARY_GUARD };
}
