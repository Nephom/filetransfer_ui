export type QueueErrorCategory =
  | "network"
  | "timeout"
  | "authentication"
  | "permission"
  | "conflict"
  | "source_missing"
  | "source_changed"
  | "destination_unavailable"
  | "server_error"
  | "validation"
  | "cancelled"
  | "unknown";

export type QueueRecoveryDecision = {
  category: QueueErrorCategory;
  retryable: boolean;
  needsUserAction: boolean;
  message: string;
};

export const classifyQueueError = (error: unknown): QueueRecoveryDecision => {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const status = Number(message.match(/\b(401|403|404|409|5\d\d)\b/)?.[1] || 0);
  if (status === 401 || lower.includes("unauthorized") || lower.includes("token")) {
    return { category: "authentication", retryable: false, needsUserAction: true, message };
  }
  if (status === 403 || lower.includes("permission") || lower.includes("forbidden")) {
    return { category: "permission", retryable: false, needsUserAction: true, message };
  }
  if (status === 409 || lower.includes("conflict")) {
    return { category: "conflict", retryable: false, needsUserAction: true, message };
  }
  if (status === 404 || lower.includes("not found") || lower.includes("os error 2") || lower.includes("os error 3")) {
    return { category: "source_missing", retryable: false, needsUserAction: true, message };
  }
  if (lower.includes("source changed") || lower.includes("modified after") || lower.includes("changed since")) {
    return { category: "source_changed", retryable: false, needsUserAction: true, message };
  }
  if (lower.includes("destination") && (lower.includes("unavailable") || lower.includes("missing") || lower.includes("no space"))) {
    return { category: "destination_unavailable", retryable: false, needsUserAction: true, message };
  }
  if (status >= 500) {
    return { category: "server_error", retryable: true, needsUserAction: false, message };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { category: "timeout", retryable: true, needsUserAction: false, message };
  }
  if (lower.includes("network") || lower.includes("connect") || lower.includes("fetch")) {
    return { category: "network", retryable: true, needsUserAction: false, message };
  }
  if (lower.includes("invalid") || lower.includes("validation")) {
    return { category: "validation", retryable: false, needsUserAction: true, message };
  }
  if (lower.includes("cancel")) {
    return { category: "cancelled", retryable: false, needsUserAction: false, message };
  }
  return { category: "unknown", retryable: false, needsUserAction: true, message };
};

export const retryDelayMs = (attempt: number, baseMs = 1000, maxMs = 30_000) =>
  Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
