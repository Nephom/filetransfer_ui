import { useRef, useState, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { SshTerminalTab } from "./terminal-contracts";
import type { RecordingPlainTranscript } from "./terminal-utils";

const TERMINAL_MIN_HEIGHT = 160;

export const terminalTitlebarHeight = () =>
  document.querySelector<HTMLElement>(".titlebar")?.getBoundingClientRect().height || 56;

export const terminalHeightBounds = (viewportHeight: number) => {
  const availableHeight = Math.max(120, viewportHeight - terminalTitlebarHeight());
  return {
    min: Math.min(TERMINAL_MIN_HEIGHT, availableHeight),
    max: availableHeight,
  };
};

const clampTerminalHeight = (height: number, viewportHeight: number) => {
  const bounds = terminalHeightBounds(viewportHeight);
  return Math.min(bounds.max, Math.max(bounds.min, Number.isFinite(height) ? height : bounds.min));
};

const initialTerminalHeight = () => {
  const storedHeight = Number(localStorage.getItem("fileapi-terminal-height"));
  const maxHeight = terminalHeightBounds(window.innerHeight).max;
  // Older builds persisted the maximized height. Do not reopen a collapsed
  // Terminal as a full overlay because of that stale value.
  const restoredHeight = Number.isFinite(storedHeight) && storedHeight > 0 && storedHeight < maxHeight
    ? storedHeight
    : 260;
  return clampTerminalHeight(restoredHeight, window.innerHeight);
};

export function useSshTerminalState() {
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [sshTabs, setSshTabs] = useState<SshTerminalTab[]>([]);
  const [activeSshTabId, setActiveSshTabId] = useState("");
  const [sshQuickListOpen, setSshQuickListOpen] = useState(true);
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const previousTerminalHeightRef = useRef(260);
  const [terminalHeight, setTerminalHeight] = useState(initialTerminalHeight);
  const terminalResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [sshConnected, setSshConnected] = useState(false);
  const sshOutputRef = useRef("");
  const [recording, setRecording] = useState(false);
  const [savedLogPaths, setSavedLogPaths] = useState<string[]>([]);
  const [saveLogNameOpen, setSaveLogNameOpen] = useState(false);
  const [saveLogNameDraft, setSaveLogNameDraft] = useState("");
  const [saveLogDestinationPath, setSaveLogDestinationPath] = useState("");
  // Issue #239: one host div / Terminal instance *per SSH tab*, keyed by
  // tab id, rather than a single shared ref -- see useTerminalLifecycle.
  const terminalHostRefsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const terminalInstancesRef = useRef<Map<string, Terminal>>(new Map());
  const sshSessionIdRef = useRef("");
  const sshConnectingRef = useRef(false);
  const sshWriteQueuesRef = useRef(new Map<string, Promise<void>>());
  const recordingWriteQueuesRef = useRef(new Map<string, Promise<void>>());
  const recordingPlainTranscriptsRef = useRef(new Map<string, RecordingPlainTranscript>());
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
    const bounds = terminalHeightBounds(window.innerHeight);
    if (event.clientY <= terminalTitlebarHeight()) {
      previousTerminalHeightRef.current = clampTerminalHeight(start.startHeight, window.innerHeight);
      setTerminalHeight(bounds.max);
      setTerminalMaximized(true);
      return;
    }
    const nextHeight = clampTerminalHeight(start.startHeight + start.startY - event.clientY, window.innerHeight);
    if (nextHeight >= bounds.max) {
      previousTerminalHeightRef.current = clampTerminalHeight(start.startHeight, window.innerHeight);
      setTerminalHeight(bounds.max);
      setTerminalMaximized(true);
      return;
    }
    if (terminalMaximized) {
      setTerminalMaximized(false);
      previousTerminalHeightRef.current = nextHeight;
    } else {
      previousTerminalHeightRef.current = nextHeight;
    }
    setTerminalHeight(nextHeight);
  };
  const beginTerminalResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    terminalResizeRef.current = {
      startY: event.clientY,
      startHeight: terminalMaximized ? terminalHeightBounds(window.innerHeight).max : terminalHeight,
    };
    window.addEventListener("pointermove", resizeTerminal);
    window.addEventListener("pointerup", stopTerminalResize);
  };
  const toggleTerminalMaximized = () => {
    if (terminalMaximized) {
      setTerminalHeight(clampTerminalHeight(previousTerminalHeightRef.current, window.innerHeight));
      setTerminalMaximized(false);
    } else {
      previousTerminalHeightRef.current = clampTerminalHeight(terminalHeight, window.innerHeight);
      setTerminalHeight(terminalHeightBounds(window.innerHeight).max);
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
    terminalHostRefsRef, terminalInstancesRef, sshSessionIdRef, sshConnectingRef, sshWriteQueuesRef,
    recordingWriteQueuesRef, recordingRef, sshSecretPromptRef, activeSshTabIdRef,
    recordingPlainTranscriptsRef,
    pendingSshConnectRequestsRef, connectAttemptRef, sshTabsRef, shellInputRef,
  };
}

export type SshTerminalState = ReturnType<typeof useSshTerminalState>;
export type SshTerminalStateRef = MutableRefObject<SshTerminalTab[]>;
