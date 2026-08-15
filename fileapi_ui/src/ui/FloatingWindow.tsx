import React from "react";
import { overlayZIndex } from "./overlay-registry";

type FloatingWindowProps = {
  ariaLabel: string;
  className?: string;
  style?: React.CSSProperties;
  header: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  onDragStart?: (event: React.MouseEvent<HTMLElement>) => void;
};

export function FloatingWindow({ ariaLabel, className = "", style, header, children, footer, onClose, onDragStart }: FloatingWindowProps) {
  return (
    <div className="modal-cover modal-layer-top floating-window-layer" style={{ zIndex: overlayZIndex.modal }} onMouseDown={onClose}>
      <section
        className={`modal floating-window ${className}`.trim()}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="floating-window-header" onMouseDown={onDragStart}>{header}</div>
        <div className="floating-window-content">{children}</div>
        {footer && <div className="floating-window-footer">{footer}</div>}
      </section>
    </div>
  );
}
