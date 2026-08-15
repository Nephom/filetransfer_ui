import React from "react";
import { FloatingWindow } from "../../ui/FloatingWindow";

type ViewerModalProps = {
  title: string;
  content: string;
  modalStyle: React.CSSProperties;
  onDragStart: (event: React.MouseEvent<HTMLElement>) => void;
  onClose: () => void;
  onEdit: () => void;
  onCopy: () => void;
};

export function ViewerModal({ title, content, modalStyle, onDragStart, onClose, onEdit, onCopy }: ViewerModalProps) {
  return (
    <FloatingWindow
      ariaLabel={title || "File Viewer"}
      className="viewer-modal"
      style={modalStyle}
      onClose={onClose}
      onDragStart={onDragStart}
      header={<h2 className="modal-drag-handle">{title}</h2>}
      footer={(
        <div className="modal-actions">
          <button type="button" onClick={onEdit}>Edit in text editor</button>
          <button type="button" onClick={onCopy}>Copy</button>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      )}
    >
      <p className="muted">Read-only viewer. Edit opens this file in the default text editor.</p>
      <textarea className="file-viewer" value={content} readOnly spellCheck={false} />
    </FloatingWindow>
  );
}
