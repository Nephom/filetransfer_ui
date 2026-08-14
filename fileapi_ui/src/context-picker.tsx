import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type ContextPickerOption = { id: string; label: string; detail?: string; selected?: boolean };
export type ContextPickerGroup = { label: string; options: ContextPickerOption[] };

type Props = {
  label: string;
  value: string;
  groups: ContextPickerGroup[];
  onSelect: (id: string) => void;
  disabled?: boolean;
};

export function ContextPicker({ label, value, groups, onSelect, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({ visibility: "hidden" });
  const options = useMemo(() => groups.flatMap((group) => group.options), [groups]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(340, window.innerWidth - 24);
      const maxHeight = Math.min(460, Math.max(140, window.innerHeight - 24));
      const gap = 8;
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

  return <div className="context-picker" ref={rootRef} data-context-picker="true">
    <button ref={triggerRef} type="button" className="context-picker-trigger" onClick={(event) => { event.stopPropagation(); setOpen((current) => !current); }} disabled={disabled} aria-expanded={open} aria-haspopup="listbox">
      <span className="context-picker-label">{label}</span><strong>{value}</strong><span className="context-picker-chevron">⌄</span>
    </button>
    {open && createPortal(<div className="context-picker-popover" style={popoverStyle} role="listbox" aria-label={label}>
      {groups.map((group) => <section className="context-picker-group" key={group.label}>
        <span className="context-picker-group-label">{group.label}</span>
        {group.options.map((option) => <button type="button" role="option" aria-selected={option.selected} className={`context-picker-option${option.selected ? " selected" : ""}`} key={option.id} onClick={() => { onSelect(option.id); setOpen(false); }}>
          <span className="context-picker-option-copy"><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span><span className="context-picker-check">{option.selected ? "●" : ""}</span>
        </button>)}
      </section>)}
      {!options.length && <span className="context-picker-empty">No available entries</span>}
    </div>, document.body)}
  </div>;
}
