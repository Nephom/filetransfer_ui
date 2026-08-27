import React from "react";
import type { SshProfileDraft } from "./useSessionsState";

type SshEntryDialogProps = {
  isEditing: boolean;
  workspaceName: string | undefined;
  sessionFormError: string;
  sshProfileDraft: SshProfileDraft;
  setSshProfileDraft: React.Dispatch<React.SetStateAction<SshProfileDraft>>;
  sshPasswordSaved: boolean;
  modalStyle: React.CSSProperties;
  onDragStart: (event: React.MouseEvent<HTMLElement>) => void;
  onClose: () => void;
  onForgetPassword: () => void;
  onRemove: () => void;
  onSave: () => void;
};

export function SshEntryDialog({
  isEditing,
  workspaceName,
  sessionFormError,
  sshProfileDraft,
  setSshProfileDraft,
  sshPasswordSaved,
  modalStyle,
  onDragStart,
  onClose,
  onForgetPassword,
  onRemove,
  onSave,
}: SshEntryDialogProps) {
  return (
    <div className="modal-cover modal-layer-top" onMouseDown={onClose}>
      <div className="modal ssh-entry-modal" style={modalStyle} onMouseDown={(event) => event.stopPropagation()}>
        <h2 className="modal-drag-handle" onMouseDown={onDragStart}>{isEditing ? "Edit SSH Entry" : "Add SSH Entry"}</h2>
        <p>Workspace: {workspaceName || "—"}</p>
        {sessionFormError && <output className="form-error" role="alert">{sessionFormError}</output>}
        <label>
          Connection name
          <input name="sshName" value={sshProfileDraft.name} onChange={(event) => setSshProfileDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Production shell" />
        </label>
        <label>
          Host
          <input name="sshHost" value={sshProfileDraft.host} onChange={(event) => setSshProfileDraft((current) => ({ ...current, host: event.target.value }))} placeholder="server.example.com" />
        </label>
        <label>
          Port
          <input name="sshPort" inputMode="numeric" value={sshProfileDraft.port} onChange={(event) => setSshProfileDraft((current) => ({ ...current, port: event.target.value }))} />
        </label>
        <label>
          Username
          <input name="sshUsername" value={sshProfileDraft.username} onChange={(event) => setSshProfileDraft((current) => ({ ...current, username: event.target.value }))} />
        </label>
        <label>
          Private key path (optional)
          <input name="sshPrivateKeyPath" value={sshProfileDraft.privateKeyPath} onChange={(event) => setSshProfileDraft((current) => ({ ...current, privateKeyPath: event.target.value }))} placeholder="/home/test/.ssh/id_ed25519" />
        </label>
        <label>
          Password (optional)
          <input type="password" name="sshPassword" value={sshProfileDraft.password} onChange={(event) => setSshProfileDraft((current) => ({ ...current, password: event.target.value }))} placeholder={sshPasswordSaved ? "Saved - leave blank to keep it" : "Not saved"} autoComplete="new-password" />
        </label>
        <small className="field-help">
          {sshPasswordSaved ? "A password is saved for this entry in the OS credential store (or a local fallback file outside the Session data)." : "No password saved yet. Add one here, or configure a private key, before connecting."}
          {" "}Used to authenticate and to auto-fill the terminal's password prompt; never written to Session data.
          {sshPasswordSaved && <> <button type="button" className="link-button" onClick={onForgetPassword}>Forget saved password</button></>}
        </small>
        <small className="field-help">Connect authenticates automatically with the private key or saved password. Use "Install SSH key" to push a key to the server using the saved password.</small>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          {isEditing && <button type="button" className="session-delete" onClick={onRemove}>Remove</button>}
          <button type="button" className="confirm" onClick={onSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
