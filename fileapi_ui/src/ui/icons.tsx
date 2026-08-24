import React from "react";

// Shared inline SVG icon set. Every path uses currentColor so an icon always
// matches the text color of whatever button/label renders it, and every icon
// accepts the same two props so call sites are interchangeable with the
// Unicode glyphs (⌄, ×, ‹, ›) they replace.
type IconProps = { size?: number; className?: string };

// T-041: directional/action icons share one --icon-size token (18px) instead
// of each hardcoding its own pixel default -- pass `size` only to opt out of
// the shared size for a specific spot (e.g. DotIcon's own smaller default
// below, which is a small "selected" indicator dot, not a navigational icon,
// so it deliberately sits outside the shared 16-20px range).
const base = (size?: number) => ({
  viewBox: "0 0 16 16",
  fill: "none" as const,
  "aria-hidden": true as const,
  style: size ? { width: size, height: size } : { width: "var(--icon-size)", height: "var(--icon-size)" },
});

export function ChevronDownIcon({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3.5 6L8 10.5L12.5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChevronLeftIcon({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10 3.5L5.5 8L10 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChevronRightIcon({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChevronUpIcon({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3.5 10L8 5.5L12.5 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CloseIcon({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function CheckIcon({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Diagonal-resize icons for the SSH terminal's maximize/restore toggle
// (replaces the ⤢/⤡ glyphs -- see GLYPH-INVENTORY.md's "no dedicated task"
// group, folded into this shared set rather than tracked separately).
export function ExpandIcon({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6.5 2.5H2.5V6.5M9.5 13.5H13.5V9.5M2.5 13.5L6.5 9.5M13.5 2.5L9.5 6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CollapseIcon({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.5 6.5H6.5V2.5M13.5 9.5H9.5V13.5M9.5 6.5L13.5 2.5M2.5 13.5L6.5 9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Warning triangle for status badges (replaces the standalone "⚠" glyph).
export function WarningIcon({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 2.5L14 13H2L8 2.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 6.5V9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.3" r="0.9" fill="currentColor" />
    </svg>
  );
}

// Sort-direction icons (replace the "▲"/"▼" glyphs).
export function SortAscIcon({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 3.5L12.5 10H3.5L8 3.5Z" fill="currentColor" />
    </svg>
  );
}

export function SortDescIcon({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 12.5L3.5 6H12.5L8 12.5Z" fill="currentColor" />
    </svg>
  );
}

export function DotIcon({ size = 8, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="8" cy="8" r="4" fill="currentColor" />
    </svg>
  );
}

// T-219: vertical "more actions" kebab, used to collapse the always-visible
// Edit/Remove text buttons in the REST API / Proxmox VNC entry sidebars
// into a single compact trigger that opens a small floating menu instead
// (see rest-api.tsx's RestEntries and proxmox-vnc.tsx's VncEntries).
export function MoreIcon({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="8" cy="3.5" r="1.3" fill="currentColor" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" />
      <circle cx="8" cy="12.5" r="1.3" fill="currentColor" />
    </svg>
  );
}

