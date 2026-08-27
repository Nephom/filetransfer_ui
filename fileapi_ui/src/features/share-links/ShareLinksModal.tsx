import React from "react";
import { CloseIcon } from "../../ui/icons";
import type { ShareLink } from "./share-links-contracts";

type ShareLinkGroup = { key: string; label: string; links: ShareLink[] };

type ShareLinksModalProps = {
  shareLinks: ShareLink[];
  shareLinksLoading: boolean;
  shareLinkGroups: ShareLinkGroup[];
  isAdmin: boolean;
  modalStyle: React.CSSProperties;
  onDragStart: (event: React.MouseEvent<HTMLElement>) => void;
  onClose: () => void;
  onRefresh: () => void;
  shareLinkUrl: (link: ShareLink, kind: "secure" | "direct") => string;
  shareLinkStatus: (link: ShareLink) => string;
  onCopyLink: (link: ShareLink, kind: "secure" | "direct") => void;
  onRevokeLink: (shareToken: string) => void;
  onClearRevoked: (shareToken: string) => void;
  onClearExpired: (shareToken: string) => void;
};

export function ShareLinksModal({
  shareLinks,
  shareLinksLoading,
  shareLinkGroups,
  isAdmin,
  modalStyle,
  onDragStart,
  onClose,
  onRefresh,
  shareLinkUrl,
  shareLinkStatus,
  onCopyLink,
  onRevokeLink,
  onClearRevoked,
  onClearExpired,
}: ShareLinksModalProps) {
  return (
    <div className="modal-cover modal-layer-top" onMouseDown={onClose}>
      <div className="modal share-links-modal" style={modalStyle} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading-row modal-drag-handle" onMouseDown={onDragStart}>
          <div><h2>Share Links</h2><p>Links created by this desktop client.</p></div>
          <button type="button" onClick={onClose} aria-label="Close Share Links"><CloseIcon /></button>
        </div>
        <div className="share-links-toolbar">
          <span>{shareLinks.length} link{shareLinks.length === 1 ? "" : "s"}</span>
          <button type="button" onClick={onRefresh} disabled={shareLinksLoading}>{shareLinksLoading ? "Refreshing..." : "Refresh"}</button>
        </div>
        {shareLinksLoading && !shareLinks.length ? <p className="muted">Loading share links...</p> : !shareLinks.length ? <p className="muted">No share links created yet.</p> : (
          <div className="share-link-groups">
            {shareLinkGroups.map((group) => (
              <section className="share-link-group" key={group.key}>
                <div className="share-link-group-heading"><h3>{group.label}</h3><span>{group.links.length}</span></div>
                <div className="share-links-list">
                  {group.links.map((link) => {
                    const secureUrl = shareLinkUrl(link, "secure");
                    const directUrl = shareLinkUrl(link, "direct");
                    const status = shareLinkStatus(link);
                    return <article className="share-link-card" key={link.shareToken}>
                      <div className="share-link-card-heading"><strong>{link.fileName}</strong><span className={`share-link-status ${status.toLowerCase()}`}>{status}</span></div>
                      {isAdmin && <small>Created by: {link.creatorUsername || link.userId || "--"}</small>}
                      <small>Location: {link.locationId || "--"} · Created: {link.createdAt ? new Date(link.createdAt).toLocaleString() : "--"}</small>
                      <small>Downloads: {link.downloadCount || 0}{link.maxDownloads > 0 ? ` / ${link.maxDownloads}` : " / unlimited"} · Expires: {link.expiresAt ? new Date(link.expiresAt).toLocaleString() : "never"}</small>
                      <label>Secure link<input readOnly value={secureUrl} onFocus={(event) => event.currentTarget.select()} /></label>
                      <label>Direct download<input readOnly value={directUrl} onFocus={(event) => event.currentTarget.select()} /></label>
                      {status === "Active" && <div className="modal-actions"><button type="button" onClick={() => onCopyLink(link, "secure")} disabled={!secureUrl}>Copy secure</button><button type="button" onClick={() => onCopyLink(link, "direct")} disabled={!directUrl}>Copy direct</button><button type="button" className="danger" onClick={() => onRevokeLink(link.shareToken)}>Revoke</button></div>}
                      {status === "Revoked" && <div className="modal-actions"><button type="button" onClick={() => onClearRevoked(link.shareToken)}>Clear revoked</button></div>}
                      {status === "Expired" && <div className="modal-actions"><button type="button" onClick={() => onClearExpired(link.shareToken)}>Clear expired</button></div>}
                    </article>;
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
        <div className="modal-actions modal-actions-end"><button type="button" className="confirm" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
