import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeftIcon, ChevronRightIcon } from "./icons";

export type CommandBarOverflowAction = {
  key: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
};

// Narrow commandbars cannot show every action at full label width (see
// styles/commandbar.css); rather than truncating every button into an
// unreadable "…", secondary actions collapse behind this one trigger.
// Portaled to document.body (mirrors ContextPicker) because .commandbar
// has overflow:hidden, which would otherwise clip a normally-positioned
// popover before it ever became visible.
export function CommandBarOverflowMenu({ label, actions }: { label: string; actions: CommandBarOverflowAction[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({ visibility: "hidden" });

  const closeMenu = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !(event.target as HTMLElement).closest(".commandbar-overflow-options")) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  // T-133: match ui/Dropdown.tsx's keyboard matrix -- Escape/Arrow keys/
  // Home/End are handled by the portaled menu's own onKeyDown below, and
  // opening focuses the first action so this menu does not depend on a
  // mouse click to be usable.
  useEffect(() => {
    if (!open) return;
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") || []);
    buttons[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const reposition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.max(190, rect.width);
      const maxHeight = Math.min(420, Math.max(140, window.innerHeight - 24));
      const gap = 6;
      const belowTop = rect.bottom + gap;
      const aboveTop = rect.top - gap - maxHeight;
      const top = belowTop + maxHeight <= window.innerHeight - 12
        ? belowTop
        : aboveTop >= 12
          ? aboveTop
          : Math.max(12, Math.min(belowTop, window.innerHeight - maxHeight - 12));
      const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
      setPopoverStyle({ top, left, width, maxHeight, visibility: "visible" });
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`mobile-choice-menu commandbar-overflow${open ? " open" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="mobile-choice-trigger commandbar-overflow-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <span>{label}</span>
        <span aria-hidden="true">{open ? <ChevronLeftIcon /> : <ChevronRightIcon />}</span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="mobile-choice-options commandbar-overflow-options"
          style={popoverStyle}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") || []);
            const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "Escape") {
              event.preventDefault();
              closeMenu();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const nextIndex = event.key === "ArrowDown"
                ? Math.min(currentIndex + 1, buttons.length - 1)
                : Math.max(currentIndex - 1, 0);
              buttons[nextIndex]?.focus();
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              buttons[event.key === "Home" ? 0 : buttons.length - 1]?.focus();
            }
          }}
        >
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              title={action.title}
              onClick={() => {
                action.onClick();
                closeMenu();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
