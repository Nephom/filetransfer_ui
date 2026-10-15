import { useAppTranslation } from "../../i18n/useAppTranslation";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { locationHeaders } from "../remote-browser/remote-browser-contracts";
import { listen } from "@tauri-apps/api/event";
import {
  formatQueueProgress,
  initialQueueProgress,
  updateQueueProgress as calculateQueueProgress,
  type QueueProgress,
} from "../../queue/progress";
import { classifyQueueError, queueHttpErrorCategory, retryDelayMs } from "../../queue/recovery";
import { assertQueueTransition } from "../../queue/state";
import type { QueueScheduler } from "../../queue/scheduler";
import type { QueueStore } from "../../queue/store";
import { formatSize } from "../../format-utils";
import { getAppLocale, toIntlLocale } from "../../i18n/i18n";
import { formatUiError, UiMessageError, type MessageValues } from "../../i18n/errors";
import { downloadPath } from "../../path-utils";
import { buildManifestPages, planUploadChildren, rebindUploadManifest, type UploadManifestFile, type UploadSessionFile } from "../../queue/upload-plan";
import type { FileItem } from "../../file-item-contracts";
import type { SshProfile } from "../ssh/ssh-contracts";
import type { BrowserDownloadForRemote } from "../browser/browser-contracts";
import type { TransferQueueItem } from "./queue-contracts";

// Minimal structural shape of main.tsx's ApiResponse and NativeApiResponse,
// matching exactly what this hook needs from them -- avoids importing
// main.tsx's own (unexported) types just for their shape.
type ApiLikeResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};
type NativeApiResponse = { status: number; body: number[]; headers?: [string, string][] };
type UploadSourceSnapshot = { path: string; size: number; modified: number };
type UploadSummary = { files: number; directories: number; totalSize: number; sources: UploadSourceSnapshot[] };
type ResumableUploadSession = {
  sessionId: string; clientAttemptId: string; locationId: string; path: string; chunkSize: number;
  expectedFileCount: number; expectedDirectoryCount: number; totalSize: number;
  uploadedSize: number; manifestComplete: boolean; status: string; expiresAt: number;
};
type ResumableSessionPage = {
  session: ResumableUploadSession; files: UploadSessionFile[]; nextOffset: number | null;
  directories: string[]; nextDirectoryOffset: number | null;
};

class UploadChildSemaphore {
  private active = 0;
  private waiters: Array<(release: () => void) => void> = [];

  acquire() {
    if (this.active < 2) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve) => this.waiters.push(resolve));
  }

  private makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(this.makeRelease());
      else this.active -= 1;
    };
  }
}

export type UseTransferQueueActionsParams = {
  run: (action: () => Promise<void>) => Promise<void>;
  notify: (message: string, duration?: number) => void;
  setNotice: (message: string) => void;
  api: (endpoint: string, init?: RequestInit) => Promise<ApiLikeResponse>;
  readError: (response: ApiLikeResponse) => Promise<string>;
  session: { token: string; locationId: string; ignoreTlsErrors: boolean; nativeSessionId?: string; userId?: number | null; locationRevision?: string };
  serverUrl: () => string;
  writeOperationLog: (operation: string, status: string, sourceLabel: string, destinationLabel: string, detail: string, level?: "DEBUG" | "INFO" | "WARN" | "ERROR") => void;
  describeError: (error: unknown) => string;
  path: string;
  localPath: string;
  loadFiles: (nextPath?: string) => Promise<void>;
  activeLocationDisplayName: string | undefined;
  activeManagedWorkspaceName: string | undefined;
  findSshProfileById: (entryId: string) => SshProfile | undefined;
  /** Refreshes the open SFTP window of `entryId` after a transfer finished in `folder` (no-op when no such window is open). */
  refreshSftpWindow: (entryId: string, folder: string) => void;
  // The currently selected API REMOTE items -- only path/isDirectory/name/size
  // are read, so callers can pass a plain array of that shape.
  selectedItems: Pick<FileItem, "name" | "path" | "isDirectory" | "size">[];

  transferQueue: TransferQueueItem[];
  setTransferQueue: (updater: (current: TransferQueueItem[]) => TransferQueueItem[]) => void;
  queueStoreRef: { current: QueueStore<TransferQueueItem> };
  setQueueOpen: (open: boolean) => void;
  archiveFormatOpen: boolean;
  setArchiveFormatOpen: (open: boolean) => void;
  setArchiveFormatDraft: (draft: "tar.gz" | "zip" | "queue") => void;
  queueProgressSamplesRef: { current: Map<string, { bytes: number; at: number }[]> };
  latestQueueProgressRef: { current: Map<string, QueueProgress> };
  queueCompletionHandlersRef: { current: Map<string, (destination: string) => Promise<void>> };
  cancelledQueueItemsRef: { current: Set<string> };
  queueSchedulerRef: { current: QueueScheduler };
};

