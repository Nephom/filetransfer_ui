import React, { useRef } from "react";
import { resizeRect, type PaneRect, type PaneSize, type PaneWindowState, type ResizeEdges, PANE_MIN_SIZE } from "./pane-window-model";

type Props = {
  win: PaneWindowState;
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  active: boolean;
  layer: PaneSize;
  /** Keep the body mounted (hidden) while the window is closed, e.g. the SSH terminal. */
  keepMounted?: boolean;
  onFocus: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
  onRect: (rect: PaneRect) => void;
  children: React.ReactNode;
};

type DragState = { pointerId: number; startX: number; startY: number; origin: PaneRect };
type ResizeState = DragState & { edges: ResizeEdges };

const EDGE_HANDLES: { name: string; edges: ResizeEdges }[] = [
  { name: "n", edges: { n: true } },
  { name: "s", edges: { s: true } },
  { name: "e", edges: { e: true } },
  { name: "w", edges: { w: true } },
  { name: "ne", edges: { n: true, e: true } },
  { name: "nw", edges: { n: true, w: true } },
  { name: "se", edges: { s: true, e: true } },
  { name: "sw", edges: { s: true, w: true } },
];

export function PaneWindow({ win, title, subtitle, icon, active, layer, keepMounted, onFocus, onMinimize, onToggleMaximize, onClose, onRect, children }: Props) {
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const visible = win.open && !win.minimized;
  if (!win.open && !keepMounted) return null;

  const beginDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || win.maximized) return;
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: { x: win.x, y: win.y, w: win.w, h: win.h } };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    onRect({ ...drag.origin, x: drag.origin.x + event.clientX - drag.startX, y: drag.origin.y + event.clientY - drag.startY });
  };
  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const beginResize = (edges: ResizeEdges) => (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || win.maximized) return;
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: { x: win.x, y: win.y, w: win.w, h: win.h }, edges };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveResize = (event: React.PointerEvent<HTMLElement>) => {
    const state = resizeRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    onRect(resizeRect(state.origin, state.edges, event.clientX - state.startX, event.clientY - state.startY, layer, PANE_MIN_SIZE[win.id]));
  };
  const endResize = (event: React.PointerEvent<HTMLElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const className = ["pane-window", `pane-window-${win.id}`, active ? "is-active" : "", win.maximized ? "is-maximized" : "", visible ? "" : "is-hidden"].filter(Boolean).join(" ");
  const style: React.CSSProperties = win.maximized
    ? { zIndex: win.z }
    : { left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z };

  return (
    <section
      className={className}
      style={style}
      role="dialog"
      aria-label={title}
      aria-hidden={visible ? undefined : true}
      onPointerDownCapture={onFocus}
    >
      <header
        className="pane-window-titlebar"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest("button")) onToggleMaximize(); }}
      >
        <span className="pane-window-icon" aria-hidden="true">{icon}</span>
        <span className="pane-window-title">{title}</span>
        {subtitle && <span className="pane-window-subtitle">{subtitle}</span>}
        <span className="pane-window-controls">
          <button type="button" className="pane-window-control" aria-label={`Minimize ${title}`} title="Minimize" onClick={onMinimize}>
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 12h10" /></svg>
          </button>
          <button type="button" className="pane-window-control" aria-label={win.maximized ? `Restore ${title}` : `Maximize ${title}`} title={win.maximized ? "Restore" : "Maximize"} onClick={onToggleMaximize}>
            {win.maximized
              ? <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M5 5V3h8v8h-2M3 5h8v8H3z" /></svg>
              : <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 3h10v10H3z" /></svg>}
          </button>
          <button type="button" className="pane-window-control pane-window-close" aria-label={`Close ${title}`} title="Close" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
          </button>
        </span>
      </header>
      <div className="pane-window-body">{children}</div>
      {!win.maximized && EDGE_HANDLES.map(({ name, edges }) => (
        <span
          key={name}
          className={`pane-win-grip pane-win-grip-${name}`}
          onPointerDown={beginResize(edges)}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
      ))}
    </section>
  );
}
