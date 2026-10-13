import { useAppTranslation } from "../../i18n/useAppTranslation";
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
  const { t } = useAppTranslation();
  return (
    <FloatingWindow
      ariaLabel={title || t("File Viewer")}
      className="viewer-modal"
      style={modalStyle}
      onClose={onClose}
      onDragStart={onDragStart}
      header={<h2 className="modal-drag-handle">{title}</h2>}
      footer={(
        <div className="modal-actions">
          <button type="button" onClick={onEdit}>{t("Edit in text editor")}</button>
          <button type="button" onClick={onCopy}>{t("Copy")}</button>
          <button type="button" onClick={onClose}>{t("Close")}</button>
        </div>
      )}
    >
      <p className="muted">{t("Read-only viewer. Edit opens this file in the default text editor.")}</p>
      <textarea className="file-viewer" value={content} readOnly spellCheck={false} />
    </FloatingWindow>
  );
}
