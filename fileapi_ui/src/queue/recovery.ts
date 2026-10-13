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
  translationKey?: string;
  translationValues?: Record<string, string | number>;
};

export const queueHttpErrorCategory = (status: number): QueueErrorCategory => {
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 404) return "source_missing";
  if (status === 408) return "timeout";
  if (status === 409) return "conflict";
  if (status === 429) return "server_error";
  if (status >= 500) return "server_error";
  if (status >= 400) return "validation";
  return "unknown";
};

export const classifyQueueError = (error: unknown): QueueRecoveryDecision => {
  const message = error instanceof Error ? error.message : String(error);
  const translation = error && typeof error === "object" && "translationKey" in error
    ? error as { translationKey?: string; values?: Record<string, string | number> }
    : undefined;
  const translationKey = translation?.translationKey;
  const translationValues = translation?.values;
  const explicitCategory = error && typeof error === "object" && "queueCategory" in error
    ? (error as { queueCategory?: QueueErrorCategory }).queueCategory
    : undefined;
  if (explicitCategory && ["network", "timeout", "authentication", "permission", "conflict", "source_missing", "source_changed", "destination_unavailable", "server_error", "validation", "cancelled", "unknown"].includes(explicitCategory)) {
    const retryable = explicitCategory === "network" || explicitCategory === "timeout" || explicitCategory === "server_error";
    return { category: explicitCategory, retryable, needsUserAction: !retryable && explicitCategory !== "cancelled", message, translationKey, translationValues };
  }
  const lower = message.toLowerCase();
  const status = Number(message.match(/\b(401|403|404|408|409|429|5\d\d)\b/)?.[1] || 0);
  if (status === 401 || lower.includes("unauthorized") || lower.includes("token")) {
    return { category: "authentication", retryable: false, needsUserAction: true, message, translationKey, translationValues };
  }
  if (status === 403 || lower.includes("permission") || lower.includes("forbidden")) {
    return { category: "permission", retryable: false, needsUserAction: true, message, translationKey, translationValues };
  }
  if (status === 409 || lower.includes("conflict")) {
    return { category: "conflict", retryable: false, needsUserAction: true, message, translationKey, translationValues };
  }
  if (status === 408) {
    return { category: "timeout", retryable: true, needsUserAction: false, message, translationKey, translationValues };
  }
  if (status === 429) {
    return { category: "server_error", retryable: true, needsUserAction: false, message, translationKey, translationValues };
  }
  if (status === 404 || lower.includes("not found") || lower.includes("os error 2") || lower.includes("os error 3")) {
    return { category: "source_missing", retryable: false, needsUserAction: true, message, translationKey, translationValues };
  }
  if (lower.includes("source changed") || lower.includes("modified after") || lower.includes("changed since")) {
    return { category: "source_changed", retryable: false, needsUserAction: true, message, translationKey, translationValues };
  }
  if (lower.includes("destination") && (lower.includes("unavailable") || lower.includes("missing") || lower.includes("no space"))) {
    return { category: "destination_unavailable", retryable: false, needsUserAction: true, message, translationKey, translationValues };
  }
  if (status >= 500) {
    return { category: "server_error", retryable: true, needsUserAction: false, message, translationKey, translationValues };
  }
  if (status >= 400 && status < 500) {
    return { category: "validation", retryable: false, needsUserAction: true, message, translationKey, translationValues };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { category: "timeout", retryable: true, needsUserAction: false, message, translationKey, translationValues };
  }
  if (lower.includes("network") || lower.includes("connect") || lower.includes("fetch")) {
    return { category: "network", retryable: true, needsUserAction: false, message, translationKey, translationValues };
  }
  if (lower.includes("invalid") || lower.includes("validation")) {
    return { category: "validation", retryable: false, needsUserAction: true, message, translationKey, translationValues };
  }
  if (lower.includes("cancel")) {
    return { category: "cancelled", retryable: false, needsUserAction: false, message, translationKey, translationValues };
  }
  return { category: "unknown", retryable: false, needsUserAction: true, message, translationKey, translationValues };
};

export const retryDelayMs = (attempt: number, baseMs = 1000, maxMs = 30_000) =>
  Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
