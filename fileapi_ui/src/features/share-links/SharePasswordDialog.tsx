type SharePasswordDialogProps = {
  sharePasswordDraft: string;
  setSharePasswordDraft: (value: string) => void;
  onClose: () => void;
  onCreate: (password?: string) => void;
};

export function SharePasswordDialog({ sharePasswordDraft, setSharePasswordDraft, onClose, onCreate }: SharePasswordDialogProps) {
  return (
    <div className="modal-cover modal-layer-top" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <h2>Secure share link</h2>
        <p className="muted">Optional: protect the link with a password. Leave blank to share without one.</p>
        <label>
          Password (optional)
          <input
            type="password"
            autoFocus
            value={sharePasswordDraft}
            onChange={(event) => setSharePasswordDraft(event.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="confirm" onClick={() => onCreate(sharePasswordDraft.trim() || undefined)}>
            Create link
          </button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
