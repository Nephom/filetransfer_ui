import { useEffect, useRef, useState } from "react";
import { pruneQueueHistory, type QueueProgress } from "../../queue/progress";
import { QueueScheduler } from "../../queue/scheduler";
import { QueueStore } from "../../queue/store";
import { queueStorageKey, readPersistedQueue, type TransferQueueItem } from "./queue-contracts";

// Owns every piece of state behind the Transfer Queue: the queue itself
// (persisted to localStorage, restored on startup with interrupted items
// marked "needs_user_action"), the Queue and Archive-format-choice
// modals' open state, and the mutable refs the queue engine
// (useTransferQueueActions) uses to track in-flight progress samples,
// per-item completion callbacks (used by drag-to-external-app and
// "download to edit" flows), cancelled item ids, and the single-flight
// scheduler that guarantees only one execution runs per queue item id at
// a time. queueOpen/archiveFormatOpen are read by DesktopApp's
// cross-cutting "close topmost overlay" Escape handler, which is why this
// hook (unlike useTransferQueueActions) is called near the top of
// DesktopApp's render body, alongside the other *State hooks.
export function useTransferQueueState() {
  const [transferQueue, setTransferQueue] = useState<TransferQueueItem[]>(readPersistedQueue);
  const queueStoreRef = useRef(new QueueStore<TransferQueueItem>((items) => pruneQueueHistory(items, Date.now())));

  useEffect(() => {
    queueStoreRef.current.replace(transferQueue);
  }, [transferQueue]);

  useEffect(() => {
    // Persist queue visibility/history, but never persist request headers or
    // bodies because they may contain bearer tokens, cookies, or passwords.
    const persisted = transferQueue.map(({ downloadHeaders: _headers, downloadBody: _body, downloadUrl: _url, ...item }) => item);
    localStorage.setItem(queueStorageKey, JSON.stringify(persisted));
  }, [transferQueue]);

  const [queueOpen, setQueueOpen] = useState(false);
  const [archiveFormatOpen, setArchiveFormatOpen] = useState(false);
  const [archiveFormatDraft, setArchiveFormatDraft] = useState<"tar.gz" | "zip" | "queue">("tar.gz");

  const queueProgressSamplesRef = useRef(new Map<string, { bytes: number; at: number }[]>());
  const latestQueueProgressRef = useRef(new Map<string, QueueProgress>());
  const queueCompletionHandlersRef = useRef(new Map<string, (destination: string) => Promise<void>>());
  const cancelledQueueItemsRef = useRef(new Set<string>());
  const queueSchedulerRef = useRef(new QueueScheduler());

  return {
    transferQueue, setTransferQueue,
    queueStoreRef,
    queueOpen, setQueueOpen,
    archiveFormatOpen, setArchiveFormatOpen,
    archiveFormatDraft, setArchiveFormatDraft,
    queueProgressSamplesRef,
    latestQueueProgressRef,
    queueCompletionHandlersRef,
    cancelledQueueItemsRef,
    queueSchedulerRef,
  };
}
