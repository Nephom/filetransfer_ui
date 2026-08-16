import React, { useEffect, useRef, useState } from "react";
import "./mobile-choice-menu.css";
import { ChevronLeftIcon, ChevronRightIcon } from "./icons";

export type MobileChoice = { id: string; label: string };

type Props = {
  label: string;
  currentId: string;
  options: MobileChoice[];
  onSelect: (id: string) => void;
  className?: string;
};

export function MobileChoiceMenu({ label, currentId, options, onSelect, className = "" }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.id === currentId) || options[0];
  const alternatives = options.filter((option) => option.id !== currentId);

  const closeMenu = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("click", closeOutside);
    return () => document.removeEventListener("click", closeOutside);
  }, [open]);

  // T-133: match ui/Dropdown.tsx's keyboard matrix -- Enter/Space/ArrowDown
  // on the trigger opens the menu and focuses the first option, so this
  // menu (like Dropdown) does not depend on a mouse click to be usable.
  useEffect(() => {
    if (!open) return;
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") || []);
    buttons[0]?.focus();
  }, [open]);

  return (
    <div ref={rootRef} className={`mobile-choice-menu${open ? " open" : ""}${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="mobile-choice-trigger"
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
        <span>{current?.label || label}</span><span aria-hidden="true">{open ? <ChevronLeftIcon /> : <ChevronRightIcon />}</span>
      </button>
      {open && <div
        ref={menuRef}
        className="mobile-choice-options"
        role="menu"
        aria-label={label}
        onKeyDown={(event) => {
          const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") || []);
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
        {alternatives.map((option) => (
          <button
            type="button"
            role="menuitem"
            key={option.id}
            onClick={() => {
              onSelect(option.id);
              closeMenu();
            }}
          >
            {option.label}
          </button>
        ))}
      </div>}
    </div>
  );
}
