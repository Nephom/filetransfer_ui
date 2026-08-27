type ArchiveFormatDialogProps = {
  archiveFormatDraft: "tar.gz" | "zip" | "queue";
  setArchiveFormatDraft: (format: "tar.gz" | "zip" | "queue") => void;
  onClose: () => void;
  onConfirm: () => void;
};

export function ArchiveFormatDialog({ archiveFormatDraft, setArchiveFormatDraft, onClose, onConfirm }: ArchiveFormatDialogProps) {
  return (
    <div className="modal-cover" onMouseDown={onClose}>
      <div className="modal archive-format-modal" onMouseDown={(event) => event.stopPropagation()}>
        <h2>Choose download mode</h2>
        <p className="muted">Download as a single archive, or queue every file individually (preserving the original folder structure) like the Transfer Queue already does for uploads.</p>
        <label className="archive-format-option">
          <input type="radio" name="archiveFormat" checked={archiveFormatDraft === "tar.gz"} onChange={() => setArchiveFormatDraft("tar.gz")} />
          <span><strong>tar.gz archive</strong><small>Common on Linux and available with the tar command.</small></span>
        </label>
        <label className="archive-format-option">
          <input type="radio" name="archiveFormat" checked={archiveFormatDraft === "zip"} onChange={() => setArchiveFormatDraft("zip")} />
          <span><strong>zip archive</strong><small>Widely supported by desktop archive tools and other operating systems.</small></span>
        </label>
        <label className="archive-format-option">
          <input type="radio" name="archiveFormat" checked={archiveFormatDraft === "queue"} onChange={() => setArchiveFormatDraft("queue")} />
          <span><strong>Queue (one file at a time)</strong><small>No archive step; each file is downloaded individually and tracked in the Transfer Queue.</small></span>
        </label>
        <div className="modal-actions">
          <button type="button" className="confirm" onClick={onConfirm}>Add to Transfer Queue</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
