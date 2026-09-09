// The shape of one entry returned by GET /api/locations. Shared between
// main.tsx (still owns most of the REMOTE file browser, pending the full
// Phase 5 refactor -- see GitHub issue #229) and this feature's own
// useRemoteApiActions hook, which owns the small REMOTE/API connection
// slice pulled out ahead of schedule while fixing issue #233 (token
// refresh).
export type RemoteLocation = {
  id: string;
  displayName: string;
  status?: string;
  readOnly?: boolean;
  capabilities?: string[];
  revision?: string;
};

export const locationHeaders = (session: { token: string; locationId: string; locationRevision?: string }, json = false): [string, string][] => [
  ...(session.token && session.token !== "cookie" ? [["Authorization", `Bearer ${session.token}`] as [string, string]] : []),
  ...(session.locationId ? [["X-Location-ID", session.locationId] as [string, string]] : []),
  ...(session.locationRevision ? [["X-Location-Revision", session.locationRevision] as [string, string]] : []),
  ...(json ? [["Content-Type", "application/json"] as [string, string]] : []),
];

export const remoteParent = (path: string) => path.split("/").slice(0, -1).join("/");

// Keep the server's explanation alongside per-path outcomes. HTTP errors do
// not identify which files changed, and must not manufacture successful Undo.
export const remoteMutationError = (data: unknown, status: number): string => {
  const body = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const reasons = new Set<string>();
  if (typeof body.error === "string" && body.error) reasons.add(body.error);
  if (Array.isArray(body.results)) {
    for (const result of body.results) {
      if (result?.success === false && typeof result.error === "string" && result.error) {
        reasons.add(`${typeof result.path === "string" ? `${result.path}: ` : ""}${result.error}`);
      }
    }
  }
  return [status >= 400 ? `HTTP ${status}` : "", ...reasons].filter(Boolean).join(" — ");
};

export const groupRemoteDeletes = <T extends { path: string; name: string; isDirectory: boolean }>(items: T[]) => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const parent = remoteParent(item.path);
    groups.set(parent, [...(groups.get(parent) || []), item]);
  }
  return Array.from(groups, ([currentPath, entries]) => ({
    currentPath,
    items: entries.map(({ path, name, isDirectory }) => ({ path, name, isDirectory })),
  }));
};

// A 207 or summary count cannot identify which full paths actually changed.
export const remoteMutationResults = (
  items: { path: string; name: string }[], data: unknown, status: number,
): { path: string; success: boolean | null; targetPath?: string }[] => {
  const body = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const hasResults = Object.prototype.hasOwnProperty.call(body, "results");
  const results = Array.isArray(body.results) ? body.results : [];
  const byPath = new Map<string, { success: unknown; targetPath?: unknown } | null>();
  for (const result of results) {
    if (result && typeof result === "object" && typeof result.path === "string") {
      byPath.set(result.path, byPath.has(result.path) ? null : result);
    }
  }
  const names = items.map((item) => item.name).sort();
  const legacyComplete = !hasResults && status >= 200 && status < 300 && status !== 207 && body.success === true
    && (body.failedCount === undefined || body.failedCount === 0)
    && (body.deletedCount === undefined || body.deletedCount === items.length)
    && (body.processedItems === undefined || (Array.isArray(body.processedItems)
      && body.processedItems.length === items.length
      && [...body.processedItems].sort().every((name, index) => name === names[index])));
  return items.map((item) => {
    if (!hasResults) return { path: item.path, success: legacyComplete ? true : null };
    const result = byPath.get(item.path);
    if (!result || typeof result.success !== "boolean") return { path: item.path, success: null };
    if (result.success && result.targetPath !== undefined && (typeof result.targetPath !== "string" || !result.targetPath
      || result.targetPath.startsWith("/") || /[\\\u0000]/.test(result.targetPath) || result.targetPath.split("/").some((part: string) => !part || part === "." || part === ".."))) {
      return { path: item.path, success: null };
    }
    return { path: item.path, success: result.success, ...(typeof result.targetPath === "string" ? { targetPath: result.targetPath } : {}) };
  });
};
