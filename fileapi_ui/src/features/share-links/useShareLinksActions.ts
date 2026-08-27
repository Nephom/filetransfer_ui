import type { ShareLink, ShareResponse } from "./share-links-contracts";

// Minimal structural shape of main.tsx's ApiResponse, matching exactly what
// this hook calls on it -- avoids importing main.tsx's own (unexported)
// ApiResponse class just for its type.
type ApiLikeResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};

export type UseShareLinksActionsParams = {
  run: (action: () => Promise<void>) => Promise<void>;
  notify: (message: string, duration?: number) => void;
  api: (endpoint: string, init?: RequestInit) => Promise<ApiLikeResponse>;
  readError: (response: ApiLikeResponse) => Promise<string>;
  session: { token: string; locationId: string; role: string };
  serverUrl: () => string;
  activeLocationDisplayName: string | undefined;
  writeOperationLog: (operation: string, status: string, sourceLabel: string, destinationLabel: string, detail: string, level?: "DEBUG" | "INFO" | "WARN" | "ERROR") => void;
  describeError: (error: unknown) => string;
  shareLinkMode: "secure" | "direct";
  shareLinkExpirationDays: number;
  ensureApiRemote: () => void;
  // The single selected, non-directory REMOTE file share() creates a link
  // for -- only its `path` is read, so callers can pass a plain object
  // rather than the full FileItem shape.
  selectedShareableItem: { path: string; isDirectory: boolean } | undefined;

  shareLinks: ShareLink[];
  setShareLinks: (links: ShareLink[]) => void;
  setShareLinksLoading: (loading: boolean) => void;
  setShareUrl: (url: string) => void;
  setShareLinksOpen: (open: boolean) => void;
  setSharePasswordOpen: (open: boolean) => void;
  setSharePasswordDraft: (draft: string) => void;
};

