import { createPortal } from "react-dom";
import { useRef } from "react";
import { isAbsoluteLocalPath } from "../../path-utils";
import type { SshEntryTerminalController } from "./useSshEntryTerminal";

type Props = {
  terminal: SshEntryTerminalController;
  title: string;
  /** "native" keeps the look of the separate Tauri window; "pane" follows the app theme. */
  variant: "native" | "pane";
};

const CLASSES = {
  native: {
    root: "ssh-terminal-popup",
    header: "ssh-terminal-popup-header",
    title: "",
    status: "ssh-terminal-popup-header-status",
    host: "ssh-terminal-popup-host",
    saved: "ssh-popup-saved-logs",
    button: "",
    record: "ssh-popup-record",
  },
  pane: {
    root: "ssh-entry-pane",
    header: "ssh-entry-pane-header",
    title: "ssh-entry-pane-title",
    status: "ssh-entry-pane-status",
    host: "ssh-entry-pane-host",
    saved: "ssh-entry-pane-saved",
    button: "ssh-entry-pane-button",
    record: "ssh-entry-pane-record",
  },
} as const;

/**
 * Header: entry name | status | Connect / Disconnect | Record | Save Log, then
 * the terminal. Identical layout in the native window and in the SSH pane.
 */
export function SshEntryTerminalView({ terminal, title, variant }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cls = CLASSES[variant];
  const { saveLogDialog } = terminal;
  const join = (...names: string[]) => names.filter(Boolean).join(" ");

  // Dialogs render inside the themed app root (it carries the theme variables);
  // the native window has no such root, so they fall back to the body.
  const dialogHost = saveLogDialog.open ? rootRef.current?.closest<HTMLElement>(".explorer") || document.body : null;
  const dialog = saveLogDialog.open && dialogHost && createPortal(
    <div className="modal-cover modal-layer-top" onMouseDown={saveLogDialog.close}>
      <div className="modal log-name-modal" onMouseDown={(event) => event.stopPropagation()}>
        <h2>Name SSH log package</h2>
        <p>Choose the base name for the raw output, text, command, and metadata files. The application removes unsafe filename characters and adds the file extensions automatically.</p>
        <form onSubmit={(event) => { event.preventDefault(); void terminal.saveLog(); }}>
          <label>
            Log name
            <input autoFocus value={saveLogDialog.name} onChange={(event) => saveLogDialog.setName(event.target.value)} placeholder="Production console 2026-08-06" maxLength={120} required />
          </label>
          <small className="field-help">Save location: LOCAL {!saveLogDialog.destination ? "~" : isAbsoluteLocalPath(saveLogDialog.destination) ? saveLogDialog.destination : `~/${saveLogDialog.destination}`}</small>
          <div className="modal-actions">
            <button type="button" onClick={saveLogDialog.close} disabled={terminal.savingLog}>Cancel</button>
            <button className="confirm" type="submit" disabled={terminal.savingLog}>{terminal.savingLog ? "Saving…" : "Save Log"}</button>
          </div>
        </form>
      </div>
    </div>,
    dialogHost,
  );

  return (
    <div className={cls.root} ref={rootRef} aria-label={title}>
      <header className={cls.header}>
        {variant === "native" ? <h1>{title}</h1> : <strong className={cls.title} title={title}>{title}</strong>}
        <div className={cls.status}>
          <span title={terminal.status}>{terminal.status}</span>
          {terminal.connecting
            ? <button type="button" className={join(cls.button, "is-danger")} onClick={terminal.cancelConnect}>Cancel</button>
            : terminal.connected
              ? <button type="button" className={join(cls.button, "is-danger")} onClick={() => void terminal.disconnect()}>Disconnect</button>
              : <button type="button" className={join(cls.button, "is-connect")} onClick={terminal.connect}>Connect</button>}
          <button
            type="button"
            className={join(cls.button, cls.record, terminal.recording ? "recording" : "")}
            disabled={!terminal.connected || terminal.savingLog || terminal.startingRecording}
            onClick={() => void (terminal.recording ? terminal.stopRecording() : terminal.startRecording())}
          >
            {terminal.recording ? "Recording" : "Record"}
          </button>
          <button
            type="button"
            className={cls.button || undefined}
            disabled={terminal.recording || !terminal.hasRecordedOutput || terminal.savingLog}
            onClick={() => void terminal.openSaveLogDialog()}
          >
            Save Log
          </button>
        </div>
      </header>
      <div className={cls.host} ref={terminal.setHost} onMouseDown={terminal.focus} />
      {dialog}
      {terminal.savedLogPaths.length > 0 && <div className={cls.saved}>Saved: {terminal.savedLogPaths.join(" · ")}</div>}
    </div>
  );
}
