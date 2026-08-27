import type { QueueProgress } from "../../queue/progress";
import type { QueueErrorCategory } from "../../queue/recovery";
import type { FileItem } from "../../file-item-contracts";

export type TransferQueueItem = {
  id: string;
  operationId?: string;
  label: string;
  kind: "upload" | "download" | "download-set";
  paths: string[];
  destinationPath: string;
  locationId: string;
  locationName: string;
  status: "queued" | "running" | "retrying" | "completed" | "failed" | "cancelled" | "needs_user_action";
  detail: string;
  progress?: QueueProgress;
  errorCategory?: QueueErrorCategory;
  error?: {
    category: QueueErrorCategory;
    message: string;
    itemId: string;
    path?: string;
    attempt: number;
    timestamp: number;
  };
  retryCount?: number;
  finishedAt?: number;
  downloadUrl?: string;
  downloadMethod?: string;
  downloadHeaders?: [string, string][];
  downloadBody?: number[];
  downloadFileName?: string;
  archiveFormat?: "tar.gz" | "zip";
  // HOME-relative LOCAL destination directory (matches `localPath`'s own
  // format), captured when a REMOTE -> LOCAL download is queued so it keeps
  // targeting that folder even if the user navigates the LOCAL pane
  // elsewhere afterwards. Only meaningful for "download"/"download-set"
  // items; upload items keep using `destinationPath` for the REMOTE side.
  localDestinationFolder?: string;
  setFiles?: { relativePath: string; remotePath: string; size: number }[];
  setCompleted?: number;
  sshEntryId?: string;
  sshItems?: FileItem[];
};

// localStorage key holding the persisted transfer queue (see
// readPersistedQueue below). Kept exported here rather than folded into the
// hook so it stays a single source of truth if anything else ever needs to
// read/clear it directly.
export const queueStorageKey = "nfterm-transfer-queue";

export const readPersistedQueue = (): TransferQueueItem[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(queueStorageKey) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is TransferQueueItem => Boolean(item && typeof item.id === "string" && typeof item.status === "string"))
      .map((item) => {
        const withOperationId = { ...item, operationId: item.operationId || item.id };
        if (!["queued", "running", "retrying"].includes(item.status)) return withOperationId;
        const requiresRequeue = item.kind === "download" && !item.sshEntryId;
        return {
          ...withOperationId,
          status: "needs_user_action",
          errorCategory: "unknown",
          detail: requiresRequeue
            ? "Transfer was interrupted when nFterm closed. Re-add it to authenticate again."
            : "Transfer was interrupted when nFterm closed. Review and retry it.",
          error: {
            category: "unknown",
            message: "Transfer was interrupted when nFterm closed.",
            itemId: item.id,
            path: item.paths?.[0],
            attempt: item.retryCount || 0,
            timestamp: Date.now(),
          },
        };
      });
  } catch {
    return [];
  }
};

