import { useRef, useState, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { SshTerminalTab } from "./terminal-contracts";

export function useSshTerminalState() {
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [sshTabs, setSshTabs] = useState<SshTerminalTab[]>([]);
  const [activeSshTabId, setActiveSshTabId] = useState("");
  const [sshQuickListOpen, setSshQuickListOpen] = useState(true);
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const previousTerminalHeightRef = useRef(260);
  const [terminalHeight, setTerminalHeight] = useState(() => Number(localStorage.getItem("fileapi-terminal-height")) || 260);
  const terminalResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [sshConnected, setSshConnected] = useState(false);
  const sshOutputRef = useRef("");
  const [recording, setRecording] = useState(false);
  const [savedLogPaths, setSavedLogPaths] = useState<string[]>([]);
  const [saveLogNameOpen, setSaveLogNameOpen] = useState(false);
  const [saveLogNameDraft, setSaveLogNameDraft] = useState("");
  const [saveLogDestinationPath, setSaveLogDestinationPath] = useState("");
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const sshSessionIdRef = useRef("");
  const sshConnectingRef = useRef(false);
  const sshWriteQueuesRef = useRef(new Map<string, Promise<void>>());
  const recordingWriteQueuesRef = useRef(new Map<string, Promise<void>>());
  const recordingRef = useRef(false);
  const sshSecretPromptRef = useRef(false);
  const activeSshTabIdRef = useRef("");
  const pendingSshConnectRequestsRef = useRef<Record<string, string>>({});
  const connectAttemptRef = useRef<Record<string, string>>({});
  const sshTabsRef = useRef<SshTerminalTab[]>([]);
  const shellInputRef = useRef("");

  const stopTerminalResize = () => {
    terminalResizeRef.current = null;
    window.removeEventListener("pointermove", resizeTerminal);
    window.removeEventListener("pointerup", stopTerminalResize);
  };
  const resizeTerminal = (event: PointerEvent) => {
    const start = terminalResizeRef.current;
    if (!start) return;
    setTerminalHeight(Math.max(160, Math.min(window.innerHeight - 180, start.startHeight + start.startY - event.clientY)));
  };
  const beginTerminalResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    terminalResizeRef.current = { startY: event.clientY, startHeight: terminalHeight };
    window.addEventListener("pointermove", resizeTerminal);
    window.addEventListener("pointerup", stopTerminalResize);
  };
  const toggleTerminalMaximized = () => {
    if (terminalMaximized) {
      setTerminalHeight(previousTerminalHeightRef.current);
      setTerminalMaximized(false);
    } else {
      previousTerminalHeightRef.current = terminalHeight;
      setTerminalHeight(Math.max(160, window.innerHeight - 180));
      setTerminalMaximized(true);
    }
  };

  return {
    terminalOpen, setTerminalOpen, sshTabs, setSshTabs, activeSshTabId, setActiveSshTabId,
    sshQuickListOpen, setSshQuickListOpen, terminalMaximized, setTerminalMaximized,
    previousTerminalHeightRef, terminalHeight, setTerminalHeight, terminalResizeRef, sshConnected, setSshConnected,
    stopTerminalResize, resizeTerminal, beginTerminalResize, toggleTerminalMaximized,
    sshOutputRef, recording, setRecording, savedLogPaths, setSavedLogPaths,
    saveLogNameOpen, setSaveLogNameOpen, saveLogNameDraft, setSaveLogNameDraft,
    saveLogDestinationPath, setSaveLogDestinationPath,
    terminalHostRef, terminalInstanceRef, sshSessionIdRef, sshConnectingRef, sshWriteQueuesRef,
    recordingWriteQueuesRef, recordingRef, sshSecretPromptRef, activeSshTabIdRef,
    pendingSshConnectRequestsRef, connectAttemptRef, sshTabsRef, shellInputRef,
  };
}

export type SshTerminalState = ReturnType<typeof useSshTerminalState>;
export type SshTerminalStateRef = MutableRefObject<SshTerminalTab[]>;
