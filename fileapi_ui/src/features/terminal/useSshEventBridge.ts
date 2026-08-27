import { useEffect, useRef, type MutableRefObject } from "react";
import { listen } from "@tauri-apps/api/event";

export type SshEventPayload = { sessionId: string; requestId: string; data: string };
export type SshBridgeTab = { id: string; sessionId: string };

// A high-output SSH session (a noisy build, `tail -f`, `find /`, ...) can
// emit dozens of `ssh-output` Tauri events per second, one per TCP-sized
// chunk read on the Rust side (see `ssh::mod::connect`'s reader loop). Each
// event previously drove its own independent `onOutput` call, which in
// turn drove its own independent `setSshTabs` state update -- one full
// React state update (and, transitively, one re-render of the entire
// desktop UI, not just the terminal) per raw TCP chunk. Batching same-tab
// chunks that arrive within one animation frame into a single concatenated
// `onOutput` call cuts that down to at most one state update per ~16ms
// regardless of how many chunks Tauri delivered in that window, without
// changing the data any consumer ultimately sees: `onOutput` still receives
// every byte, in the original arrival order, just coalesced into fewer,
// larger calls. `onExit` is intentionally left un-batched -- it fires at
// most once per session lifetime and any pending batched output for that
// tab is flushed immediately beforehand so exit-time consumers (which
// append their own trailing text to `output`) never race a still-pending
// batch.
type PendingBatch = { sessionId: string; requestId: string; chunks: string[] };

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
    const pending = new Map<string, PendingBatch>();
    let frame: number | null = null;
    const flush = () => {
      frame = null;
      // Snapshot-then-clear before calling out: `onOutput` (in main.tsx)
      // can synchronously trigger React state updates whose effects run
      // before this function returns, but it never re-enters `flush`
      // itself, so clearing first is only defensive, not required for
      // correctness here.
      const batches = pending;
      pending.clear();
      for (const [tabId, batch] of batches) {
        outputRef.current(tabId, { sessionId: batch.sessionId, requestId: batch.requestId, data: batch.chunks.join("") });
      }
    };
    const scheduleFlush = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(flush);
    };
    const output = listen<SshEventPayload>("ssh-output", (event) => {
      const id = resolveTabId(event.payload);
      if (!id) return;
      const existing = pending.get(id);
      if (existing) existing.chunks.push(event.payload.data);
      else pending.set(id, { sessionId: event.payload.sessionId, requestId: event.payload.requestId, chunks: [event.payload.data] });
      // Always keep the most recent sessionId/requestId for this tab so a
      // mid-batch reconnect (a new sessionId taking over the same tab) is
      // reflected correctly once this batch flushes.
      const updated = pending.get(id);
      if (updated) { updated.sessionId = event.payload.sessionId; updated.requestId = event.payload.requestId; }
      scheduleFlush();
    });
    const exit = listen<SshEventPayload>("ssh-exit", (event) => {
      const id = resolveTabId(event.payload);
      if (!id) return;
      // Flush this tab's pending output first so `onExit`'s own
      // `output`-appending consumer in main.tsx never races a batch of
      // output that arrived (and was queued) before the exit event but
      // has not been delivered to `onOutput` yet.
      const batch = pending.get(id);
      if (batch) {
        pending.delete(id);
        outputRef.current(id, { sessionId: batch.sessionId, requestId: batch.requestId, data: batch.chunks.join("") });
      }
      exitRef.current(id, event.payload);
    });
    return () => {
      void output.then((dispose) => dispose());
      void exit.then((dispose) => dispose());
      if (frame !== null) { window.cancelAnimationFrame(frame); frame = null; }
      pending.clear();
    };
  }, [pendingRequestsRef, tabsRef]);
}
