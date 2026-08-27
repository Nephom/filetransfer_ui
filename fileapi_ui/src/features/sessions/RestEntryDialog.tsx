import React from "react";
import type { RestApiEntry } from "../../rest-api";

type RestEntryDialogProps = {
  isEditing: boolean;
  workspaceName: string | undefined;
  sessionFormError: string;
  restEntryDraft: RestApiEntry;
  setRestEntryDraft: (draft: RestApiEntry) => void;
  modalStyle: React.CSSProperties;
  onDragStart: (event: React.MouseEvent<HTMLElement>) => void;
  onClose: () => void;
  onRemove: () => void;
  onSave: () => void;
};

export function RestEntryDialog({
  isEditing,
  workspaceName,
  sessionFormError,
  restEntryDraft,
  setRestEntryDraft,
  modalStyle,
  onDragStart,
  onClose,
  onRemove,
  onSave,
}: RestEntryDialogProps) {
  return (
    <div className="modal-cover modal-layer-top" onMouseDown={onClose}>
      <div className="modal rest-entry-modal" style={modalStyle} onMouseDown={(event) => event.stopPropagation()}>
        <h2 className="modal-drag-handle" onMouseDown={onDragStart}>{isEditing ? "Edit REST API Entry" : "Add REST API Entry"}</h2>
        <p>Workspace: {workspaceName || "—"}</p>
        {sessionFormError && <output className="form-error" role="alert">{sessionFormError}</output>}
        <label>Name<input value={restEntryDraft.name} onChange={(event) => setRestEntryDraft({ ...restEntryDraft, name: event.target.value })} placeholder="Production BMC" /></label>
        <label>Base URL<input value={restEntryDraft.baseUrl} onChange={(event) => setRestEntryDraft({ ...restEntryDraft, baseUrl: event.target.value })} placeholder="https://api.example.com" /></label>
        <label>Default path<input value={restEntryDraft.defaultPath} onChange={(event) => setRestEntryDraft({ ...restEntryDraft, defaultPath: event.target.value })} placeholder="/v1/rest" /></label>
        <label className="tls-option"><input type="checkbox" checked={restEntryDraft.ignoreTlsErrors} onChange={(event) => setRestEntryDraft({ ...restEntryDraft, ignoreTlsErrors: event.target.checked })} /> Ignore TLS errors</label>
        <small className="field-help">Authentication mode, login path, and token settings are configured from the Authentication panel inside REST API mode once this entry is selected -- they're operational settings you tune while working with the entry, not part of its identity.</small>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          {isEditing && <button type="button" className="session-delete" onClick={onRemove}>Remove</button>}
          <button type="button" className="confirm" onClick={onSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
