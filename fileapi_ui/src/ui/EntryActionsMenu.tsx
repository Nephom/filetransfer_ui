import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./entry-actions-menu.css";
import { MoreIcon } from "./icons";

type Props = {
  entryName: string;
  onEdit: () => void;
  onRemove: () => void;
};

// T-219 follow-up: compact "more actions" trigger shared by the REST API
// entry sidebar (rest-api.tsx's RestEntries) and the Proxmox VNC entry
// sidebar (proxmox-vnc.tsx's VncEntries). Both used to render Edit/Remove
// as two permanently-visible text buttons, which didn't fit next to the
// entry name once the pane got narrow (or the Large profile's fixed
// sizing kicked in) -- the row list ended up hidden entirely there rather
// than clipped. This trigger opens a small floating menu instead, so the
// row always fits regardless of pane width, and the row list no longer
// needs hiding to avoid the overflow.
//
// The popover itself is portaled to document.body and positioned with
// `position: fixed` computed from the trigger's getBoundingClientRect()
// (same idiom as ui/Dropdown.tsx), instead of `position: absolute`
// anchored inside the row. The row lives inside .rest-entry-list /
// .vnc-entry-list, which is `overflow: auto` -- an absolutely positioned
// popover anchored there gets clipped by that scroll container whenever
// the row is near the bottom of the visible scroll area, which read as
// the popover "not really floating on top". Portaling + `position: fixed`
// + the shared --z-dropdown layer (same as .dropdown-menu /
// .mobile-choice-options) guarantees it always renders above everything
// else, unclipped, regardless of which row opened it or how the sidebar
// is scrolled.
export function EntryActionsMenu({ entryName, onEdit, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({ visibility: "hidden" });

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    // The popover is no longer a DOM descendant of rootRef once portaled
    // to document.body, so "click outside" must also exempt clicks that
    // land inside the popover itself -- otherwise every click on
    // Edit/Remove would be treated as "outside" and close the menu before
    // the button's own onClick could run.
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
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
    if (!open) return undefined;
    const reposition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 4;
      const edge = 12;
      // Mirrors the old CSS's `min-width: clamp(110px, 12vw, 150px)`, now
      // computed in JS since the popover's position/size is driven by
      // inline style once it's portaled out to document.body.
      const width = Math.min(150, Math.max(110, window.innerWidth * 0.12));
      const right = Math.max(edge, window.innerWidth - rect.right);
      const spaceBelow = window.innerHeight - rect.bottom - gap - edge;
      const spaceAbove = rect.top - gap - edge;
      // Anchor to the trigger's own edge (top via `bottom`, or bottom via
      // `top`), same as ui/Dropdown.tsx, so a menu opened near the bottom
      // of a scrolled entry list flips upward and stays flush against the
      // trigger instead of running off-screen.
      if (spaceBelow >= Math.min(96, spaceBelow) || spaceBelow >= spaceAbove) {
        setPopoverStyle({ position: "fixed", top: rect.bottom + gap, right, minWidth: width, maxHeight: Math.max(80, spaceBelow), visibility: "visible" });
      } else {
        setPopoverStyle({ position: "fixed", bottom: window.innerHeight - rect.top + gap, right, minWidth: width, maxHeight: Math.max(80, spaceAbove), visibility: "visible" });
      }
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
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
      {open && createPortal(
        <div ref={menuRef} className="entry-actions-popover" style={popoverStyle} role="menu" aria-label={`Actions for ${entryName}`}>
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
        </div>,
        document.body,
      )}
    </div>
  );
}