// Owns every handler behind the Transfer Queue: the queue item lifecycle
// (update/cancel/remove/retry/clear), the upload/download/download-set
// execution engine itself (the actual invoke() calls, progress listeners,
// and retry-with-backoff logic for API and SSH transfers alike), the
// REMOTE-file-browser entry points that build a new queue item and start
// it (download/enqueueDownload/enqueueQueueDownload/enqueueSshDownload),
// and queueDragPreparation (used by drag-to-external-application). State
// lives in useTransferQueueState instead, since two of its flags
// (queueOpen/archiveFormatOpen) are read by DesktopApp's cross-cutting
// "close topmost overlay" Escape handler declared earlier in the render
// body than this hook -- which itself must be called after
// run/notify/api/session/writeOperationLog/describeError, loadFiles, and
// the REMOTE file browser's selectedItems all already exist.
export function useTransferQueueActions({
  run, notify, setNotice, api, readError, session, serverUrl,
  writeOperationLog, describeError, path, localPath, loadFiles,
  activeLocationDisplayName, activeManagedWorkspaceName,
  findSshProfileById, refreshSftpWindow, selectedItems,
  transferQueue, setTransferQueue, queueStoreRef,
  setQueueOpen, archiveFormatOpen, setArchiveFormatOpen, setArchiveFormatDraft,
  queueProgressSamplesRef, latestQueueProgressRef, queueCompletionHandlersRef,
  cancelledQueueItemsRef, queueSchedulerRef,
}: UseTransferQueueActionsParams) {
  const { t } = useAppTranslation();
  const pendingDownloadDestinationRef = useRef<string | null>(null);
  const destinationPickerOpenRef = useRef(false);
  useEffect(() => {
    if (!archiveFormatOpen) pendingDownloadDestinationRef.current = null;
  }, [archiveFormatOpen]);

  const localDestinationDisplayPath = (folder: string) => {
    if (!folder) return "~";
    const normalized = folder.replace(/\\/g, "/");
    return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)
      ? normalized
      : `~/${normalized}`;
  };
  const consumePendingDownloadDestination = () => {
    const destination = pendingDownloadDestinationRef.current;
    pendingDownloadDestinationRef.current = null;
    return destination ?? localPath;
  };

  const queueMessage = (key: string, values?: MessageValues, suffix = "", translatedValues: string[] = []) => ({
    detail: `${key.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? `{{${name}}}`))}${suffix}`,
    detailMessage: { key, values, suffix, translatedValues },
  });
  const queueFailure = (item: TransferQueueItem, decision: ReturnType<typeof classifyQueueError>, completedItems?: number, totalItems?: number) => ({
    category: decision.category,
    message: decision.message,
    ...(decision.translationKey ? { translationKey: decision.translationKey, translationValues: decision.translationValues } : {}),
    ...(completedItems !== undefined ? { completedItems } : {}),
    ...(totalItems !== undefined ? { totalItems } : {}),
    itemId: item.id,
    path: item.paths[0],
    attempt: (item.retryCount || 0) + 1,
    timestamp: Date.now(),
  });
  const translateQueueMessage = (message: NonNullable<TransferQueueItem["detailMessage"]> | NonNullable<TransferQueueItem["labelMessage"]>) => {
    const values = { ...message.values };
    for (const name of message.translatedValues || []) {
      const value = values[name];
      if (typeof value === "string") values[name] = t(value);
    }
    return `${t(message.key, values)}${message.suffix || ""}`;
  };
  // Runtime-only contexts never enter the queue store or localStorage.
  const contexts = useRef(new Map<string, {
    origin: string; sessionId?: string; headers: [string, string][]; ignoreTlsErrors: boolean;
    ownerId?: number | null; locationId: string; locationRevision?: string;
    batchId?: string; uploadSessionId?: string; attemptId?: string; cancel?: () => Promise<void>;
  }>());
  const activeChunkTransfers = useRef(new Map<string, { itemId: string; fileId: string; bytesCompleted: number }>());
  const uploadChildSemaphore = useRef(new UploadChildSemaphore());
  const alive = useRef(true);
  const waits = useRef(new Map<number, () => void>());
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; for (const [timer, resolve] of waits.current) { window.clearTimeout(timer); resolve(); } waits.current.clear(); };
  }, []);
  const captureContext = (item: TransferQueueItem) => {
    let context = contexts.current.get(item.id);
    if (!context) {
      context = { origin: serverUrl(), sessionId: session.nativeSessionId, headers: locationHeaders({ ...session, locationId: item.locationId }), ignoreTlsErrors: session.ignoreTlsErrors, ownerId: session.userId, locationId: item.locationId, locationRevision: session.locationRevision };
      contexts.current.set(item.id, context);
    }
    return context;
  };
  const wait = (ms: number) => new Promise<void>((resolve) => {
    const timer = window.setTimeout(() => { waits.current.delete(timer); resolve(); }, ms);
    waits.current.set(timer, resolve);
  });
  const logQueueEvent = (item: TransferQueueItem, event: string, fields: Record<string, unknown> = {}, level: "DEBUG" | "INFO" | "WARN" | "ERROR" = "INFO") => {
    const destination = item.kind === "upload"
      ? `${item.locationName}:${item.destinationPath || "/"}`
      : `LOCAL: ${localDestinationDisplayPath(item.localDestinationFolder || "")}`;
    writeOperationLog(
      item.kind === "upload" ? "upload" : "download",
      event,
      item.label,
      destination,
      JSON.stringify({
        sourceType: item.browserDownloadId ? "BROWSER" : item.kind === "upload" ? "LOCAL" : "REMOTE",
        destinationType: item.kind === "upload" ? "REMOTE" : "LOCAL",
        itemCount: item.setFiles?.length || item.paths.length || 1,
        retryCount: item.retryCount || 0,
        bytesCompleted: item.progress?.completedBytes || 0,
        bytesTotal: item.progress?.totalBytes || undefined,
        completedItems: item.setCompleted || 0,
        totalItems: item.setFiles?.length || item.paths.length || 1,
        ...fields,
      }),
      level,
    );
  };

  const updateQueueItem = (id: string, update: Partial<TransferQueueItem>) => {
    if (!alive.current) return;
    setTransferQueue((current) => {
      const now = Date.now();
      const updated = current.map((item) => {
        if (item.id !== id) return item;
        // A late invoke/listener callback must not resurrect a cancelled item.
        if (item.status === "cancelled" && update.status && update.status !== "cancelled") return item;
        const terminal = update.status === "completed" || update.status === "failed" || update.status === "cancelled" || update.status === "needs_user_action";
        if (update.status && update.status !== item.status) {
          assertQueueTransition(item.status, update.status);
        }
        const clearDetailMessage = Object.hasOwn(update, "detail") && !Object.hasOwn(update, "detailMessage");
        const clearError = Boolean(update.status && !["failed", "needs_user_action"].includes(update.status));
        const nextItem = {
          ...item,
          ...update,
          ...(clearDetailMessage ? { detailMessage: undefined } : {}),
          ...(clearError ? { error: undefined } : {}),
          ...(terminal ? { finishedAt: item.finishedAt || now } : {}),
        };
        if (update.status === "failed" || update.status === "needs_user_action") {
          nextItem.error = {
            category: update.errorCategory || item.errorCategory || "unknown",
            message: update.detail || item.detail,
            itemId: item.id,
            path: item.paths[0],
            attempt: (update.retryCount || item.retryCount || 0) + 1,
            timestamp: now,
            ...update.error,
          };
        }
        return nextItem;
      });
      const retained = updated;
      queueStoreRef.current.replace(retained);
      return retained;
    });
  };

  const updateQueueProgress = (id: string, completedBytes: number, totalBytes: number | null, completedItems?: number, totalItems?: number) => {
    const previousSample = queueProgressSamplesRef.current.get(id) || [];
    const now = Date.now();
    const progress = calculateQueueProgress(
      transferQueue.find((item) => item.id === id)?.progress,
      completedBytes,
      totalBytes,
      completedItems,
      totalItems,
      previousSample,
    );
    queueProgressSamplesRef.current.set(id, [...previousSample, { bytes: completedBytes, at: now }].filter((sample) => now - sample.at <= 3000));
    latestQueueProgressRef.current.set(id, progress);
    updateQueueItem(id, { progress, ...queueMessage("Transferring...") });
    return progress;
  };

  const isQueueItemCancelled = (id: string) => cancelledQueueItemsRef.current.has(id);

  const cancelQueueItem = (id: string) => {
    const current = transferQueue.find((item) => item.id === id);
    if (!current || ["completed", "failed", "cancelled", "needs_user_action"].includes(current.status)) return;
    cancelledQueueItemsRef.current.add(id);
    const context = contexts.current.get(id);
    if (current.kind === "upload" && !current.sshEntryId && context) {
      updateQueueItem(id, { cancellationRequested: true, ...queueMessage("Cancellation requested. Waiting for the server outcome.") });
      void invoke("cancel_transfer", { transferId: context.attemptId || id }).catch(() => undefined);
      for (const [transferId, active] of activeChunkTransfers.current) {
        if (active.itemId === id) void invoke("cancel_transfer", { transferId }).catch(() => undefined);
      }
      void context.cancel?.();
      return;
    }
    queueProgressSamplesRef.current.delete(id);
    latestQueueProgressRef.current.delete(id);
    queueCompletionHandlersRef.current.delete(id);
    void invoke("cancel_transfer", { transferId: id })
      .then(() => logQueueEvent(current, "cancel_requested", { nativeCancelRequested: true, alreadyRunning: current.status === "running" }))
      .catch((error) => logQueueEvent(current, "cancel_requested", { nativeCancelRequested: false, alreadyRunning: current.status === "running", failureType: "cancel_command", errorMessage: describeError(error) }, "WARN"));
    updateQueueItem(id, { status: "cancelled", ...queueMessage("Cancelled by user.") });
    logQueueEvent(current, "cancelled", { finalCancelledState: true });
  };

  const removeQueueItem = (id: string) => {
    const current = transferQueue.find((item) => item.id === id);
    if (current && !["completed", "failed", "cancelled"].includes(current.status)) {
      if (current.status === "needs_user_action") {
        logQueueEvent(current, "removed", { reason: "user_removed_needs_action", finalStatus: current.status }, "INFO");
        cancelledQueueItemsRef.current.add(id);
        queueProgressSamplesRef.current.delete(id);
        latestQueueProgressRef.current.delete(id);
        queueCompletionHandlersRef.current.delete(id);
        setTransferQueue((items) => items.filter((item) => item.id !== id));
        return;
      }
      cancelQueueItem(id);
      return;
    }
    cancelledQueueItemsRef.current.add(id);
    queueProgressSamplesRef.current.delete(id);
    latestQueueProgressRef.current.delete(id);
    queueCompletionHandlersRef.current.delete(id);
    setTransferQueue((current) => current.filter((item) => item.id !== id));
  };
  const clearQueueHistory = () => {
    setTransferQueue((current) => current.filter((item) => !["completed", "failed", "cancelled", "needs_user_action"].includes(item.status)));
  };
  const clearQueueStatus = (status: TransferQueueItem["status"]) => {
    setTransferQueue((current) => current.filter((item) => item.status !== status));
  };
  const clearFinishedQueue = () => {
    setTransferQueue((current) => current.filter((item) => !["completed", "failed", "cancelled", "needs_user_action"].includes(item.status)));
  };

  const executeQueuedSshUpload = async (item: TransferQueueItem, profile: SshProfile) => {
    writeOperationLog("upload", "started", item.label, `${item.locationName}:${item.destinationPath || "/"}`, "SSH transfer queue upload started.", "DEBUG");
    updateQueueItem(item.id, { status: "running", ...queueMessage("Uploading 0/{{total}} items...", { total: item.paths.length }) });
    let completed = 0;
    try {
      for (const localItemPath of item.paths) {
        if (isQueueItemCancelled(item.id)) return;
        await invoke("ssh_upload_path", { profile, localPath: localItemPath, remoteDestinationFolder: item.destinationPath });
        completed += 1;
        updateQueueItem(item.id, { ...queueMessage("Uploading {{completed}}/{{total}} items...", { completed, total: item.paths.length }) });
      }
      updateQueueItem(item.id, { status: "completed", ...queueMessage("Uploaded {{quantity}} {{unit}} to {{path}}.", { quantity: completed, unit: completed === 1 ? "item" : "items", path: item.destinationPath || "/" }, "", ["unit"]) });
      writeOperationLog("upload", "completed", item.label, `${item.locationName}:${item.destinationPath || "/"}`, `Uploaded ${completed} item(s) via SFTP.`);
      refreshSftpWindow(item.sshEntryId || "", item.destinationPath);
    } catch (error) {
      if (isQueueItemCancelled(item.id)) return;
      const recovery = classifyQueueError(error);
      const detail = recovery.message;
      updateQueueItem(item.id, { status: recovery.needsUserAction ? "needs_user_action" : "failed", detail, errorCategory: recovery.category, error: queueFailure(item, recovery, completed, item.paths.length) });
      writeOperationLog("upload", "failed", item.label, `${item.locationName}:${item.destinationPath || "/"}`, `SSH queued upload failed: ${detail}`, "ERROR");
    }
  };

  const executeQueuedLegacyUpload = async (item: TransferQueueItem) => {
    const context = captureContext(item);
    const attemptId = crypto.randomUUID();
    context.attemptId = attemptId;
    let clientAttemptId = item.clientAttemptId || attemptId;
    const isCurrent = () => alive.current && context.attemptId === attemptId;
    updateQueueItem(item.id, { status: "running", ...queueMessage(item.serverBatchId ? "Reconciling server upload..." : "Preparing upload...") });
    let unlistenProgress: (() => void) | undefined;
    let dispatched = false;
    let cancellationSent = false;
    const request = async (endpoint: string, method = "GET", body?: unknown) => {
      if (!context.sessionId) throw new UiMessageError("The original native session is unavailable. Sign in and re-add the transfer.");
      const raw = await invoke<NativeApiResponse>("api_request", {
        url: `${context.origin}${endpoint}`, method,
        headers: [...context.headers, ...(body === undefined ? [] : [["Content-Type", "application/json"]])],
        body: body === undefined ? undefined : Array.from(new TextEncoder().encode(JSON.stringify(body))),
        ignoreTlsErrors: context.ignoreTlsErrors, sessionId: context.sessionId,
      });
      const text = new TextDecoder().decode(new Uint8Array(raw.body));
      if (raw.status < 200 || raw.status >= 300) throw new UiMessageError("Upload server request failed (HTTP {{status}}).", { status: raw.status }, queueHttpErrorCategory(raw.status));
      return JSON.parse(text);
    };
    context.cancel = async () => {
      if (!context.batchId || cancellationSent || !isCurrent()) return;
      cancellationSent = true;
      try { await request(`/api/progress/batch/${encodeURIComponent(context.batchId)}/cancel`, "POST"); }
      catch {
        updateQueueItem(item.id, { uploadOutcome: "reconcile", ...queueMessage("Server cancellation is unconfirmed. Checking the original batch.") });
      }
    };
    try {
      if (item.serverBatchId) context.batchId = item.serverBatchId;
      const reconciling = Boolean(context.batchId);
      if (!context.batchId) {
        if (isQueueItemCancelled(item.id)) {
          updateQueueItem(item.id, { status: "cancelled", ...queueMessage("Cancelled before server reservation.") });
          return;
        }
        const reservation = await request("/api/upload/batches", "POST", { path: item.destinationPath, clientAttemptId: attemptId });
        if (typeof reservation.batchId !== "string" || !reservation.batchId || reservation.locationId !== context.locationId) throw new UiMessageError("Invalid upload reservation response; no bytes were sent.");
        context.batchId = reservation.batchId;
        updateQueueItem(item.id, { serverBatchId: context.batchId, clientAttemptId: attemptId, serverOrigin: context.origin, ownerId: context.ownerId ?? undefined, locationRevision: context.locationRevision, uploadOutcome: "reserved" });
      }
      if (!isCurrent()) return;
      if (!reconciling && !isQueueItemCancelled(item.id)) {
        const summary = await invoke<{ files: number; directories: number; totalSize: number; sources: { path: string; size: number; modified: number }[] }>("inspect_upload_paths", { paths: item.paths });
        if (!isCurrent()) return;
        unlistenProgress = await listen<{ transferId: string; bytesCompleted: number; bytesTotal: number }>(
          "upload-progress",
          (event) => {
            if (event.payload.transferId !== attemptId || !isCurrent() || isQueueItemCancelled(item.id)) return;
            const { bytesCompleted, bytesTotal } = event.payload;
            const progress = updateQueueProgress(item.id, bytesCompleted, bytesTotal ?? null, 0, summary.files);
            updateQueueItem(item.id, { progress, ...queueMessage("Uploading...") });
          },
        );
        if (!isCurrent()) return;
        updateQueueItem(item.id, { progress: initialQueueProgress(summary.files, summary.totalSize) });
        const currentSources = await invoke<{ files: number; directories: number; totalSize: number; sources: { path: string; size: number; modified: number }[] }>("inspect_upload_paths", { paths: item.paths });
        const sourceChanged = summary.sources.length !== currentSources.sources.length
          || summary.sources.some((source, index) => {
            const current = currentSources.sources[index];
            return !current || current.path !== source.path || current.size !== source.size || current.modified !== source.modified;
          });
        if (sourceChanged) throw new UiMessageError("Upload source changed after it was queued. Re-add the file to upload the new content.");
        if (!isCurrent()) return;
        if (!isQueueItemCancelled(item.id)) {
          dispatched = true;
          updateQueueItem(item.id, { uploadOutcome: "reconcile" });
          try {
            const rawResponse = await invoke<NativeApiResponse>("api_upload_paths", {
              transferId: attemptId, expectedSources: summary.sources,
              url: `${context.origin}/api/upload/multiple`,
              headers: [...context.headers, ["X-Upload-Batch-ID", context.batchId]],
              paths: item.paths, path: item.destinationPath,
              ignoreTlsErrors: context.ignoreTlsErrors, sessionId: context.sessionId,
            });
            if (rawResponse.status >= 200 && rawResponse.status < 300) updateQueueItem(item.id, { uploadOutcome: "accepted" });
          } catch {
            // A lost acceptance response is not permission to send the files again.
            updateQueueItem(item.id, { ...queueMessage("Upload response lost. Reconciling the reserved batch.") });
          }
        }
      }
      unlistenProgress?.(); unlistenProgress = undefined;
      queueProgressSamplesRef.current.delete(item.id);
      for (let attempt = 0; attempt < 600; attempt += 1) {
        if (!isCurrent()) return;
        if (isQueueItemCancelled(item.id)) await context.cancel();
        const batch = await request(`/api/progress/batch/${encodeURIComponent(context.batchId!)}`);
        if (!isCurrent()) return;
        if (!Number.isFinite(batch.transferredSize) || batch.transferredSize < 0 || !Number.isFinite(batch.totalSize) || batch.totalSize < 0) throw new UiMessageError("Invalid server byte counters.");
        const totalBytes = batch.totalSizeKnown === true ? batch.totalSize : null;
        const completedBytes = batch.transferredSize;
        const queueProgress = updateQueueProgress(item.id, completedBytes, totalBytes, batch.successCount, batch.totalFiles);
        if (totalBytes === 0 && batch.status === "completed") {
          // Empty/directory-only batches complete by server settlement, not byte division.
          queueProgress.percentage = 100;
          updateQueueItem(item.id, { progress: queueProgress });
        }
        const detailMessage = queueMessage(
          "{{success}}/{{total}} {{unit}} committed; {{failed}} failed; {{cancelled}} cancelled. {{phase}}",
          {
            success: batch.successCount,
            total: batch.totalFiles,
            unit: batch.totalFiles === 1 ? "file" : "files",
            failed: batch.failedCount || 0,
            cancelled: batch.cancelledCount || 0,
            phase: batch.phase || batch.status,
          },
          "",
          ["unit"],
        );
        updateQueueItem(item.id, detailMessage);
        if (["completed", "cancelled", "failed", "partial_fail", "expired"].includes(batch.status)) {
          const status = batch.status === "completed" ? "completed" : batch.status === "cancelled" ? "cancelled" : "failed";
          updateQueueItem(item.id, { ...detailMessage, status, uploadOutcome: "settled" });
          await loadFiles(path).catch(() => undefined);
          return;
        }
        await wait(1000);
      }
      throw new UiMessageError("Upload progress timed out.");
    } catch (error) {
      if (!isCurrent()) return;
      if (context.batchId && !dispatched && !item.serverBatchId) await context.cancel();
      updateQueueItem(item.id, {
        status: "needs_user_action", uploadOutcome: context.batchId ? "reconcile" : undefined,
        ...(context.batchId
          ? queueMessage("Server outcome unconfirmed. Retry checks the original batch without re-uploading.", undefined, ` ${describeError(error)}`)
          : { detail: describeError(error) }),
      });
    } finally {
      unlistenProgress?.();
      context.cancel = undefined;
    }
  };

  const cleanupBrowserDownloadSource = async (item: TransferQueueItem) => {
    if (!item.browserDownloadId || !item.paths[0]) return "";
    try {
      await invoke("browser_discard_download", {
        downloadId: item.browserDownloadId,
        stagingPath: item.paths[0],
      });
      return "";
    } catch (error) {
      return ` Remote upload completed, but the local staging file could not be removed: ${describeError(error)}`;
    }
  };

  const executeQueuedResumableUpload = async (item: TransferQueueItem) => {
    const context = captureContext(item);
    const attemptId = crypto.randomUUID();
    context.attemptId = attemptId;
    let clientAttemptId = item.clientAttemptId || attemptId;
    if (item.serverOrigin && item.serverOrigin !== context.origin) throw new UiMessageError("The original upload server is unavailable. Re-add the transfer.");
    if (item.ownerId !== undefined && item.ownerId !== context.ownerId) throw new UiMessageError("Sign in as the original upload owner to resume this session.");
    if (item.locationRevision && context.locationRevision && item.locationRevision !== context.locationRevision) {
      throw new UiMessageError("The upload Location changed. Review the existing session before starting a new upload.");
    }

    const isCurrent = () => alive.current && context.attemptId === attemptId;
    const nativeChunkIds = new Set<string>();
    let unlistenProgress: (() => void) | undefined;
    let session: ResumableUploadSession | undefined;
    let sessionFiles: UploadSessionFile[] = [];
    let sourceManifest: UploadManifestFile[] = [];
    let totalBytes = 0;
    const offsets = new Map<string, number>();
    const fileStates = new Map<string, string>();
    const failures: string[] = [];

    const request = async (endpoint: string, method = "GET", body?: unknown) => {
      if (!context.sessionId) throw new UiMessageError("The original native API session is unavailable. Sign in and resume explicitly.");
      const raw = await invoke<NativeApiResponse>("api_request", {
        url: `${context.origin}${endpoint}`, method,
        headers: [...context.headers, ...(body === undefined ? [] : [["Content-Type", "application/json"]])],
        body: body === undefined ? undefined : Array.from(new TextEncoder().encode(JSON.stringify(body))),
        ignoreTlsErrors: context.ignoreTlsErrors, sessionId: context.sessionId,
      });
      const text = new TextDecoder().decode(new Uint8Array(raw.body));
      let parsed: any = {};
      try { parsed = JSON.parse(text || "{}"); } catch { /* converted to a safe API error below */ }
      if (raw.status < 200 || raw.status >= 300) {
        throw Object.assign(new Error(parsed.error?.message || `Upload server request failed (HTTP ${raw.status}).`), {
          status: raw.status, expectedOffset: parsed.expectedOffset, retryAfterMs: parsed.retryAfterMs,
        });
      }
      return parsed;
    };
    context.cancel = async () => {
      if (!context.uploadSessionId || !isCurrent()) return;
      for (const transferId of nativeChunkIds) void invoke("cancel_transfer", { transferId }).catch(() => undefined);
      try { await request(`/api/upload/sessions/${encodeURIComponent(context.uploadSessionId)}/cancel`, "POST"); }
      catch { updateQueueItem(item.id, { uploadOutcome: "resumable", ...queueMessage("Server cancellation is unconfirmed; the same session can be reconciled.") }); }
    };

    const readSession = async (sessionId: string) => {
      let fileOffset = 0, directoryOffset = 0;
      let first = true;
      let current: ResumableSessionPage | undefined;
      const files: UploadSessionFile[] = [], directories: string[] = [];
      while (first || fileOffset < (current?.session.expectedFileCount || 0) || directoryOffset < (current?.session.expectedDirectoryCount || 0)) {
        first = false;
        const page = await request(`/api/upload/sessions/${encodeURIComponent(sessionId)}?offset=${fileOffset}&directoryOffset=${directoryOffset}&limit=100`) as ResumableSessionPage;
        current = page;
        files.push(...page.files);
        directories.push(...(page.directories || []));
        fileOffset = page.nextOffset ?? page.session.expectedFileCount;
        directoryOffset = page.nextDirectoryOffset ?? page.session.expectedDirectoryCount;
      }
      if (!current) throw new UiMessageError("Invalid upload session response.");
      return { session: current.session, files, directories };
    };

    const uploadRequest = async (file: UploadManifestFile, offset: number) => {
      if (!context.sessionId || !session) throw new UiMessageError("Upload session is unavailable.");
      const chunkIndex = Math.floor(offset / session.chunkSize);
      const expectedHash = file.chunkHashes[chunkIndex];
      if (!expectedHash) throw new UiMessageError("Upload manifest is missing a chunk checksum for {{path}}.", { path: file.path }, "validation");
      const length = Math.min(session.chunkSize, file.size - offset);
      const transferId = crypto.randomUUID();
      nativeChunkIds.add(transferId);
      activeChunkTransfers.current.set(transferId, { itemId: item.id, fileId: file.fileId, bytesCompleted: 0 });
      try {
        const response = await invoke<NativeApiResponse>("api_upload_chunk", {
          transferId, url: `${context.origin}/api/upload/sessions/${encodeURIComponent(session.sessionId)}/files/${encodeURIComponent(file.fileId)}/chunks`,
          headers: context.headers, filePath: file.sourcePath, offset, totalSize: file.size,
          chunkSize: session.chunkSize, expectedModified: file.modified, expectedHash,
          ignoreTlsErrors: context.ignoreTlsErrors, sessionId: context.sessionId,
        });
        if (response.status >= 200 && response.status < 300) {
          const body = JSON.parse(new TextDecoder().decode(new Uint8Array(response.body)) || "{}");
          if (Number.isSafeInteger(body.uploadedOffset) && body.uploadedOffset >= offset && body.uploadedOffset <= file.size) {
            offsets.set(file.fileId, body.uploadedOffset);
            updateAggregateProgress();
          }
        }
        return response;
      } finally {
        nativeChunkIds.delete(transferId);
        activeChunkTransfers.current.delete(transferId);
      }
    };

    const refreshFile = async (file: UploadManifestFile) => {
      const page = await request(`/api/upload/sessions/${encodeURIComponent(session!.sessionId)}?offset=${fileStatesIndex.get(file.fileId) || 0}&directoryOffset=0&limit=1`) as ResumableSessionPage;
      const latest = page.files.find(candidate => candidate.fileId === file.fileId);
      if (!latest) throw new UiMessageError("Upload session no longer contains {{path}}.", { path: file.path }, "validation");
      fileStates.set(file.fileId, latest.status);
      offsets.set(file.fileId, latest.uploadedOffset);
      return latest;
    };

    const fileStatesIndex = new Map<string, number>();
    const updateAggregateProgress = () => {
      const confirmedBytes = [...offsets.values()].reduce((sum, value) => sum + value, 0);
      const activeBytes = [...activeChunkTransfers.current.values()]
        .filter(value => value.itemId === item.id)
        .reduce((sum, value) => sum + value.bytesCompleted, 0);
      const completedItems = [...fileStates.values()].filter(status => status === "completed").length;
      const progress = updateQueueProgress(item.id, Math.min(totalBytes, confirmedBytes + activeBytes), totalBytes,
        completedItems, sourceManifest.length);
      updateQueueItem(item.id, { progress });
      return progress;
    };

    const uploadFile = async (file: UploadManifestFile) => {
      let remote = await refreshFile(file);
      if (remote.status === "completed") { updateAggregateProgress(); return; }
      let offset = remote.uploadedOffset;
      for (let retry = 0; offset < file.size;) {
        if (!isCurrent() || isQueueItemCancelled(item.id)) return;
        const chunkBytes = Math.min(session!.chunkSize, file.size - offset);
        try {
          const response = await uploadRequest(file, offset);
          const responseText = new TextDecoder().decode(new Uint8Array(response.body));
          let body: any = {};
          try { body = JSON.parse(responseText || "{}"); } catch { /* handled as failed upload below */ }
          if (response.status >= 200 && response.status < 300) {
            offset = Number(body.uploadedOffset);
            if (!Number.isSafeInteger(offset) || offset <= 0 || offset > file.size) throw new UiMessageError("Invalid upload offset response.");
            offsets.set(file.fileId, offset);
            retry = 0;
            updateAggregateProgress();
            continue;
          }
          if (response.status === 409) {
            remote = await refreshFile(file);
            if (remote.status === "completed") { updateAggregateProgress(); return; }
            if (remote.uploadedOffset > offset) { offset = remote.uploadedOffset; retry = 0; continue; }
          }
          throw Object.assign(new Error(body.error?.message || `Upload chunk failed (HTTP ${response.status}).`), { status: response.status });
        } catch (error) {
          if (!isCurrent() || isQueueItemCancelled(item.id)) return;
          if ((error as { status?: number }).status === 400 || (error as { status?: number }).status === 403 ||
              (error as { status?: number }).status === 404 || (error as { status?: number }).status === 410 ||
              (error as { status?: number }).status === 413 || (error as { status?: number }).status === 507) throw error;
          remote = await refreshFile(file);
          if (remote.status === "completed") { updateAggregateProgress(); return; }
          if (remote.uploadedOffset > offset) { offset = remote.uploadedOffset; retry = 0; continue; }
          if (++retry > 3) throw error;
          updateQueueItem(item.id, { ...queueMessage("Retrying {{path}} from byte {{offset}} ({{attempt}}/3).", { path: file.path, offset, attempt: retry }) });
          await wait(retryDelayMs(retry));
        }
        if (chunkBytes <= 0) throw new UiMessageError("Invalid remaining upload size for {{path}}.", { path: file.path }, "validation");
      }
      if (isQueueItemCancelled(item.id)) return;
      let completed: any;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          completed = await request(`/api/upload/sessions/${encodeURIComponent(session!.sessionId)}/files/${encodeURIComponent(file.fileId)}/complete`, "POST");
          break;
        } catch (error) {
          const delay = (error as { status?: number; retryAfterMs?: number }).status === 409
            ? (error as { retryAfterMs?: number }).retryAfterMs : undefined;
          if (!delay || attempt === 49) throw error;
          await wait(Math.min(1000, delay));
        }
      }
      if (completed.status !== "completed" || completed.uploadedOffset !== file.size) throw new UiMessageError("Server did not finalize {{path}}.", { path: file.path }, "server_error");
      fileStates.set(file.fileId, "completed");
      offsets.set(file.fileId, file.size);
      updateAggregateProgress();
    };

    context.cancel = async () => {
      if (!context.uploadSessionId || !isCurrent()) return;
      for (const transferId of nativeChunkIds) void invoke("cancel_transfer", { transferId }).catch(() => undefined);
      try { await request(`/api/upload/sessions/${encodeURIComponent(context.uploadSessionId)}/cancel`, "POST"); }
      catch { updateQueueItem(item.id, { uploadOutcome: "resumable", ...queueMessage("Server cancellation is unconfirmed; resume checks the same session.") }); }
    };

    try {
      updateQueueItem(item.id, { status: "running", ...queueMessage(item.serverSessionId ? "Checking unfinished upload ranges..." : "Preparing resumable API upload...") });
      if (!context.sessionId) throw new UiMessageError("The original native API session is unavailable. Sign in to the original account and resume explicitly.");
      let preloadedSnapshot: Awaited<ReturnType<typeof readSession>> | undefined;
      if (!context.uploadSessionId && item.serverSessionId) context.uploadSessionId = item.serverSessionId;
      if (!context.uploadSessionId && item.clientAttemptId) {
        try {
          const listed = await request("/api/upload/sessions") as { sessions?: ResumableUploadSession[] };
          const matching = listed.sessions?.find(candidate => candidate.clientAttemptId === item.clientAttemptId &&
            candidate.locationId === item.locationId && candidate.path === item.destinationPath);
          if (matching) context.uploadSessionId = matching.sessionId;
        } catch { /* A repeated clientAttemptId remains idempotent if the list request is unavailable. */ }
      }
      if (context.uploadSessionId) {
        preloadedSnapshot = await readSession(context.uploadSessionId);
        updateQueueItem(item.id, { serverSessionId: context.uploadSessionId });
        if (preloadedSnapshot.session.status === "completed") {
          const completedBytes = preloadedSnapshot.session.totalSize;
          const progress = updateQueueProgress(item.id, completedBytes, completedBytes,
            preloadedSnapshot.session.expectedFileCount, preloadedSnapshot.session.expectedFileCount);
          if (completedBytes === 0) progress.percentage = 100;
          const cleanupWarning = await cleanupBrowserDownloadSource(item);
          updateQueueItem(item.id, { status: "completed", uploadOutcome: "settled", progress,
            ...queueMessage("Resumable upload already completed on the server.", undefined, cleanupWarning) });
          return;
        }
      }
      const summary = await invoke<UploadSummary>("inspect_upload_paths", { paths: item.paths });
      let sessionInfo: ResumableUploadSession | undefined;
      let existingFiles: UploadSessionFile[] = [];
      let existingDirectories: string[] = [];
      if (context.uploadSessionId) {
        const snapshot = preloadedSnapshot || await readSession(context.uploadSessionId);
        sessionInfo = snapshot.session;
        existingFiles = snapshot.files;
        existingDirectories = snapshot.directories;
        if (sessionInfo.status === "completed") {
          updateQueueProgress(item.id, sessionInfo.totalSize, sessionInfo.totalSize, sessionInfo.expectedFileCount, sessionInfo.expectedFileCount);
          const cleanupWarning = await cleanupBrowserDownloadSource(item);
          updateQueueItem(item.id, { status: "completed", uploadOutcome: "settled", ...queueMessage("Resumable upload already completed on the server.", undefined, cleanupWarning) });
          return;
        }
        if (["cancelled", "cancelling", "failed", "expired"].includes(sessionInfo.status)) {
          throw new UiMessageError("The server upload session is {{status}}; it cannot be resumed.", { status: sessionInfo.status }, "validation");
        }
        if (!sessionInfo.manifestComplete) {
          const abandonedSessionId = context.uploadSessionId!;
          await request(`/api/upload/sessions/${encodeURIComponent(abandonedSessionId)}/cancel`, "POST");
          context.uploadSessionId = undefined;
          clientAttemptId = crypto.randomUUID();
          updateQueueItem(item.id, { serverSessionId: undefined, clientAttemptId, uploadOutcome: undefined });
          sessionInfo = undefined;
          existingFiles = [];
          existingDirectories = [];
        } else if (sessionInfo.locationId !== context.locationId || sessionInfo.path !== item.destinationPath) {
          throw new UiMessageError("The unfinished upload belongs to a different Location or destination.");
        }
      }

      let chunkSize = sessionInfo?.chunkSize;
      if (!chunkSize) {
        const options = await request("/api/upload/sessions/config") as { chunkSize?: number };
        chunkSize = options.chunkSize;
      }
      if (typeof chunkSize !== "number" || !Number.isSafeInteger(chunkSize) || chunkSize < 1024 * 1024 || chunkSize > 64 * 1024 * 1024) {
        throw new UiMessageError("The server returned an unsupported upload chunk size.");
      }
      if (isQueueItemCancelled(item.id)) {
        updateQueueItem(item.id, { status: "cancelled", ...queueMessage("Cancelled before upload session creation.") });
        return;
      }
      const manifest = await invoke<{ files: UploadManifestFile[]; directories: string[]; totalSize: number }>(
        "build_api_upload_manifest", { paths: item.paths, expectedSources: summary.sources, chunkSize },
      );
      if (manifest.files.length !== summary.files || manifest.directories.length !== summary.directories || manifest.totalSize !== summary.totalSize) {
        throw new UiMessageError("Upload source inventory changed while creating its checksum manifest.");
      }
      const manifestPages = buildManifestPages(manifest.files, manifest.directories);
      planUploadChildren(manifest.files, 500);
      if (isQueueItemCancelled(item.id)) {
        updateQueueItem(item.id, { status: "cancelled", ...queueMessage("Cancelled before upload session creation.") });
        return;
      }
      sourceManifest = manifest.files;
      totalBytes = manifest.totalSize;

      if (!context.uploadSessionId) {
        updateQueueItem(item.id, { clientAttemptId, serverOrigin: context.origin, ownerId: context.ownerId ?? undefined,
          locationRevision: context.locationRevision, uploadOutcome: "reserved" });
        const created = await request("/api/upload/sessions", "POST", {
          path: item.destinationPath, clientAttemptId, chunkSize,
          fileCount: summary.files, directoryCount: summary.directories,
        }) as ResumableUploadSession;
        if (created.locationId !== context.locationId || created.path !== item.destinationPath || created.chunkSize !== chunkSize) {
          throw new UiMessageError("Upload session target or chunk size did not match the prepared manifest.");
        }
        if (created.status === "completed") {
          updateQueueProgress(item.id, created.totalSize, created.totalSize, created.expectedFileCount, created.expectedFileCount);
          const cleanupWarning = await cleanupBrowserDownloadSource(item);
          updateQueueItem(item.id, { status: "completed", uploadOutcome: "settled", ...queueMessage("The original resumable upload session already completed.", undefined, cleanupWarning) });
          return;
        }
        if (["cancelled", "cancelling", "failed", "expired"].includes(created.status)) {
        throw new UiMessageError("The original upload session is {{status}} and cannot be resent.", { status: created.status }, "validation");
        }
        context.uploadSessionId = created.sessionId;
        sessionInfo = created;
        updateQueueItem(item.id, {
          serverSessionId: created.sessionId, clientAttemptId,
          serverOrigin: context.origin, ownerId: context.ownerId ?? undefined,
          locationRevision: context.locationRevision, uploadOutcome: "resumable",
        });
        if (isQueueItemCancelled(item.id)) {
          await context.cancel?.();
          updateQueueItem(item.id, { status: "cancelled", ...queueMessage("Cancelled before the upload manifest or file bytes were sent.") });
          return;
        }
      }

      if (!sessionInfo) throw new UiMessageError("Upload session response is missing.");
      session = sessionInfo;
      if (!sessionInfo.manifestComplete) {
        for (const page of manifestPages) {
          if (isQueueItemCancelled(item.id)) return;
          await request(`/api/upload/sessions/${encodeURIComponent(context.uploadSessionId!)}/manifest/pages/${page.pageIndex}`, "POST", {
            fileOffset: page.fileOffset, directoryOffset: page.directoryOffset,
            files: page.files.map(({ fileId, path: relativePath, name, size, chunkHashes }) => ({ fileId, path: relativePath, name, size, chunkHashes })),
            directories: page.directories,
          });
        }
        sessionInfo = await request(`/api/upload/sessions/${encodeURIComponent(context.uploadSessionId!)}/manifest/complete`, "POST") as ResumableUploadSession;
        const snapshot = await readSession(context.uploadSessionId!);
        sessionInfo = snapshot.session;
        existingFiles = snapshot.files;
        existingDirectories = snapshot.directories;
      }

      if (existingFiles.length === 0) {
        const snapshot = await readSession(context.uploadSessionId!);
        existingFiles = snapshot.files;
        existingDirectories = snapshot.directories;
        sessionInfo = snapshot.session;
      }
      if (sessionInfo.expectedFileCount !== manifest.files.length || sessionInfo.expectedDirectoryCount !== manifest.directories.length ||
          manifest.directories.some((directory, index) => existingDirectories[index] !== directory)) {
        throw new UiMessageError("The selected upload source no longer matches the server manifest.");
      }
      const files = rebindUploadManifest(manifest.files, existingFiles);
      for (const remote of existingFiles) {
        offsets.set(remote.fileId, remote.uploadedOffset);
        fileStates.set(remote.fileId, remote.status);
        fileStatesIndex.set(remote.fileId, remote.index);
      }
      for (const file of files) {
        if (!fileStatesIndex.has(file.fileId)) throw new UiMessageError("Upload session is missing {{path}}.", { path: file.path }, "validation");
      }
      updateQueueItem(item.id, {
        uploadOutcome: "resumable", uploadChildCount: planUploadChildren(files).length,
        uploadActiveChildren: 0,
        ...queueMessage("Resumable API upload: up to 2 child batches run concurrently. Parallel uploads may use more resources and can be less efficient."),
        progress: initialQueueProgress(files.length, totalBytes),
      });
      unlistenProgress = await listen<{ transferId: string; bytesCompleted: number; bytesTotal: number }>("upload-progress", event => {
        const active = activeChunkTransfers.current.get(event.payload.transferId);
        if (!active || active.itemId !== item.id || !isCurrent() || isQueueItemCancelled(item.id)) return;
        active.bytesCompleted = Math.max(0, Math.min(event.payload.bytesCompleted, event.payload.bytesTotal));
        updateAggregateProgress();
      });
      updateAggregateProgress();

      const children = planUploadChildren(files, 500);
      let nextChild = 0;
      let activeChildren = 0;
      const worker = async () => {
        while (nextChild < children.length && !isQueueItemCancelled(item.id)) {
          const childIndex = nextChild++;
          const release = await uploadChildSemaphore.current.acquire();
          if (isQueueItemCancelled(item.id)) { release(); return; }
          activeChildren += 1;
          updateQueueItem(item.id, { uploadActiveChildren: activeChildren,
            ...queueMessage("Uploading child {{current}}/{{total}}. Up to 2 child batches run concurrently; parallel uploads may use more resources and can be less efficient.", { current: childIndex + 1, total: children.length }) });
          try {
            for (const file of children[childIndex]) {
              if (isQueueItemCancelled(item.id)) return;
              try { await uploadFile(file); }
              catch (error) { failures.push(`${file.path}: ${describeError(error)}`); }
            }
          } finally {
            activeChildren -= 1;
            updateQueueItem(item.id, { uploadActiveChildren: activeChildren });
            release();
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, children.length) }, () => worker()));
      if (isQueueItemCancelled(item.id)) {
        let cancelledSnapshot: Awaited<ReturnType<typeof readSession>>;
        try { cancelledSnapshot = await readSession(context.uploadSessionId!); }
        catch (error) {
          updateQueueItem(item.id, { status: "needs_user_action", uploadOutcome: "resumable",
            ...queueMessage("Cancellation outcome is unconfirmed. Check the same session before resuming.", undefined, ` ${describeError(error)}`) });
          return;
        }
        const serverCompleted = cancelledSnapshot.session.status === "completed" ||
          (cancelledSnapshot.session.status === "uploading" && cancelledSnapshot.files.length === cancelledSnapshot.session.expectedFileCount &&
            cancelledSnapshot.files.every(file => file.status === "completed"));
        if (serverCompleted) {
          const cleanupWarning = await cleanupBrowserDownloadSource(item);
          updateQueueItem(item.id, { status: "completed", uploadOutcome: "settled", ...queueMessage("The server completed the upload before cancellation settled.", undefined, cleanupWarning) });
        } else if (cancelledSnapshot.session.status === "cancelled") {
          updateQueueItem(item.id, { status: "cancelled", uploadOutcome: "resumable", ...queueMessage("Upload cancelled. Completed files are kept; unfinished files can be resumed.") });
        } else {
          updateQueueItem(item.id, { status: "needs_user_action", uploadOutcome: "resumable",
            ...queueMessage("Server cancellation is unconfirmed. Check the same session before resuming unfinished files.") });
        }
        return;
      }
      const finalSnapshot = await readSession(context.uploadSessionId!);
      const completeFiles = finalSnapshot.files.filter(file => file.status === "completed").length;
      const allFilesComplete = completeFiles === finalSnapshot.session.expectedFileCount;
      if (allFilesComplete && finalSnapshot.session.manifestComplete) {
        await request(`/api/upload/sessions/${encodeURIComponent(context.uploadSessionId!)}/complete`, "POST");
        if (context.locationId === session.locationId && item.destinationPath === path) await loadFiles(path).catch(() => undefined);
        const finalProgress = updateQueueProgress(item.id, totalBytes, totalBytes, completeFiles, finalSnapshot.files.length);
        if (totalBytes === 0) finalProgress.percentage = 100;
        const cleanupWarning = await cleanupBrowserDownloadSource(item);
        updateQueueItem(item.id, {
          status: "completed", uploadOutcome: "settled", uploadActiveChildren: 0,
          progress: finalProgress,
          ...queueMessage("Uploaded {{quantity}} {{unit}}; all completed files were verified by the server.", { quantity: completeFiles, unit: completeFiles === 1 ? "file" : "files" }, cleanupWarning, ["unit"]),
        });
      } else {
        const totalFiles = finalSnapshot.session.expectedFileCount;
        const detailMessage = failures.length
          ? queueMessage("{{completed}}/{{total}} {{unit}} completed. {{failure}} Resume continues only unfinished files and byte ranges.", { completed: completeFiles, total: totalFiles, unit: totalFiles === 1 ? "file" : "files", failure: failures[0] }, "", ["unit"])
          : queueMessage("{{completed}}/{{total}} {{unit}} completed. Resume continues only unfinished files and byte ranges.", { completed: completeFiles, total: totalFiles, unit: totalFiles === 1 ? "file" : "files" }, "", ["unit"]);
        updateQueueItem(item.id, { status: "needs_user_action", uploadOutcome: "resumable", uploadActiveChildren: 0, ...detailMessage });
      }
    } catch (error) {
      if (!isCurrent()) return;
      const formattedError = formatUiError(error, t);
      const detail = context.uploadSessionId
        ? queueMessage("Upload session retained. Retry resumes unfinished files and byte ranges only.", undefined, ` ${formattedError}`)
        : { detail: formattedError };
      updateQueueItem(item.id, { status: isQueueItemCancelled(item.id) ? "cancelled" : "needs_user_action",
        uploadOutcome: context.uploadSessionId ? "resumable" : undefined, uploadActiveChildren: 0, ...detail });
    } finally {
      unlistenProgress?.();
      for (const [transferId, active] of activeChunkTransfers.current) {
        if (active.itemId === item.id) activeChunkTransfers.current.delete(transferId);
      }
      context.cancel = undefined;
    }
  };

  const executeQueuedUpload = (item: TransferQueueItem) => item.serverBatchId && !item.serverSessionId
    ? executeQueuedLegacyUpload(item)
    : executeQueuedResumableUpload(item);

  const executeQueuedDownload = async (item: TransferQueueItem) => {
    if (!alive.current || isQueueItemCancelled(item.id)) return;
    const context = captureContext(item);
    const destinationLabel = `LOCAL: ${localDestinationDisplayPath(item.localDestinationFolder || "")}`;
    logQueueEvent(item, "started", { transferId: item.id, kind: item.kind, archiveFormat: item.archiveFormat || null }, "DEBUG");
    updateQueueItem(item.id, { status: "running", ...(item.archiveFormat ? queueMessage("Preparing {{format}} archive...", { format: item.archiveFormat }) : queueMessage("Downloading...")) });
    // download_to_disk streams the response and emits "download-progress"
    // events tagged with this item's id so the queue can show byte-level
    // progress for single-file and archive downloads (previously just a
    // static "Downloading..." label for the whole transfer).
    const unlistenProgress = await listen<{ transferId: string; bytesCompleted: number; bytesTotal?: number }>(
      "download-progress",
      (event) => {
        if (event.payload.transferId !== item.id || !alive.current || isQueueItemCancelled(item.id)) return;
        const { bytesCompleted, bytesTotal } = event.payload;
        const knownTotalBytes = latestQueueProgressRef.current.get(item.id)?.totalBytes
          ?? item.progress?.totalBytes
          ?? null;
        updateQueueProgress(item.id, bytesCompleted, bytesTotal ?? knownTotalBytes);
      },
    );
    try {
      if (item.archiveFormat) {
        await wait(100);
        updateQueueItem(item.id, { ...queueMessage("Streaming {{format}} download...", { format: item.archiveFormat }) });
      }
      if (!alive.current || isQueueItemCancelled(item.id)) return;
      if (!context.sessionId) throw new UiMessageError("The original native session is unavailable. Re-add the transfer.");
      const destination = await invoke<string>("download_to_disk", {
        transferId: item.id,
        url: item.downloadUrl,
        method: item.downloadMethod || "GET",
        headers: item.downloadHeaders || [],
        body: item.downloadBody,
        fileName: item.downloadFileName || "download.bin",
        destinationFolder: item.localDestinationFolder || "",
        ignoreTlsErrors: context.ignoreTlsErrors,
        sessionId: context.sessionId,
      });
      if (isQueueItemCancelled(item.id)) return;
      const completionHandler = queueCompletionHandlersRef.current.get(item.id);
      if (completionHandler) {
        await completionHandler(destination);
        queueCompletionHandlersRef.current.delete(item.id);
      }
      if (isQueueItemCancelled(item.id)) return;
      const latestProgress = latestQueueProgressRef.current.get(item.id) || item.progress;
      updateQueueItem(item.id, {
        status: "completed",
        ...queueMessage("Downloaded to {{destination}}.", { destination }),
      });
      logQueueEvent(item, "completed", { transferId: item.id, destination, bytesCompleted: latestProgress?.completedBytes || 0, bytesTotal: latestProgress?.totalBytes || null }, "INFO");
    } catch (error) {
      if (isQueueItemCancelled(item.id)) return;
      const recovery = classifyQueueError(error);
      const detail = recovery.message;
      const retryCount = item.retryCount || 0;
      if (recovery.retryable && retryCount < 3 && !isQueueItemCancelled(item.id)) {
        const nextItem = { ...item, status: "retrying" as const, retryCount: retryCount + 1, ...queueMessage("Retry {{attempt}}/3 queued", { attempt: retryCount + 1 }), errorCategory: recovery.category };
        updateQueueItem(item.id, nextItem);
        logQueueEvent(nextItem, "retrying", { attempt: retryCount + 1, maximumAttempts: 3, reason: recovery.category }, "WARN");
        logQueueEvent(nextItem, "retry_scheduled", { attempt: retryCount + 1, maximumAttempts: 3, reason: recovery.category, delayMs: retryDelayMs(retryCount + 1) });
        void wait(retryDelayMs(retryCount + 1)).then(() => { if (!alive.current || isQueueItemCancelled(item.id)) return; updateQueueItem(item.id, { status: "queued", ...queueMessage("Retry starting") }); void runQueuedDownload({ ...nextItem, status: "queued" }); });
        return;
      }
      if (recovery.retryable) logQueueEvent(item, "retry_exhausted", { attempt: retryCount, maximumAttempts: 3, reason: recovery.category }, "ERROR");
      updateQueueItem(item.id, { status: recovery.needsUserAction ? "needs_user_action" : "failed", detail: recovery.message, errorCategory: recovery.category, error: queueFailure(item, recovery) });
      logQueueEvent(item, "failed", { transferId: item.id, errorMessage: detail, errorCategory: recovery.category, retryCount }, "ERROR");
    } finally {
      unlistenProgress();
    }
  };

  const executeQueuedDownloadSet = async (item: TransferQueueItem) => {
    if (!alive.current || isQueueItemCancelled(item.id)) return;
    const context = captureContext(item);
    const files = item.setFiles || [];
    const destinationLabel = `LOCAL: ${localDestinationDisplayPath(item.localDestinationFolder || "")}`;
    logQueueEvent(item, "started", { transferId: item.id, kind: item.kind, itemCount: files.length }, "DEBUG");
    updateQueueItem(item.id, { status: "running", ...queueMessage("Downloading 0/{{total}} files...", { total: files.length }), setCompleted: 0 });
    const headers = context.headers;
    let completed = 0;
    let lastDestinationRoot = "";
    try {
      for (const file of files) {
        if (!alive.current || isQueueItemCancelled(item.id)) return;
        if (!context.sessionId) throw new UiMessageError("The original native session is unavailable. Re-add the transfer.");
        // `file.relativePath` already starts with the selected item's own
        // top-level name (the flatten endpoint prefixes it with each
        // selected item's name) -- it must not also be nested under an
        // extra synthetic "<n> selected items" segment here, or a single
        // selected directory would end up duplicated inside itself.
        const destination = await invoke<string>("download_to_disk_at", {
          transferId: item.id,
          url: `${context.origin}/api/files/download/${downloadPath(file.remotePath)}`,
          method: "GET",
          headers,
          body: undefined,
          destinationFolder: item.localDestinationFolder || "",
          relativePath: file.relativePath,
          ignoreTlsErrors: context.ignoreTlsErrors,
          sessionId: context.sessionId,
        });
        completed += 1;
        lastDestinationRoot = destination.slice(0, destination.length - (file.relativePath.length + 1));
        updateQueueItem(item.id, { ...queueMessage("Downloading {{completed}}/{{total}} files...", { completed, total: files.length }), setCompleted: completed });
        const totalBytes = files.reduce((sum, current) => sum + current.size, 0);
        const completedBytes = files.slice(0, completed).reduce((sum, current) => sum + current.size, 0);
        updateQueueProgress(item.id, completedBytes, totalBytes, completed, files.length);
      }
        updateQueueItem(item.id, { status: "completed", ...queueMessage("Downloaded {{quantity}} {{unit}} to {{destination}}.", { quantity: completed, unit: completed === 1 ? "file" : "files", destination: lastDestinationRoot || destinationLabel }, "", ["unit"]) });
      logQueueEvent(item, "completed", { transferId: item.id, completedItems: completed, totalItems: files.length }, "INFO");
    } catch (error) {
      if (isQueueItemCancelled(item.id)) return;
      const recovery = classifyQueueError(error);
      const detail = recovery.message;
      const retryCount = item.retryCount || 0;
      if (recovery.retryable && retryCount < 3 && !isQueueItemCancelled(item.id)) {
        const nextItem = { ...item, status: "retrying" as const, retryCount: retryCount + 1, ...queueMessage("Retry {{attempt}}/3 queued", { attempt: retryCount + 1 }), errorCategory: recovery.category };
        updateQueueItem(item.id, nextItem);
        logQueueEvent(nextItem, "retrying", { attempt: retryCount + 1, maximumAttempts: 3, reason: recovery.category }, "WARN");
        logQueueEvent(nextItem, "retry_scheduled", { attempt: retryCount + 1, maximumAttempts: 3, reason: recovery.category, delayMs: retryDelayMs(retryCount + 1) });
        void wait(retryDelayMs(retryCount + 1)).then(() => { if (!alive.current || isQueueItemCancelled(item.id)) return; updateQueueItem(item.id, { status: "queued", ...queueMessage("Retry starting") }); void runQueuedDownloadSet({ ...nextItem, status: "queued" }); });
        return;
      }
      if (recovery.retryable) logQueueEvent(item, "retry_exhausted", { attempt: retryCount, maximumAttempts: 3, reason: recovery.category }, "ERROR");
      updateQueueItem(item.id, { status: recovery.needsUserAction ? "needs_user_action" : "failed", detail: recovery.message, errorCategory: recovery.category, error: queueFailure(item, recovery, completed, files.length) });
      logQueueEvent(item, "failed", { transferId: item.id, errorMessage: detail, errorCategory: recovery.category, completedItems: completed, totalItems: files.length, retryCount }, "ERROR");
    }
  };

  const executeQueuedSshDownload = async (item: TransferQueueItem, profile: SshProfile, items: FileItem[]) => {
    const destinationLabel = `LOCAL: ${localDestinationDisplayPath(item.localDestinationFolder || "")}`;
    writeOperationLog("download", "started", item.label, destinationLabel, `SSH queued download of ${items.length} item(s) started.`, "DEBUG");
    updateQueueItem(item.id, { status: "running", ...queueMessage("Downloading 0/{{total}} items...", { total: items.length }) });
    let completed = 0;
    let lastDestination = "";
    try {
      for (const file of items) {
        if (isQueueItemCancelled(item.id)) return;
        lastDestination = await invoke<string>("ssh_download_path", {
          profile,
          remotePath: file.path,
          isDirectory: file.isDirectory,
          localDestinationFolder: item.localDestinationFolder || "",
        });
        completed += 1;
        updateQueueItem(item.id, { ...queueMessage("Downloading {{completed}}/{{total}} items...", { completed, total: items.length }) });
      }
      updateQueueItem(item.id, { status: "completed", ...queueMessage("Downloaded {{quantity}} {{unit}} to {{destination}}.", { quantity: completed, unit: completed === 1 ? "item" : "items", destination: lastDestination.split("/").slice(0, -1).join("/") || destinationLabel }, "", ["unit"]) });
      writeOperationLog("download", "completed", item.label, destinationLabel, `Downloaded ${completed} item(s) via SFTP.`);
    } catch (error) {
      if (isQueueItemCancelled(item.id)) return;
      const recovery = classifyQueueError(error);
      const detail = recovery.message;
      updateQueueItem(item.id, { status: recovery.needsUserAction ? "needs_user_action" : "failed", detail: recovery.message, errorCategory: recovery.category, error: queueFailure(item, recovery, completed, items.length) });
      writeOperationLog("download", "failed", item.label, destinationLabel, `SSH queued download failed: ${detail}`, "ERROR");
    }
  };

  const runOnce = (id: string, execute: () => Promise<void>) => queueSchedulerRef.current.runExclusive(id, execute);
  const runQueuedSshUpload = (item: TransferQueueItem, profile: SshProfile) => runOnce(item.id, () => executeQueuedSshUpload(item, profile));
  const runQueuedUpload = (item: TransferQueueItem) => { captureContext(item); return runOnce(item.id, () => executeQueuedUpload(item)); };
  const runQueuedDownload = (item: TransferQueueItem) => { captureContext(item); return runOnce(item.id, () => executeQueuedDownload(item)); };
  const runQueuedDownloadSet = (item: TransferQueueItem) => { captureContext(item); return runOnce(item.id, () => executeQueuedDownloadSet(item)); };
  const runQueuedSshDownload = (item: TransferQueueItem, profile: SshProfile, items: FileItem[]) => runOnce(item.id, () => executeQueuedSshDownload(item, profile, items));

  const enqueueBrowserUpload = async (download: BrowserDownloadForRemote) => {
    if (!session.nativeSessionId || download.locationId !== session.locationId) {
      throw new UiMessageError("The selected API Location changed. Choose the current Location again before uploading this Browser download.");
    }
    const summary = await invoke<UploadSummary>("inspect_upload_paths", { paths: [download.stagingPath] });
    if (summary.files !== 1 || summary.directories !== 0 || summary.sources.length !== 1) {
      throw new UiMessageError("The Browser download staging file is not a single uploadable file.");
    }
    const item: TransferQueueItem = {
      id: crypto.randomUUID(),
      label: download.fileName,
      kind: "upload",
      paths: [summary.sources[0].path],
      destinationPath: download.destinationPath,
      locationId: download.locationId,
      locationName: download.locationName,
      status: "queued",
      ...queueMessage("Browser download is ready; waiting to upload to the API Remote."),
      progress: initialQueueProgress(1, summary.totalSize),
      browserDownloadId: download.downloadId,
    };
    setTransferQueue((current) => [...current, item]);
    setQueueOpen(true);
    void runQueuedUpload(item);
  };

  const retryDesktopQueueItem = (item: TransferQueueItem) => {
    let context = contexts.current.get(item.id);
    const origin = serverUrl();
    const explicitUploadRecovery = Boolean((item.serverSessionId || item.clientAttemptId) && session.nativeSessionId &&
      item.serverOrigin === origin && item.ownerId === session.userId && item.locationId === session.locationId &&
      (!item.locationRevision || !session.locationRevision || item.locationRevision === session.locationRevision));
    if (!item.sshEntryId && explicitUploadRecovery &&
        (!context || context.sessionId !== session.nativeSessionId || context.origin !== origin)) {
      context = {
        origin,
        sessionId: session.nativeSessionId,
        headers: locationHeaders({ ...session, locationId: item.locationId }),
        ignoreTlsErrors: session.ignoreTlsErrors,
        ownerId: session.userId,
        locationId: item.locationId,
        locationRevision: session.locationRevision,
        uploadSessionId: item.serverSessionId,
      };
      contexts.current.set(item.id, context);
    }
    if (!item.sshEntryId && (!context || context.sessionId !== session.nativeSessionId || context.origin !== origin || context.ownerId !== session.userId)) {
      setNotice(item.serverSessionId || item.clientAttemptId
        ? "Resume requires the original server, account, Location, and a fresh local source verification."
        : item.serverBatchId
          ? "The original upload session is unavailable. Server outcome is unconfirmed; do not re-upload automatically."
          : "The original transfer session is unavailable. Re-add the transfer to authenticate again.");
      return;
    }
    if (item.kind === "upload" && item.uploadOutcome === "settled") {
      setNotice(t("This batch has settled. Review its partial results before adding any remaining files."));
      return;
    }
    if (item.kind === "download" && !item.sshEntryId && !item.downloadUrl) {
      setNotice(t("This restored download no longer contains its request credentials. Re-add the download to retry it safely."));
      return;
    }
    if (!(["failed", "needs_user_action"] as string[]).includes(item.status)) return;
    if (!item.cancellationRequested) cancelledQueueItemsRef.current.delete(item.id);
    const retryItem = { ...item, status: "queued" as const, ...queueMessage("Retry queued"), finishedAt: undefined };
    updateQueueItem(item.id, retryItem);
    writeOperationLog(item.kind === "upload" ? "upload" : "download", "retry", item.label, item.destinationPath, `Manual retry requested (attempt ${(item.retryCount || 0) + 1}).`, "INFO");
    if (retryItem.sshEntryId) {
      const profile = findSshProfileById(retryItem.sshEntryId);
      if (!profile) {
        updateQueueItem(item.id, { status: "needs_user_action", ...queueMessage("The SSH connection for this transfer is no longer available.") });
        return;
      }
      void (retryItem.kind === "download" ? runQueuedSshDownload(retryItem, profile, retryItem.sshItems || []) : runQueuedSshUpload(retryItem, profile));
      return;
    }
    void (retryItem.kind === "download" ? runQueuedDownload(retryItem) : retryItem.kind === "download-set" ? runQueuedDownloadSet(retryItem) : runQueuedUpload(retryItem));
  };

  const queueDragPreparation = (
    item: TransferQueueItem,
    prepare: () => Promise<string>,
  ) => {
    const started = performance.now();
    writeOperationLog("drag", "started", item.locationName, item.destinationPath, JSON.stringify({ operationId: item.id, itemCount: item.paths.length || 1, sourceType: item.sshEntryId ? "SSH" : "API", destinationType: "LOCAL" }), "DEBUG");
    let resolvePreparation: (path: string) => void = () => {};
    let rejectPreparation: (error: unknown) => void = () => {};
    const preparation = new Promise<string>((resolve, reject) => {
      resolvePreparation = resolve;
      rejectPreparation = reject;
    });
    setTransferQueue((current) => [...current, item]);
    void runOnce(item.id, async () => {
      updateQueueItem(item.id, { status: "running", ...queueMessage("Preparing drag transfer...") });
      try {
        const destination = await prepare();
        resolvePreparation(destination);
        updateQueueItem(item.id, { status: "needs_user_action", ...queueMessage("Ready. Drop the file into the external application.") });
        writeOperationLog("drag", "prepared", item.locationName, destination, JSON.stringify({ operationId: item.id, itemCount: item.paths.length || 1, stagingPath: destination, durationMs: Math.round(performance.now() - started) }), "INFO");
      } catch (error) {
        rejectPreparation(error);
        const recovery = classifyQueueError(error);
        updateQueueItem(item.id, { status: "failed", detail: recovery.message, errorCategory: recovery.category, error: queueFailure(item, recovery) });
        writeOperationLog("drag", "failed", item.locationName, item.destinationPath, JSON.stringify({ operationId: item.id, itemCount: item.paths.length || 1, durationMs: Math.round(performance.now() - started), failureType: "preparation", errorMessage: describeError(error) }), "ERROR");
      }
    });
    return preparation;
  };

  const enqueueQueueDownload = () => {
    const pendingDestinationFolder = pendingDownloadDestinationRef.current;
    const destinationFolder = pendingDestinationFolder ?? localPath;
    void run(async () => {
      if (!selectedItems.length) return;
      const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
      const setLabel = selectedItems.length === 1 ? selectedItems[0].name : `${selectedItems.length} selected items`;
      const setLabelMessage = selectedItems.length > 1 ? {
        key: "{{quantity}} {{unit}} selected",
        values: { quantity: selectedItems.length, unit: selectedItems.length === 1 ? "item" : "items" },
        translatedValues: ["unit"],
      } : undefined;
      const response = await api("/api/files/flatten", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: selectedItems.map(({ name, isDirectory, path: itemPath }) => ({ name, isDirectory, path: itemPath })),
          currentPath: path,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json() as { files?: { relativePath: string; remotePath: string; size: number }[] };
      const files = data.files || [];
      if (!files.length) {
        setNotice(t("The selection has no files to download."));
        return;
      }
      if (pendingDownloadDestinationRef.current === pendingDestinationFolder) {
        pendingDownloadDestinationRef.current = null;
      }
      const item: TransferQueueItem = {
        id,
        label: setLabel,
        labelMessage: setLabelMessage,
        kind: "download-set",
        paths: [],
        destinationPath: localDestinationDisplayPath(destinationFolder),
        locationId: session.locationId,
        locationName: activeLocationDisplayName || session.locationId,
        status: "queued",
        ...queueMessage("Waiting to start ({{quantity}} {{unit}})", { quantity: files.length, unit: files.length === 1 ? "file" : "files" }, "", ["unit"]),
        progress: initialQueueProgress(files.length, files.reduce((sum, file) => sum + file.size, 0)),
        setFiles: files,
        setCompleted: 0,
        localDestinationFolder: destinationFolder,
      };
      setArchiveFormatOpen(false);
      setTransferQueue((current) => [...current, item]);
      setQueueOpen(true);
      void runQueuedDownloadSet(item);
    });
  };

  const enqueueDownload = (archiveFormat: "tar.gz" | "zip", selectedDestinationFolder?: string) => {
    if (!selectedItems.length) return;
    const destinationFolder = selectedDestinationFolder ?? consumePendingDownloadDestination();
    const singleFile = selectedItems.length === 1 && !selectedItems[0].isDirectory;
    const fileName = singleFile ? selectedItems[0].name : `archive.${archiveFormat}`;
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
    const headers = locationHeaders(session, !singleFile);
    const body = singleFile ? undefined : Array.from(new TextEncoder().encode(JSON.stringify({
      items: selectedItems.map(({ name, isDirectory, path: itemPath }) => ({ name, isDirectory, path: itemPath })),
      currentPath: path,
      locationId: session.locationId,
      format: archiveFormat,
      sessionName: activeManagedWorkspaceName || "nFterm",
    })));
    const item: TransferQueueItem = {
      id,
      label: singleFile ? selectedItems[0].name : `${selectedItems.length} selected items`,
      labelMessage: singleFile ? undefined : {
        key: "{{quantity}} {{unit}} selected",
        values: { quantity: selectedItems.length, unit: selectedItems.length === 1 ? "item" : "items" },
        translatedValues: ["unit"],
      },
      kind: "download",
      paths: [],
      destinationPath: localDestinationDisplayPath(destinationFolder),
      locationId: session.locationId,
      locationName: activeLocationDisplayName || session.locationId,
      status: "queued",
      ...queueMessage("Waiting to start"),
      progress: initialQueueProgress(1, singleFile ? selectedItems[0].size : null),
      downloadUrl: singleFile
        ? `${serverUrl()}/api/files/download/${downloadPath(selectedItems[0].path)}`
        : `${serverUrl()}/api/archive`,
      downloadMethod: singleFile ? "GET" : "POST",
      downloadHeaders: headers,
      downloadBody: body,
      downloadFileName: fileName,
      archiveFormat: singleFile ? undefined : archiveFormat,
      localDestinationFolder: destinationFolder,
    };
    setArchiveFormatOpen(false);
    setTransferQueue((current) => [...current, item]);
    setQueueOpen(true);
    void runQueuedDownload(item);
  };

  /** Download `items` of the SSH entry `entryId` (an SFTP window) into the LOCAL folder `destinationFolder`. */
  const enqueueSshDownload = (entryId: string, items: FileItem[], destinationFolder: string = localPath, onDone?: () => void) => {
    if (!items.length) return;
    const profile = findSshProfileById(entryId);
    if (!profile) {
      setNotice(t("The SSH connection for this remote view is no longer available."));
      return;
    }
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
    const label = items.length === 1 ? items[0].name : `${items.length} selected items`;
    const labelMessage = items.length > 1 ? {
      key: "{{quantity}} {{unit}} selected",
      values: { quantity: items.length, unit: "items" },
      translatedValues: ["unit"],
    } : undefined;
    const item: TransferQueueItem = {
      id,
      label,
      labelMessage,
      kind: "download",
      paths: [],
      destinationPath: destinationFolder ? `~/${destinationFolder}` : "~",
      locationId: "",
      locationName: `SSH: ${profile.name}`,
      status: "queued",
      ...queueMessage("Waiting to start"),
      sshEntryId: entryId,
      sshItems: items,
      localDestinationFolder: destinationFolder,
    };
    setTransferQueue((current) => [...current, item]);
    setQueueOpen(true);
    void runQueuedSshDownload(item, profile, items).then(() => onDone?.());
  };

  // API REMOTE download button. SFTP windows call enqueueSshDownload directly.
  const download = () => {
    pendingDownloadDestinationRef.current = null;
    if (!selectedItems.length) return;
    if (destinationPickerOpenRef.current) return;
    destinationPickerOpenRef.current = true;
    void run(async () => {
      try {
        const destinationFolder = await invoke<string | null>("pick_local_directory", { path: localPath });
        if (destinationFolder === null) return;
        const singleFile = selectedItems.length === 1 && !selectedItems[0].isDirectory;
        if (!singleFile) {
          pendingDownloadDestinationRef.current = destinationFolder;
          setArchiveFormatDraft("tar.gz");
          setArchiveFormatOpen(true);
          return;
        }
        enqueueDownload("tar.gz", destinationFolder);
      } finally {
        destinationPickerOpenRef.current = false;
      }
    });
  };

  const downloadToCurrentLocalFolder = () => {
    pendingDownloadDestinationRef.current = null;
    if (!selectedItems.length) return;
    const singleFile = selectedItems.length === 1 && !selectedItems[0].isDirectory;
    if (!singleFile) {
      setArchiveFormatDraft("tar.gz");
      setArchiveFormatOpen(true);
      return;
    }
    enqueueDownload("tar.gz");
  };

  const renderDesktopQueueItem = (item: TransferQueueItem) => (
    <div className="queue-item" key={item.id}>
      <div className="queue-item-header">
        <strong className="queue-item-label">{item.labelMessage ? translateQueueMessage(item.labelMessage) : item.label}</strong>
        <span className={`queue-status ${item.status}`}>{t(item.status.replaceAll("_", " "))}</span>
      </div>
      <div className="queue-item-route">
        <span>{item.locationName}</span>
        <code>{item.destinationPath || "/"}</code>
      </div>
      <div className="queue-item-detail" role="status" aria-live="polite">{item.error?.translationKey ? t("{{category}}: {{message}}{{partial}}{{suffix}}", {
        category: t(item.error.category),
        message: t(item.error.translationKey, item.error.translationValues),
        suffix: item.error.translationSuffix || "",
        partial: item.error.completedItems !== undefined && item.error.totalItems !== undefined
          ? ` ${t("({{completed}}/{{total}} completed before failing)", { completed: item.error.completedItems, total: item.error.totalItems })}`
          : "",
      }) : item.detailMessage ? `${item.status === "retrying" && item.errorCategory ? `${t(item.errorCategory)}: ` : ""}${translateQueueMessage(item.detailMessage)}` : item.error ? t("{{category}}: {{message}}{{partial}}", {
        category: t(item.error.category),
        message: item.error.message,
        partial: item.error.completedItems !== undefined && item.error.totalItems !== undefined
          ? ` ${t("({{completed}}/{{total}} completed before failing)", { completed: item.error.completedItems, total: item.error.totalItems })}`
          : "",
       }) : item.detail}</div>
      {item.progress && (["running", "queued", "retrying"].includes(item.status)) && (
        <div className="queue-item-progress"><small>{item.progress.completedBytes ? `${formatSize(item.progress.completedBytes, toIntlLocale(getAppLocale()))}${item.progress.totalBytes ? ` / ${formatSize(item.progress.totalBytes, toIntlLocale(getAppLocale()))}` : ""}` : t("Waiting for transfer data")}{formatQueueProgress(item.progress, toIntlLocale(getAppLocale()), t("ETA"))}</small></div>
      )}
      <div className="queue-item-actions">
        {(item.status === "running" || item.status === "queued" || item.status === "retrying") && (
          <button type="button" onClick={() => cancelQueueItem(item.id)}>{t("Cancel")}</button>
        )}
        {(item.status === "failed" || item.status === "needs_user_action") &&
          (item.kind !== "download" || Boolean(item.sshEntryId) || Boolean(item.downloadUrl)) && (
           <button type="button" onClick={() => retryDesktopQueueItem(item)}>{item.serverSessionId ? t("Resume") : t("Retry")}</button>
        )}
        {(["completed", "failed", "cancelled", "needs_user_action"].includes(item.status)) && (
          <button type="button" onClick={() => removeQueueItem(item.id)}>{t("Remove")}</button>
        )}
      </div>
    </div>
  );

  return {
    updateQueueItem,
    updateQueueProgress,
    isQueueItemCancelled,
    cancelQueueItem,
    removeQueueItem,
    clearQueueHistory,
    clearQueueStatus,
    clearFinishedQueue,
    executeQueuedSshUpload,
    executeQueuedUpload,
    executeQueuedDownload,
    executeQueuedDownloadSet,
    executeQueuedSshDownload,
    runQueuedSshUpload,
    runQueuedUpload,
    runQueuedDownload,
    runQueuedDownloadSet,
    runQueuedSshDownload,
    retryDesktopQueueItem,
    renderDesktopQueueItem,
    queueDragPreparation,
    enqueueQueueDownload,
    enqueueDownload,
    enqueueSshDownload,
    enqueueBrowserUpload,
    download,
    downloadToCurrentLocalFolder,
    logQueueEvent,
  };
}
