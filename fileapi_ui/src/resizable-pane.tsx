import React from "react";

type Props = {
  ariaLabel: string;
  onStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  onMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onEnd: () => void;
};

export function PaneResizeHandle({ ariaLabel, onStart, onMove, onEnd }: Props) {
  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    onStart(event);
  };

  return <div className="pane-resize-handle" onPointerDown={start} onPointerMove={onMove} onPointerUp={onEnd} onPointerCancel={onEnd} role="separator" aria-orientation="vertical" aria-label={ariaLabel} />;
}
