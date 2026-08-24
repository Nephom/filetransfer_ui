import React, { useEffect, useRef, useState } from "react";
import "./entry-actions-menu.css";
import { MoreIcon } from "./icons";

type Props = {
  entryName: string;
  onEdit: () => void;
  onRemove: () => void;
};

// T-219: compact "more actions" trigger shared by the REST API entry
// sidebar (rest-api.tsx's RestEntries) and the Proxmox VNC entry sidebar
// (proxmox-vnc.tsx's VncEntries). Both used to render Edit/Remove as two
// permanently-visible text buttons, which didn't fit next to the entry
// name once the pane got narrow (or the Large profile's fixed sizing
// kicked in) -- the row list ended up hidden entirely there rather than
// clipped. This trigger opens a small floating menu instead, so the row
// always fits regardless of pane width, and the row list no longer needs
// hiding to avoid the overflow. Closing behavior mirrors
// ui/MobileChoiceMenu.tsx (outside click, Escape, focus-first-item).
export function EntryActionsMenu({ entryName, onEdit, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("click", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [open]);

  return (
    <div ref={rootRef} className="entry-actions-menu-root">
      <button
        ref={triggerRef}
        type="button"
        className="entry-actions-trigger"
        aria-label={`More actions for ${entryName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <MoreIcon />
      </button>
      {open && (
        <div ref={menuRef} className="entry-actions-popover" role="menu" aria-label={`Actions for ${entryName}`}>
          <button
            type="button"
            role="menuitem"
            className="entry-action-edit"
            aria-label={`Edit ${entryName}`}
            onClick={() => {
              close();
              onEdit();
            }}
          >
            Edit
          </button>
          <button
            type="button"
            role="menuitem"
            className="entry-action-remove"
            aria-label={`Remove ${entryName}`}
            onClick={() => {
              close();
              onRemove();
            }}
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
