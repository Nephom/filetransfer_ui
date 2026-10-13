import { useAppTranslation } from "../../i18n/useAppTranslation";
import React from "react";
import type { SshProfileDraft } from "./useSessionsState";

type SshEntryDialogProps = {
  isEditing: boolean;
  workspaceName: string | undefined;
  sessionFormError: string;
  sshProfileDraft: SshProfileDraft;
  setSshProfileDraft: React.Dispatch<React.SetStateAction<SshProfileDraft>>;
  sshPasswordSaved: boolean;
  sshEntrySaving: boolean;
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
  sshEntrySaving,
  modalStyle,
  onDragStart,
  onClose,
  onForgetPassword,
  onRemove,
  onSave,
}: SshEntryDialogProps) {
  const { t } = useAppTranslation();
  return (
    <div className="modal-cover modal-layer-top" onMouseDown={sshEntrySaving ? undefined : onClose}>
      <div className="modal ssh-entry-modal" style={modalStyle} onMouseDown={(event) => event.stopPropagation()}>
        <h2 className="modal-drag-handle" onMouseDown={onDragStart}>{t(isEditing ? "Edit SSH Entry" : "Add SSH Entry")}</h2>
        <p>{t("Workspace")}: {workspaceName || "—"}</p>
        {sessionFormError && <output className="form-error" role="alert">{sessionFormError}</output>}
        <label>
          {t("Connection name")}
          <input name="sshName" disabled={sshEntrySaving} value={sshProfileDraft.name} onChange={(event) => setSshProfileDraft((current) => ({ ...current, name: event.target.value }))} placeholder={t("Production shell")} />
        </label>
        <label>
          {t("Host")}
          <input name="sshHost" disabled={sshEntrySaving} value={sshProfileDraft.host} onChange={(event) => setSshProfileDraft((current) => ({ ...current, host: event.target.value }))} placeholder="server.example.com" />
        </label>
        <label>
          {t("Port")}
          <input name="sshPort" disabled={sshEntrySaving} inputMode="numeric" value={sshProfileDraft.port} onChange={(event) => setSshProfileDraft((current) => ({ ...current, port: event.target.value }))} />
        </label>
        <label>
          {t("Username")}
          <input name="sshUsername" disabled={sshEntrySaving} value={sshProfileDraft.username} onChange={(event) => setSshProfileDraft((current) => ({ ...current, username: event.target.value }))} />
        </label>
        <label>
          {t("Private key path (optional)")}
          <input name="sshPrivateKeyPath" disabled={sshEntrySaving} value={sshProfileDraft.privateKeyPath} onChange={(event) => setSshProfileDraft((current) => ({ ...current, privateKeyPath: event.target.value }))} placeholder="/home/test/.ssh/id_ed25519" />
        </label>
        <label>
          {t("Password (optional)")}
          <input type="password" name="sshPassword" disabled={sshEntrySaving} value={sshProfileDraft.password} onChange={(event) => setSshProfileDraft((current) => ({ ...current, password: event.target.value }))} placeholder={sshPasswordSaved ? t("Saved - leave blank to keep it") : t("Not saved")} autoComplete="new-password" />
        </label>
        <small className="field-help">
          {sshPasswordSaved ? t("A password is saved for this entry in the OS credential store.") : t("No password saved yet. Add one here, or configure a private key, before connecting.")}
          {" "}{t("Used to authenticate and to auto-fill the terminal’s password prompt; never written to Session data.")}
          {sshPasswordSaved && <> <button type="button" className="link-button" disabled={sshEntrySaving} onClick={onForgetPassword}>{t("Forget saved password")}</button></>}
        </small>
        <small className="field-help">{t("Connect authenticates automatically with the private key or saved password. Use Install SSH key to push a key to the server using the saved password.")}</small>
        <div className="modal-actions">
          <button type="button" disabled={sshEntrySaving} onClick={onClose}>{t("Cancel")}</button>
          {isEditing && <button type="button" className="session-delete" disabled={sshEntrySaving} onClick={onRemove}>{t("Remove")}</button>}
          <button type="button" className="confirm" disabled={sshEntrySaving} onClick={onSave}>{sshEntrySaving ? t("Saving…") : t("Save")}</button>
        </div>
      </div>
    </div>
  );
}
