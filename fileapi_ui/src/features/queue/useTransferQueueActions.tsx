import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  formatQueueProgress,
  initialQueueProgress,
  updateQueueProgress as calculateQueueProgress,
  type QueueProgress,
} from "../../queue/progress";
import { classifyQueueError, retryDelayMs } from "../../queue/recovery";
import { assertQueueTransition } from "../../queue/state";
import type { QueueScheduler } from "../../queue/scheduler";
import type { QueueStore } from "../../queue/store";
import { formatSize } from "../../format-utils";
import { downloadPath } from "../../path-utils";
import type { FileItem } from "../../file-item-contracts";
import type { SshProfile } from "../ssh/ssh-contracts";
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

export type UseTransferQueueActionsParams = {
  run: (action: () => Promise<void>) => Promise<void>;
  notify: (message: string, duration?: number) => void;
  setNotice: (message: string) => void;
  api: (endpoint: string, init?: RequestInit) => Promise<ApiLikeResponse>;
  readError: (response: ApiLikeResponse) => Promise<string>;
  session: { token: string; locationId: string; ignoreTlsErrors: boolean };
  serverUrl: () => string;
  writeOperationLog: (operation: string, status: string, sourceLabel: string, destinationLabel: string, detail: string, level?: "DEBUG" | "INFO" | "WARN" | "ERROR") => void;
  describeError: (error: unknown) => string;
  path: string;
  localPath: string;
  loadFiles: (nextPath?: string) => Promise<void>;
  activeLocationDisplayName: string | undefined;
  activeManagedWorkspaceName: string | undefined;
  findSshProfileById: (entryId: string) => SshProfile | undefined;
  remoteSshEntryId: string;
  // The currently selected REMOTE items -- only path/isDirectory/name/size
  // are read, so callers can pass a plain array of that shape.
  selectedItems: Pick<FileItem, "name" | "path" | "isDirectory" | "size">[];

  transferQueue: TransferQueueItem[];
  setTransferQueue: (updater: (current: TransferQueueItem[]) => TransferQueueItem[]) => void;
  queueStoreRef: { current: QueueStore<TransferQueueItem> };
  setQueueOpen: (open: boolean) => void;
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
  findSshProfileById, remoteSshEntryId, selectedItems,
  transferQueue, setTransferQueue, queueStoreRef,
  setQueueOpen, setArchiveFormatOpen, setArchiveFormatDraft,
  queueProgressSamplesRef, latestQueueProgressRef, queueCompletionHandlersRef,
  cancelledQueueItemsRef, queueSchedulerRef,
}: UseTransferQueueActionsParams) {
  const logQueueEvent = (item: TransferQueueItem, event: string, fields: Record<string, unknown> = {}, level: "DEBUG" | "INFO" | "WARN" | "ERROR" = "INFO") => {
    const destination = item.kind === "upload"
      ? `${item.locationName}:${item.destinationPath || "/"}`
      : `LOCAL: ~/${item.localDestinationFolder || ""}`;
    writeOperationLog(
      item.kind === "upload" ? "upload" : "download",
      event,
      item.label,
      destination,
      JSON.stringify({
        sourceType: item.kind === "upload" ? "LOCAL" : "REMOTE",
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
        const nextItem = {
          ...item,
          ...update,
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
    updateQueueItem(id, { progress, detail: `${formatSize(completedBytes)}${totalBytes ? ` / ${formatSize(totalBytes)}` : ""}${formatQueueProgress(progress)}` });
    return progress;
  };

  const isQueueItemCancelled = (id: string) => cancelledQueueItemsRef.current.has(id);

  const cancelQueueItem = (id: string) => {
    const current = transferQueue.find((item) => item.id === id);
    if (!current || ["completed", "failed", "cancelled", "needs_user_action"].includes(current.status)) return;
    cancelledQueueItemsRef.current.add(id);
    queueProgressSamplesRef.current.delete(id);
    latestQueueProgressRef.current.delete(id);
    queueCompletionHandlersRef.current.delete(id);
    void invoke("cancel_transfer", { transferId: id })
      .then(() => logQueueEvent(current, "cancel_requested", { backendCancelSucceeded: true, alreadyRunning: current.status === "running" }))
      .catch((error) => logQueueEvent(current, "cancel_requested", { backendCancelSucceeded: false, alreadyRunning: current.status === "running", failureType: "cancel_command", errorMessage: describeError(error) }, "WARN"));
    updateQueueItem(id, { status: "cancelled", detail: "Cancelled by user." });
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
    updateQueueItem(item.id, { status: "running", detail: `Uploading 0/${item.paths.length} items...` });
    let completed = 0;
    try {
      for (const localItemPath of item.paths) {
        if (isQueueItemCancelled(item.id)) return;
        await invoke("ssh_upload_path", { profile, localPath: localItemPath, remoteDestinationFolder: item.destinationPath });
        completed += 1;
        updateQueueItem(item.id, { detail: `Uploading ${completed}/${item.paths.length} items...` });
      }
      updateQueueItem(item.id, { status: "completed", detail: `Uploaded ${completed} item(s) to ${item.destinationPath || "/"}.` });
      writeOperationLog("upload", "completed", item.label, `${item.locationName}:${item.destinationPath || "/"}`, `Uploaded ${completed} item(s) via SFTP.`);
      await loadFiles(path);
    } catch (error) {
      if (isQueueItemCancelled(item.id)) return;
      const recovery = classifyQueueError(error);
      const detail = `${recovery.message} (${completed}/${item.paths.length} completed before failing)`;
      updateQueueItem(item.id, { status: recovery.needsUserAction ? "needs_user_action" : "failed", detail: `[${recovery.category}] ${detail}`, errorCategory: recovery.category });
      writeOperationLog("upload", "failed", item.label, `${item.locationName}:${item.destinationPath || "/"}`, `SSH queued upload failed: ${detail}`, "ERROR");
    }
  };

  const executeQueuedUpload = async (item: TransferQueueItem) => {
    writeOperationLog("upload", "started", item.label, `${item.locationName}:${item.destinationPath || "/"}`, "Transfer queue upload started.", "DEBUG");
    updateQueueItem(item.id, { status: "running", detail: "Inspecting local files (this does not load file contents into the UI)..." });
    let unlistenProgress: (() => void) | undefined;
    try {
      const summary = await invoke<{ files: number; directories: number; totalSize: number; sources: { path: string; size: number; modified: number }[] }>("inspect_upload_paths", { paths: item.paths });
      unlistenProgress = await listen<{ transferId: string; bytesCompleted: number; bytesTotal: number }>(
        "upload-progress",
        (event) => {
          if (event.payload.transferId !== item.id || isQueueItemCancelled(item.id)) return;
          const { bytesCompleted, bytesTotal } = event.payload;
          const progress = updateQueueProgress(item.id, bytesCompleted, bytesTotal || null, 0, summary.files);
          updateQueueItem(item.id, {
            detail: `Uploading ${formatSize(bytesCompleted)} / ${formatSize(bytesTotal)}${formatQueueProgress(progress)}`,
          });
        },
      );
      const headers: [string, string][] = session.token && session.token !== "cookie"
        ? [
            ["Authorization", `Bearer ${session.token}`],
            ["X-Location-ID", item.locationId],
          ]
        : [["X-Location-ID", item.locationId]];
      updateQueueItem(item.id, {
        detail: `Prepared ${summary.files} file${summary.files === 1 ? "" : "s"} (${formatSize(summary.totalSize)}); streaming upload...`,
      });
      updateQueueItem(item.id, { progress: initialQueueProgress(summary.files, summary.totalSize || null) });
      const currentSources = await invoke<{ files: number; directories: number; totalSize: number; sources: { path: string; size: number; modified: number }[] }>("inspect_upload_paths", { paths: item.paths });
      const sourceChanged = summary.sources.length !== currentSources.sources.length
        || summary.sources.some((source, index) => {
          const current = currentSources.sources[index];
          return !current || current.path !== source.path || current.size !== source.size || current.modified !== source.modified;
        });
      if (sourceChanged) throw new Error("Upload source changed after it was queued. Re-add the file to upload the new content.");
      const rawResponse = await invoke<NativeApiResponse>("api_upload_paths", {
        transferId: item.id,
        expectedSources: summary.sources,
        url: `${serverUrl()}/api/upload/multiple`,
        headers,
        paths: item.paths,
        path: item.destinationPath,
        ignoreTlsErrors: session.ignoreTlsErrors,
      });
      const response: ApiLikeResponse = {
        ok: rawResponse.status >= 200 && rawResponse.status < 300,
        status: rawResponse.status,
        text: async () => new TextDecoder().decode(new Uint8Array(rawResponse.body)),
        json: async () => JSON.parse(new TextDecoder().decode(new Uint8Array(rawResponse.body))),
      };
      if (!response.ok) throw new Error(await readError(response));
      const { batchId } = (await response.json()) as { batchId?: string };
      if (!batchId) {
        if (isQueueItemCancelled(item.id)) return;
        updateQueueItem(item.id, { status: "completed", detail: `Uploaded ${summary.files} file${summary.files === 1 ? "" : "s"}.` });
        writeOperationLog("upload", "completed", item.label, `${item.locationName}:${item.destinationPath || "/"}`, `Uploaded ${summary.files} file${summary.files === 1 ? "" : "s"}.`);
        return;
      }
      for (let attempt = 0; attempt < 600; attempt += 1) {
        if (isQueueItemCancelled(item.id)) return;
        const progressResponse = await invoke<NativeApiResponse>("api_request", {
          url: `${serverUrl()}/api/progress/batch/${encodeURIComponent(batchId)}`,
          method: "GET",
          headers,
          body: null,
          ignoreTlsErrors: session.ignoreTlsErrors,
        });
        if (isQueueItemCancelled(item.id)) return;
        const progressBytes = new Uint8Array(progressResponse.body);
        const progressOk = progressResponse.status >= 200 && progressResponse.status < 300;
        const progressLike: ApiLikeResponse = {
          ok: progressOk,
          status: progressResponse.status,
          text: async () => new TextDecoder().decode(progressBytes),
          json: async () => JSON.parse(new TextDecoder().decode(progressBytes)),
        };
        if (!progressLike.ok) throw new Error(await readError(progressLike));
        const batch = await progressLike.json() as { status: string; progress: number; successCount: number; totalFiles: number; failedCount: number; totalSize?: number; transferredSize?: number };
        const totalBytes = batch.totalSize || summary.totalSize || null;
        const completedBytes = batch.transferredSize || (totalBytes ? Math.round(totalBytes * batch.progress / 100) : 0);
        const queueProgress = updateQueueProgress(item.id, completedBytes, totalBytes, batch.successCount, batch.totalFiles);
        updateQueueItem(item.id, { detail: `${batch.successCount}/${batch.totalFiles} files (${Math.round(batch.progress)}%)${totalBytes ? ` · ${formatSize(completedBytes)} / ${formatSize(totalBytes)}` : ""}${formatQueueProgress(queueProgress)}` });
        if (batch.status === "completed") {
          if (isQueueItemCancelled(item.id)) return;
          updateQueueItem(item.id, { status: "completed", detail: `Uploaded ${batch.successCount} file${batch.successCount === 1 ? "" : "s"}.` });
          writeOperationLog("upload", "completed", item.label, `${item.locationName}:${item.destinationPath || "/"}`, `Uploaded ${batch.successCount} file${batch.successCount === 1 ? "" : "s"}.`);
          await loadFiles(path);
          return;
        }
        if (batch.status === "failed" || batch.status === "partial_fail") {
          throw new Error(`${batch.failedCount} file${batch.failedCount === 1 ? "" : "s"} failed.`);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
      throw new Error("Upload progress timed out.");
    } catch (error) {
      if (isQueueItemCancelled(item.id)) return;
      const recovery = classifyQueueError(error);
      const detail = recovery.message;
      const retryCount = item.retryCount || 0;
      if (recovery.retryable && retryCount < 3 && !isQueueItemCancelled(item.id)) {
        const nextItem = { ...item, status: "retrying" as const, retryCount: retryCount + 1, detail: `[${recovery.category}] Retry ${retryCount + 1}/3 queued`, errorCategory: recovery.category };
        updateQueueItem(item.id, nextItem);
        logQueueEvent(nextItem, "retrying", { attempt: retryCount + 1, maximumAttempts: 3, reason: recovery.category }, "WARN");
        logQueueEvent(nextItem, "retry_scheduled", { attempt: retryCount + 1, maximumAttempts: 3, reason: recovery.category, delayMs: retryDelayMs(retryCount + 1) }, "INFO");
        window.setTimeout(() => { logQueueEvent(nextItem, "retry_started", { attempt: retryCount + 1, maximumAttempts: 3 }); updateQueueItem(item.id, { status: "queued", detail: "Retry starting" }); void runQueuedUpload({ ...nextItem, status: "queued" }); }, retryDelayMs(retryCount + 1));
        return;
      }
      if (recovery.retryable) logQueueEvent(item, "retry_exhausted", { attempt: retryCount, maximumAttempts: 3, reason: recovery.category }, "ERROR");
      updateQueueItem(item.id, {
        status: recovery.needsUserAction ? "needs_user_action" : "failed",
        detail: `[${recovery.category}] ${detail}`,
        errorCategory: recovery.category,
      });
      writeOperationLog("upload", "failed", item.label, `${item.locationName}:${item.destinationPath || "/"}`, `Upload failed: ${detail}`, "ERROR");
    } finally {
      unlistenProgress?.();
    }
  };

  const executeQueuedDownload = async (item: TransferQueueItem) => {
    const destinationLabel = `LOCAL: ~/${item.localDestinationFolder || ""}`;
    logQueueEvent(item, "started", { transferId: item.id, kind: item.kind, archiveFormat: item.archiveFormat || null }, "DEBUG");
    updateQueueItem(item.id, { status: "running", detail: item.archiveFormat ? `Preparing ${item.archiveFormat} archive...` : "Downloading..." });
    // download_to_disk streams the response and emits "download-progress"
    // events tagged with this item's id so the queue can show byte-level
    // progress for single-file and archive downloads (previously just a
    // static "Downloading..." label for the whole transfer).
    const unlistenProgress = await listen<{ transferId: string; bytesCompleted: number; bytesTotal?: number }>(
      "download-progress",
      (event) => {
        if (event.payload.transferId !== item.id) return;
        const { bytesCompleted, bytesTotal } = event.payload;
        const knownTotalBytes = latestQueueProgressRef.current.get(item.id)?.totalBytes
          ?? item.progress?.totalBytes
          ?? null;
        updateQueueProgress(item.id, bytesCompleted, bytesTotal ?? knownTotalBytes);
      },
    );
    try {
      if (item.archiveFormat) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        updateQueueItem(item.id, { detail: `Streaming ${item.archiveFormat} download...` });
      }
      const destination = await invoke<string>("download_to_disk", {
        transferId: item.id,
        url: item.downloadUrl,
        method: item.downloadMethod || "GET",
        headers: item.downloadHeaders || [],
        body: item.downloadBody,
        fileName: item.downloadFileName || "download.bin",
        destinationFolder: item.localDestinationFolder || "",
        ignoreTlsErrors: session.ignoreTlsErrors,
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
        detail: `Downloaded to ${destination}.${formatQueueProgress(latestProgress)}`,
      });
      logQueueEvent(item, "completed", { transferId: item.id, destination, bytesCompleted: latestProgress?.completedBytes || 0, bytesTotal: latestProgress?.totalBytes || null }, "INFO");
    } catch (error) {
      if (isQueueItemCancelled(item.id)) return;
      const recovery = classifyQueueError(error);
      const detail = recovery.message;
      const retryCount = item.retryCount || 0;
      if (recovery.retryable && retryCount < 3 && !isQueueItemCancelled(item.id)) {
        const nextItem = { ...item, status: "retrying" as const, retryCount: retryCount + 1, detail: `[${recovery.category}] Retry ${retryCount + 1}/3 queued`, errorCategory: recovery.category };
        updateQueueItem(item.id, nextItem);
        logQueueEvent(nextItem, "retrying", { attempt: retryCount + 1, maximumAttempts: 3, reason: recovery.category }, "WARN");
        logQueueEvent(nextItem, "retry_scheduled", { attempt: retryCount + 1, maximumAttempts: 3, reason: recovery.category, delayMs: retryDelayMs(retryCount + 1) });
        window.setTimeout(() => { logQueueEvent(nextItem, "retry_started", { attempt: retryCount + 1, maximumAttempts: 3 }); updateQueueItem(item.id, { status: "queued", detail: "Retry starting" }); void runQueuedDownload({ ...nextItem, status: "queued" }); }, retryDelayMs(retryCount + 1));
        return;
      }
      if (recovery.retryable) logQueueEvent(item, "retry_exhausted", { attempt: retryCount, maximumAttempts: 3, reason: recovery.category }, "ERROR");
      updateQueueItem(item.id, { status: recovery.needsUserAction ? "needs_user_action" : "failed", detail: `[${recovery.category}] ${detail}`, errorCategory: recovery.category });
      logQueueEvent(item, "failed", { transferId: item.id, errorMessage: detail, errorCategory: recovery.category, retryCount }, "ERROR");
    } finally {
      unlistenProgress();
    }
  };

  const executeQueuedDownloadSet = async (item: TransferQueueItem) => {
    const files = item.setFiles || [];
    const destinationLabel = `LOCAL: ~/${item.localDestinationFolder || ""}`;
    logQueueEvent(item, "started", { transferId: item.id, kind: item.kind, itemCount: files.length }, "DEBUG");
    updateQueueItem(item.id, { status: "running", detail: `Downloading 0/${files.length} files...`, setCompleted: 0 });
    const headers: [string, string][] = session.token && session.token !== "cookie"
      ? [["Authorization", `Bearer ${session.token}`], ...(session.locationId ? [["X-Location-ID", session.locationId] as [string, string]] : [])]
      : [];
    let completed = 0;
    let lastDestinationRoot = "";
    try {
      for (const file of files) {
        if (isQueueItemCancelled(item.id)) return;
        // `file.relativePath` already starts with the selected item's own
        // top-level name (the flatten endpoint prefixes it with each
        // selected item's name) -- it must not also be nested under an
        // extra synthetic "<n> selected items" segment here, or a single
        // selected directory would end up duplicated inside itself.
        const destination = await invoke<string>("download_to_disk_at", {
          transferId: item.id,
          url: `${serverUrl()}/api/files/download/${downloadPath(file.remotePath)}`,
          method: "GET",
          headers,
          body: undefined,
          destinationFolder: item.localDestinationFolder || "",
          relativePath: file.relativePath,
          ignoreTlsErrors: session.ignoreTlsErrors,
        });
        completed += 1;
        lastDestinationRoot = destination.slice(0, destination.length - (file.relativePath.length + 1));
        updateQueueItem(item.id, { detail: `Downloading ${completed}/${files.length} files...`, setCompleted: completed });
        const totalBytes = files.reduce((sum, current) => sum + current.size, 0);
        const completedBytes = files.slice(0, completed).reduce((sum, current) => sum + current.size, 0);
        updateQueueProgress(item.id, completedBytes, totalBytes, completed, files.length);
      }
      updateQueueItem(item.id, { status: "completed", detail: `Downloaded ${completed} file(s) to ${lastDestinationRoot || destinationLabel}.` });
      logQueueEvent(item, "completed", { transferId: item.id, completedItems: completed, totalItems: files.length }, "INFO");
    } catch (error) {
      if (isQueueItemCancelled(item.id)) return;
      const recovery = classifyQueueError(error);
      const detail = recovery.message;
      const retryCount = item.retryCount || 0;
      if (recovery.retryable && retryCount < 3 && !isQueueItemCancelled(item.id)) {
        const nextItem = { ...item, status: "retrying" as const, retryCount: retryCount + 1, detail: `[${recovery.category}] Retry ${retryCount + 1}/3 queued`, errorCategory: recovery.category };
        updateQueueItem(item.id, nextItem);
        logQueueEvent(nextItem, "retrying", { attempt: retryCount + 1, maximumAttempts: 3, reason: recovery.category }, "WARN");
        logQueueEvent(nextItem, "retry_scheduled", { attempt: retryCount + 1, maximumAttempts: 3, reason: recovery.category, delayMs: retryDelayMs(retryCount + 1) });
        window.setTimeout(() => { logQueueEvent(nextItem, "retry_started", { attempt: retryCount + 1, maximumAttempts: 3 }); updateQueueItem(item.id, { status: "queued", detail: "Retry starting" }); void runQueuedDownloadSet({ ...nextItem, status: "queued" }); }, retryDelayMs(retryCount + 1));
        return;
      }
      if (recovery.retryable) logQueueEvent(item, "retry_exhausted", { attempt: retryCount, maximumAttempts: 3, reason: recovery.category }, "ERROR");
      updateQueueItem(item.id, { status: recovery.needsUserAction ? "needs_user_action" : "failed", detail: `[${recovery.category}] ${detail} (${completed}/${files.length} completed before failing)`, errorCategory: recovery.category });
      logQueueEvent(item, "failed", { transferId: item.id, errorMessage: detail, errorCategory: recovery.category, completedItems: completed, totalItems: files.length, retryCount }, "ERROR");
    }
  };

  const executeQueuedSshDownload = async (item: TransferQueueItem, profile: SshProfile, items: FileItem[]) => {
    const destinationLabel = `LOCAL: ~/${item.localDestinationFolder || ""}`;
    writeOperationLog("download", "started", item.label, destinationLabel, `SSH queued download of ${items.length} item(s) started.`, "DEBUG");
    updateQueueItem(item.id, { status: "running", detail: `Downloading 0/${items.length} items...` });
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
        updateQueueItem(item.id, { detail: `Downloading ${completed}/${items.length} items...` });
      }
      updateQueueItem(item.id, { status: "completed", detail: `Downloaded ${completed} item(s) to ${lastDestination.split("/").slice(0, -1).join("/") || destinationLabel}.` });
      writeOperationLog("download", "completed", item.label, destinationLabel, `Downloaded ${completed} item(s) via SFTP.`);
    } catch (error) {
      if (isQueueItemCancelled(item.id)) return;
      const recovery = classifyQueueError(error);
      const detail = recovery.message;
      updateQueueItem(item.id, { status: recovery.needsUserAction ? "needs_user_action" : "failed", detail: `[${recovery.category}] ${detail} (${completed}/${items.length} completed before failing)`, errorCategory: recovery.category });
      writeOperationLog("download", "failed", item.label, destinationLabel, `SSH queued download failed: ${detail}`, "ERROR");
    }
  };

  const runOnce = (id: string, execute: () => Promise<void>) => queueSchedulerRef.current.runExclusive(id, execute);
  const runQueuedSshUpload = (item: TransferQueueItem, profile: SshProfile) => runOnce(item.id, () => executeQueuedSshUpload(item, profile));
  const runQueuedUpload = (item: TransferQueueItem) => runOnce(item.id, () => executeQueuedUpload(item));
  const runQueuedDownload = (item: TransferQueueItem) => runOnce(item.id, () => executeQueuedDownload(item));
  const runQueuedDownloadSet = (item: TransferQueueItem) => runOnce(item.id, () => executeQueuedDownloadSet(item));
  const runQueuedSshDownload = (item: TransferQueueItem, profile: SshProfile, items: FileItem[]) => runOnce(item.id, () => executeQueuedSshDownload(item, profile, items));

  const retryDesktopQueueItem = (item: TransferQueueItem) => {
    if (item.kind === "download" && !item.sshEntryId && !item.downloadUrl) {
      setNotice("This restored download no longer contains its request credentials. Re-add the download to retry it safely.");
      return;
    }
    if (!(["failed", "needs_user_action"] as string[]).includes(item.status)) return;
    cancelledQueueItemsRef.current.delete(item.id);
    const retryItem = { ...item, status: "queued" as const, detail: "Retry queued", finishedAt: undefined };
    updateQueueItem(item.id, retryItem);
    writeOperationLog(item.kind === "upload" ? "upload" : "download", "retry", item.label, item.destinationPath, `Manual retry requested (attempt ${(item.retryCount || 0) + 1}).`, "INFO");
    if (retryItem.sshEntryId) {
      const profile = findSshProfileById(retryItem.sshEntryId);
      if (!profile) {
        updateQueueItem(item.id, { status: "needs_user_action", detail: "The SSH connection for this transfer is no longer available." });
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
      updateQueueItem(item.id, { status: "running", detail: "Preparing drag transfer..." });
      try {
        const destination = await prepare();
        resolvePreparation(destination);
        updateQueueItem(item.id, { status: "needs_user_action", detail: "Ready. Drop the file into the external application." });
        writeOperationLog("drag", "prepared", item.locationName, destination, JSON.stringify({ operationId: item.id, itemCount: item.paths.length || 1, stagingPath: destination, durationMs: Math.round(performance.now() - started) }), "INFO");
      } catch (error) {
        rejectPreparation(error);
        updateQueueItem(item.id, { status: "failed", detail: describeError(error), errorCategory: classifyQueueError(error).category });
        writeOperationLog("drag", "failed", item.locationName, item.destinationPath, JSON.stringify({ operationId: item.id, itemCount: item.paths.length || 1, durationMs: Math.round(performance.now() - started), failureType: "preparation", errorMessage: describeError(error) }), "ERROR");
      }
    });
    return preparation;
  };

  const enqueueQueueDownload = () =>
    void run(async () => {
      if (!selectedItems.length) return;
      const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
      const setLabel = selectedItems.length === 1 ? selectedItems[0].name : `${selectedItems.length} selected items`;
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
        setNotice("The selection has no files to download.");
        return;
      }
      const item: TransferQueueItem = {
        id,
        label: setLabel,
        kind: "download-set",
        paths: [],
        destinationPath: localPath ? `~/${localPath}` : "~",
        locationId: session.locationId,
        locationName: activeLocationDisplayName || session.locationId,
        status: "queued",
        detail: `Waiting to start (${files.length} files)`,
        progress: initialQueueProgress(files.length, files.reduce((sum, file) => sum + file.size, 0)),
        setFiles: files,
        setCompleted: 0,
        localDestinationFolder: localPath,
      };
      setArchiveFormatOpen(false);
      setTransferQueue((current) => [...current, item]);
      setQueueOpen(true);
      void runQueuedDownloadSet(item);
    });

  const enqueueDownload = (archiveFormat: "tar.gz" | "zip") => {
    if (!selectedItems.length) return;
    const singleFile = selectedItems.length === 1 && !selectedItems[0].isDirectory;
    const fileName = singleFile ? selectedItems[0].name : `archive.${archiveFormat}`;
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
    const headers: [string, string][] = session.token && session.token !== "cookie"
      ? [
          ["Authorization", `Bearer ${session.token}`],
          ...(session.locationId ? [["X-Location-ID", session.locationId] as [string, string]] : []),
          ...(singleFile ? [] : [["Content-Type", "application/json"] as [string, string]]),
        ]
      : [];
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
      kind: "download",
      paths: [],
      destinationPath: localPath ? `~/${localPath}` : "~",
      locationId: session.locationId,
      locationName: activeLocationDisplayName || session.locationId,
      status: "queued",
      detail: "Waiting to start",
      progress: initialQueueProgress(1, singleFile ? selectedItems[0].size : null),
      downloadUrl: singleFile
        ? `${serverUrl()}/api/files/download/${downloadPath(selectedItems[0].path)}`
        : `${serverUrl()}/api/archive`,
      downloadMethod: singleFile ? "GET" : "POST",
      downloadHeaders: headers,
      downloadBody: body,
      downloadFileName: fileName,
      archiveFormat: singleFile ? undefined : archiveFormat,
      localDestinationFolder: localPath,
    };
    setArchiveFormatOpen(false);
    setTransferQueue((current) => [...current, item]);
    setQueueOpen(true);
    void runQueuedDownload(item);
  };

  const enqueueSshDownload = () => {
    if (!selectedItems.length) return;
    const profile = findSshProfileById(remoteSshEntryId);
    if (!profile) {
      setNotice("The SSH connection for this remote view is no longer available.");
      return;
    }
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
    const label = selectedItems.length === 1 ? selectedItems[0].name : `${selectedItems.length} selected items`;
    const item: TransferQueueItem = {
      id,
      label,
      kind: "download",
      paths: [],
      destinationPath: localPath ? `~/${localPath}` : "~",
      locationId: "",
      locationName: `SSH: ${profile.name}`,
      status: "queued",
      detail: "Waiting to start",
      sshEntryId: remoteSshEntryId,
      sshItems: selectedItems as FileItem[],
      localDestinationFolder: localPath,
    };
    setTransferQueue((current) => [...current, item]);
    setQueueOpen(true);
    void runQueuedSshDownload(item, profile, selectedItems as FileItem[]);
  };

  const download = () => {
    if (remoteSshEntryId) {
      enqueueSshDownload();
      return;
    }
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
        <strong className="queue-item-label">{item.label}</strong>
        <span className={`queue-status ${item.status}`}>{item.status.replaceAll("_", " ")}</span>
      </div>
      <div className="queue-item-route">
        <span>{item.locationName}</span>
        <code>{item.destinationPath || "/"}</code>
      </div>
      <div className="queue-item-detail">{item.detail}</div>
      {item.progress && (["running", "queued", "retrying"].includes(item.status)) && (
        <div className="queue-item-progress"><small>{item.progress.completedBytes ? `${formatSize(item.progress.completedBytes)}${item.progress.totalBytes ? ` / ${formatSize(item.progress.totalBytes)}` : ""}` : "Waiting for transfer data"}{formatQueueProgress(item.progress)}</small></div>
      )}
      <div className="queue-item-actions">
        {(item.status === "running" || item.status === "queued" || item.status === "retrying") && (
          <button type="button" onClick={() => cancelQueueItem(item.id)}>Cancel</button>
        )}
        {(item.status === "failed" || item.status === "needs_user_action") &&
          (item.kind !== "download" || Boolean(item.sshEntryId) || Boolean(item.downloadUrl)) && (
          <button type="button" onClick={() => retryDesktopQueueItem(item)}>Retry</button>
        )}
        {(["completed", "failed", "cancelled", "needs_user_action"].includes(item.status)) && (
          <button type="button" onClick={() => removeQueueItem(item.id)}>Remove</button>
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
    download,
    logQueueEvent,
  };
}
