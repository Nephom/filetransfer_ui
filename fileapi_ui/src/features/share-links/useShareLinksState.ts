import { useState } from "react";
import type { ShareLink } from "./share-links-contracts";

export function useShareLinksState() {
  const [shareUrl, setShareUrl] = useState("");
  const [shareLinksOpen, setShareLinksOpen] = useState(false);
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [shareLinksLoading, setShareLinksLoading] = useState(false);
  const [sharePasswordOpen, setSharePasswordOpen] = useState(false);
  const [sharePasswordDraft, setSharePasswordDraft] = useState("");

  return {
    shareUrl, setShareUrl,
    shareLinksOpen, setShareLinksOpen,
    shareLinks, setShareLinks,
    shareLinksLoading, setShareLinksLoading,
    sharePasswordOpen, setSharePasswordOpen,
    sharePasswordDraft, setSharePasswordDraft,
  };
}
