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
  const [sshConnected, setSshConnected] = useState(false);
  const sshOutputRef = useRef("");
  const [recording, setRecording] = useState(false);
  const [savedLogPaths, setSavedLogPaths] = useState<string[]>([]);
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

  return {
    terminalOpen, setTerminalOpen, sshTabs, setSshTabs, activeSshTabId, setActiveSshTabId,
    sshQuickListOpen, setSshQuickListOpen, terminalMaximized, setTerminalMaximized,
    previousTerminalHeightRef, terminalHeight, setTerminalHeight, sshConnected, setSshConnected,
    sshOutputRef, recording, setRecording, savedLogPaths, setSavedLogPaths,
    terminalHostRef, terminalInstanceRef, sshSessionIdRef, sshConnectingRef, sshWriteQueuesRef,
    recordingWriteQueuesRef, recordingRef, sshSecretPromptRef, activeSshTabIdRef,
    pendingSshConnectRequestsRef, connectAttemptRef, sshTabsRef, shellInputRef,
  };
}

export type SshTerminalState = ReturnType<typeof useSshTerminalState>;
export type SshTerminalStateRef = MutableRefObject<SshTerminalTab[]>;