// Owns every handler behind the "Share Links" feature: creating a share
// link for the currently selected REMOTE file (optionally password-
// protected), and the separate Share Links management modal (list/
// refresh/copy/revoke/clear history). State lives in useShareLinksState
// instead, since two of its flags (shareLinksOpen/sharePasswordOpen) are
// read by DesktopApp's cross-cutting "close topmost overlay" Escape
// handler declared earlier in the render body than this hook -- which
// itself must be called after run/notify/api/session/writeOperationLog
// and the REMOTE file browser's selectedItems all already exist.
export function useShareLinksActions({
  run, notify, api, readError, session, serverUrl, activeLocationDisplayName,
  writeOperationLog, describeError, shareLinkMode, shareLinkExpirationDays,
  ensureApiRemote, selectedShareableItem,
  shareLinks, setShareLinks, setShareLinksLoading,
  setShareUrl, setShareLinksOpen, setSharePasswordOpen, setSharePasswordDraft,
}: UseShareLinksActionsParams) {
  const createShareLink = (password?: string) =>
    run(async () => {
      ensureApiRemote();
      const item = selectedShareableItem;
      if (!item || item.isDirectory) return;
      const sourceLabel = `${activeLocationDisplayName || session.locationId || "Remote"}:${item.path}`;
      const operationId = crypto.randomUUID();
      const started = performance.now();
      writeOperationLog("share", "started", sourceLabel, "Public share link", JSON.stringify({ operationId, locationId: session.locationId, filePath: item.path, mode: shareLinkMode, expiration: shareLinkExpirationDays, passwordConfigured: Boolean(password) }), "DEBUG");
      try {
        const expiresIn = shareLinkExpirationDays > 0
          ? shareLinkExpirationDays * 86400
          : undefined;
        const response = await api("/api/files/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            locationId: session.locationId,
            filePath: item.path,
            ...(expiresIn ? { expiresIn } : {}),
            ...(password ? { password } : {}),
          }),
        });
        if (!response.ok) throw new Error(await readError(response));
        const data = (await response.json()) as ShareResponse;
        // "direct" mode returns a plain URL that streams the file straight
        // from the server with no page in between and no Authorization/JWT
        // header required, for tools that only accept a bare link (e.g. a
        // BMC firmware page). "secure" mode returns the share.html page
        // link, which supports the optional password set above.
        const url =
          shareLinkMode === "direct"
            ? data.data?.directDownloadFullUrl ||
              (data.data?.directDownloadUrl ? `${serverUrl()}${data.data.directDownloadUrl}` : "")
            : data.data?.fullUrl ||
              (data.data?.shareUrl ? `${serverUrl()}${data.data.shareUrl}` : "");
        if (!url) throw new Error("The server did not return a share link.");
        setShareUrl(url);
        setSharePasswordOpen(false);
        setSharePasswordDraft("");
        writeOperationLog("share", "completed", sourceLabel, "Public share link", JSON.stringify({ operationId, locationId: session.locationId, filePath: item.path, mode: shareLinkMode, expiration: shareLinkExpirationDays, passwordConfigured: Boolean(password), durationMs: Math.round(performance.now() - started) }));
        notify("Share link created.");
      } catch (error) {
        writeOperationLog("share", "failed", sourceLabel, "Public share link", JSON.stringify({ operationId, locationId: session.locationId, filePath: item.path, mode: shareLinkMode, expiration: shareLinkExpirationDays, passwordConfigured: Boolean(password), durationMs: Math.round(performance.now() - started), failureType: "share_request", errorMessage: describeError(error) }), "ERROR");
        throw error;
      }
    });

  const loadShareLinks = async () => {
    if (!session.token) return;
    setShareLinksLoading(true);
    try {
      const response = await api(session.role === "admin" ? "/api/admin/share-links" : "/api/files/shares");
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as { data?: ShareLink[] };
      setShareLinks(data.data || []);
    } finally {
      setShareLinksLoading(false);
    }
  };

  const openShareLinks = () => {
    setShareLinksOpen(true);
    void loadShareLinks();
  };

  const shareLinkUrl = (link: ShareLink, kind: "secure" | "direct") => {
    const relative = kind === "direct" ? link.directDownloadUrl : link.shareUrl;
    return relative ? `${serverUrl()}${relative}` : "";
  };

  const copyManagedShareLink = async (link: ShareLink, kind: "secure" | "direct") => {
    const url = shareLinkUrl(link, kind);
    if (!url) throw new Error("The server did not return this share link URL.");
    await navigator.clipboard.writeText(url);
    notify(`${kind === "direct" ? "Direct" : "Secure"} link copied.`);
  };

  const revokeManagedShareLink = (shareToken: string) =>
    run(async () => {
      if (!window.confirm("Revoke this share link? Existing downloads will stop working.")) return;
      const response = await api(`${session.role === "admin" ? "/api/admin/share-links" : "/api/files/share"}/${encodeURIComponent(shareToken)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      await loadShareLinks();
      notify("Share link revoked.");
    });

  const deleteExpiredShareLink = (shareToken: string) =>
    run(async () => {
      const response = await api(`${session.role === "admin" ? "/api/admin/share-links" : "/api/files/share"}/${encodeURIComponent(shareToken)}/history`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      await loadShareLinks();
      notify("Expired share link removed from history.");
    });

  const deleteRevokedShareLink = (shareToken: string) =>
    run(async () => {
      const response = await api(`${session.role === "admin" ? "/api/admin/share-links" : "/api/files/share"}/${encodeURIComponent(shareToken)}/history/revoked`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      await loadShareLinks();
      notify("Revoked share link removed from history.");
    });

  const shareLinkStatus = (link: ShareLink) =>
    link.isExpired ? "Expired" : link.isExhausted ? "Exhausted" : link.isActive ? "Active" : "Revoked";
  const shareLinkGroups = [
    { key: "active", label: "Active", links: shareLinks.filter((link) => shareLinkStatus(link) === "Active") },
    { key: "revoked", label: "Revoked", links: shareLinks.filter((link) => shareLinkStatus(link) === "Revoked") },
    { key: "expired", label: "Expired", links: shareLinks.filter((link) => shareLinkStatus(link) === "Expired") },
    { key: "exhausted", label: "Exhausted", links: shareLinks.filter((link) => shareLinkStatus(link) === "Exhausted") },
  ].filter((group) => group.links.length > 0);

  const share = () => {
    const item = selectedShareableItem;
    if (!item || item.isDirectory) return;
    if (shareLinkMode === "secure") {
      // The web UI's equivalent flow also lets the user set a password at
      // share time (it's per-link, not a global default), so ask here too
      // instead of always sharing without one.
      setSharePasswordDraft("");
      setSharePasswordOpen(true);
      return;
    }
    void createShareLink();
  };

  return {
    createShareLink,
    loadShareLinks,
    openShareLinks,
    shareLinkUrl,
    copyManagedShareLink,
    revokeManagedShareLink,
    deleteExpiredShareLink,
    deleteRevokedShareLink,
    shareLinkStatus,
    shareLinkGroups,
    share,
  };
}
