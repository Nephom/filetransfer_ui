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
  const current = options.find((option) => option.id === currentId) || options[0];
  const alternatives = options.filter((option) => option.id !== currentId);

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("click", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`mobile-choice-menu${open ? " open" : ""}${className ? ` ${className}` : ""}`}>
      <button type="button" className="mobile-choice-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span>{current?.label || label}</span><span aria-hidden="true">{open ? <ChevronLeftIcon /> : <ChevronRightIcon />}</span>
      </button>
      {open && <div className="mobile-choice-options" role="menu" aria-label={label}>
        {alternatives.map((option) => <button type="button" role="menuitem" key={option.id} onClick={() => { onSelect(option.id); setOpen(false); }}>{option.label}</button>)}
      </div>}
    </div>
  );
}
