import { useEffect, useRef, type MutableRefObject } from "react";
import { listen } from "@tauri-apps/api/event";

export type SshEventPayload = { sessionId: string; requestId: string; data: string };
export type SshBridgeTab = { id: string; sessionId: string };

export function useSshEventBridge({ tabsRef, pendingRequestsRef, onOutput, onExit }: {
  tabsRef: MutableRefObject<SshBridgeTab[]>;
  pendingRequestsRef: MutableRefObject<Record<string, string>>;
  onOutput: (tabId: string, payload: SshEventPayload) => void;
  onExit: (tabId: string, payload: SshEventPayload) => void;
}) {
  const outputRef = useRef(onOutput);
  const exitRef = useRef(onExit);
  outputRef.current = onOutput;
  exitRef.current = onExit;
  useEffect(() => {
    const resolveTabId = (payload: SshEventPayload) => tabsRef.current.find((tab) => tab.sessionId === payload.sessionId)?.id || pendingRequestsRef.current[payload.requestId];
    const output = listen<SshEventPayload>("ssh-output", (event) => { const id = resolveTabId(event.payload); if (id) outputRef.current(id, event.payload); });
    const exit = listen<SshEventPayload>("ssh-exit", (event) => { const id = resolveTabId(event.payload); if (id) exitRef.current(id, event.payload); });
    return () => { void output.then((dispose) => dispose()); void exit.then((dispose) => dispose()); };
  }, [pendingRequestsRef, tabsRef]);
}
