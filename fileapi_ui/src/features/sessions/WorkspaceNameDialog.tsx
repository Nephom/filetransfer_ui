import React from "react";

type WorkspaceNameDialogProps = {
  isEditing: boolean;
  sessionFormError: string;
  sessionNameDraft: string;
  setSessionNameDraft: (value: string) => void;
  modalStyle: React.CSSProperties;
  onDragStart: (event: React.MouseEvent<HTMLElement>) => void;
  onClose: () => void;
  onSave: (form: HTMLFormElement) => void;
};

export function WorkspaceNameDialog({
  isEditing,
  sessionFormError,
  sessionNameDraft,
  setSessionNameDraft,
  modalStyle,
  onDragStart,
  onClose,
  onSave,
}: WorkspaceNameDialogProps) {
  return (
    <div className="modal-cover modal-layer-top" onMouseDown={onClose}>
      <form
        className="modal workspace-name-modal"
        style={modalStyle}
        onSubmit={(event) => { event.preventDefault(); onSave(event.currentTarget); }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="modal-drag-handle" onMouseDown={onDragStart}>{isEditing ? "Edit Workspace" : "Add Workspace"}</h2>
        {sessionFormError && <output className="form-error" role="alert">{sessionFormError}</output>}
        <label>
          Workspace name
          <input name="sessionName" value={sessionNameDraft} onChange={(event) => setSessionNameDraft(event.target.value)} placeholder="Default" required autoFocus />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="confirm">Save</button>
        </div>
      </form>
    </div>
  );
}
