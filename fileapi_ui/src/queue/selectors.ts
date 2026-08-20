export type QueueStatus = "queued" | "running" | "retrying" | "completed" | "failed" | "cancelled" | "needs_user_action";

export const selectActiveQueueItems = <T extends { status: QueueStatus }>(items: T[]) =>
  items.filter((item) => ["queued", "running", "retrying"].includes(item.status));

export const selectQueueHistory = <T extends { status: QueueStatus }>(items: T[]) =>
  items.filter((item) => ["completed", "failed", "cancelled", "needs_user_action"].includes(item.status));

export const selectQueueHasFinished = <T extends { status: QueueStatus }>(items: T[]) =>
  items.some((item) => ["completed", "failed", "cancelled", "needs_user_action"].includes(item.status));
