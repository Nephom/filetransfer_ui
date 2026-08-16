import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon } from "./icons";
import "./dropdown.css";

// Shared single-select dropdown for every native <select> replacement across
// Location/REST/VNC/Settings/Login. Portaled to document.body (like
// ContextPicker) so no ancestor's overflow:hidden can ever clip the menu,
// and position is computed from the trigger's getBoundingClientRect() on
// open/resize/scroll so it always tracks the trigger instead of assuming a
// fixed layout.
export type DropdownOption = { value: string; label: string; disabled?: boolean };

type Props = {
  label: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
};

export function Dropdown({ label, value, options, onChange, disabled = false, placeholder, className = "" }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({ visibility: "hidden" });
  const selected = options.find((option) => option.value === value);

  const closeMenu = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const reposition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.max(rect.width, 190);
      const maxHeight = Math.min(320, Math.max(140, window.innerHeight - 24));
      const gap = 6;
      const belowTop = rect.bottom + gap;
      const aboveTop = rect.top - gap - maxHeight;
      const top = belowTop + maxHeight <= window.innerHeight - 12
        ? belowTop
        : aboveTop >= 12
          ? aboveTop
          : Math.max(12, Math.min(belowTop, window.innerHeight - maxHeight - 12));
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
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

  useEffect(() => {
    if (!open) return;
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") || []);
    const selectedIndex = buttons.findIndex((button) => button.getAttribute("aria-selected") === "true");
    (buttons[selectedIndex] || buttons[0])?.focus();
  }, [open]);

  return (
    <div ref={rootRef} className={`dropdown${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="dropdown-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <span className="dropdown-trigger-label">{selected?.label || placeholder || label}</span>
        <ChevronDownIcon className="dropdown-chevron" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="dropdown-menu"
          style={popoverStyle}
          role="listbox"
          aria-label={label}
          onKeyDown={(event) => {
            const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") || []);
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
          {options.map((option) => (
            <button
              type="button"
              role="option"
              key={option.value}
              aria-selected={option.value === value}
              disabled={option.disabled}
              className={option.value === value ? "selected" : ""}
              onClick={() => {
                onChange(option.value);
                closeMenu();
              }}
            >
              {option.label}
            </button>
          ))}
          {!options.length && <span className="dropdown-empty">No options</span>}
        </div>,
        document.body,
      )}
    </div>
  );
}
