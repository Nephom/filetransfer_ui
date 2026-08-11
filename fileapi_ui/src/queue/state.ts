export type QueueStatus =
  | "queued"
  | "running"
  | "paused"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled"
  | "needs_user_action";

const transitions: Record<QueueStatus, QueueStatus[]> = {
  queued: ["running", "cancelled", "needs_user_action", "paused"],
  running: ["completed", "failed", "cancelled", "retrying", "needs_user_action"],
  retrying: ["queued", "failed", "cancelled", "needs_user_action", "paused"],
  completed: [],
  failed: ["queued", "cancelled"],
  cancelled: [],
  needs_user_action: ["queued", "cancelled"],
  paused: ["queued", "cancelled"],
};

export const canTransitionQueue = (from: QueueStatus, to: QueueStatus) =>
  from === to || transitions[from].includes(to);

export const assertQueueTransition = (from: QueueStatus, to: QueueStatus) => {
  if (!canTransitionQueue(from, to)) {
    throw new Error(`Invalid Queue transition: ${from} -> ${to}`);
  }
};

export const isQueueTerminal = (status: QueueStatus) =>
  status === "completed" || status === "failed" || status === "cancelled";
