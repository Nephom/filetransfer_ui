import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import { useTerminalLifecycle } from "./useTerminalLifecycle";
import { useSshEventBridge } from "./useSshEventBridge";
import type { RecordingStats, SshTerminalTab } from "./terminal-contracts";
import { appendSshTabOutput, resetTerminalConnection, SSH_SESSION_BOUNDARY_GUARD, stripAnsi, VT_SESSION_BOUNDARY_GUARD } from "./terminal-utils";

type NativeRefs = {
  tabsRef: MutableRefObject<SshTerminalTab[]>;
  pendingRequestsRef: MutableRefObject<Record<string, string>>;
  terminalsRef: MutableRefObject<Map<string, Terminal>>;
  hostRefsRef: MutableRefObject<Map<string, HTMLDivElement>>;
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
  tabIds: string[];
  bracketedPasteControlEnabled: boolean;
  setTabs: React.Dispatch<React.SetStateAction<SshTerminalTab[]>>;
  setConnected: (connected: boolean) => void;
  setNotice: (message: string) => void;
};

/** Owns the two browser-side SSH terminal bridges and their event routing.
 * Connection commands and tab CRUD remain in DesktopApp for this first
 * extraction because they also coordinate Workspace Manager state. */
export function useSshTerminal({
  enabled, activeTabId, tabIds, bracketedPasteControlEnabled,
  setTabs, setConnected, setNotice, tabsRef, pendingRequestsRef, terminalsRef,
  hostRefsRef, activeTabIdRef, outputRef, sessionIdRef, connectingRef, writeQueuesRef,
  recordingWriteQueuesRef, recordingRef, secretPromptRef, shellInputRef,
}: Props) {
  // Issue #239 fix: every tab's Terminal is now live-mounted for the whole
  // life of the tab (see useTerminalLifecycle), so unlike before, a
  // background tab's output is written straight into its own real Terminal
  // instance as it arrives -- never buffered for a later from-scratch
  // replay. Remembers the last cols/rows actually reported to the remote
  // PTY per tab so a plain tab switch (panel size unchanged) never fires a
  // redundant `ssh_resize`, which is what forced full-screen programs
  // (opencode, vim, tmux, ...) to redraw via SIGWINCH on every switch.
  const lastReportedSizeRef = useRef(new Map<string, { cols: number; rows: number }>());

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
      // Live write goes to *this* tab's own Terminal instance regardless of
      // whether it is currently the active/visible one -- every open tab's
      // terminal now stays correct in real time instead of only the active
      // tab's shared instance (see useTerminalLifecycle).
      terminalsRef.current.get(tabId)?.write(data);
      if (tabId === activeTabIdRef.current) {
        outputRef.current = appendSshTabOutput(outputRef.current, data);
        const promptText = stripAnsi(outputRef.current.slice(-240)).replace(/\r/g, "").trimEnd();
        secretPromptRef.current = /(password|passphrase|verification code|token)[^\n:]*[:?]\s*$/i.test(promptText);
      }
    },
    onExit: (tabId, payload) => {
      setTabs((current) => current.map((item) => item.id !== tabId ? item : { ...item, connected: false, sessionId: "", output: appendSshTabOutput(item.output, `${SSH_SESSION_BOUNDARY_GUARD}\n${payload.data}\n`) }));
      // Reset the *live* terminal's parser state too, not just the
      // replayed-from-string one -- a connection cut mid escape/control
      // sequence would otherwise leave this still-mounted instance's VT
      // parser stuck "collecting" and swallow the next connection's output
      // as literal control-string payload (see VT_SESSION_BOUNDARY_GUARD's
      // doc comment in main.tsx).
      resetTerminalConnection(terminalsRef.current.get(tabId));
      terminalsRef.current.get(tabId)?.write(`\n${payload.data}\n`);
      lastReportedSizeRef.current.delete(tabId);
      if (tabId === activeTabIdRef.current) {
        setConnected(false);
        connectingRef.current = false;
      }
    },
  });

  useTerminalLifecycle({
    enabled,
    tabIds,
    activeTabId,
    hostRefsRef,
    terminalsRef,
    boundaryGuard: VT_SESSION_BOUNDARY_GUARD,
    bracketedPasteControlEnabled,
    getPasteSessionId: (tabId) => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      return tab?.connected && !tab.connecting ? tab.sessionId : "";
    },
    onNotice: setNotice,
    getInitialOutput: (tabId) => tabsRef.current.find((item) => item.id === tabId)?.output || "",
    onResize: (tabId, cols, rows) => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!tab?.sessionId) return;
      const last = lastReportedSizeRef.current.get(tabId);
      if (last && last.cols === cols && last.rows === rows) return;
      lastReportedSizeRef.current.set(tabId, { cols, rows });
      void invoke("ssh_resize", { sessionId: tab.sessionId, cols, rows });
    },
    onData: (tabId, data) => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!tab?.sessionId) return;
      const previous = writeQueuesRef.current.get(tab.sessionId) || Promise.resolve();
      const next = previous.catch(() => undefined).then(() => invoke<void>("ssh_write", { sessionId: tab.sessionId, data }));
      writeQueuesRef.current.set(tab.sessionId, next.catch(() => undefined));
      if (recordingRef.current && !secretPromptRef.current && tabId === activeTabIdRef.current) {
        if (data === "\r" || data === "\n") {
          if (shellInputRef.current.trim()) {
            const command = `[${new Date().toISOString()}] ${shellInputRef.current}\n`;
            const previousLog = recordingWriteQueuesRef.current.get(tabId) || Promise.resolve();
            const nextLog = previousLog.catch(() => undefined).then(() => invoke<RecordingStats>("append_ssh_recording_command", { tabId, line: command }).then((stats) => {
              setTabs((current) => current.map((item) => item.id === tabId ? { ...item, recordingCommandCount: stats.commandCount } : item));
            }).catch(() => undefined));
            recordingWriteQueuesRef.current.set(tabId, nextLog);
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
