import { useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo, listen } from "@tauri-apps/api/event";
import { SSH_POPUP_STATE_EVENT, SSH_POPUP_STATE_REQUEST_EVENT, type SshPopupStatePayload } from "../../pane/ssh-popup-contracts";
import type { SshProfile } from "../ssh/ssh-contracts";
import { SshEntryTerminalView } from "./SshEntryTerminalView";
import { useSshEntryTerminal } from "./useSshEntryTerminal";

const popupQuery = () => {
  const query = new URLSearchParams(window.location.search);
  let profile: SshProfile | null = null;
  try {
    profile = JSON.parse(query.get("profile") || "null") as SshProfile | null;
  } catch {
    profile = null;
  }
  return {
    profile,
    title: query.get("title") || "SSH Terminal",
  };
};

export function isSshTerminalPopup() {
  return new URLSearchParams(window.location.search).get("sshPopup") === "1";
}

/**
 * The native "Open a new Window" terminal. The terminal itself is shared with
 * the in-app SSH pane (useSshEntryTerminal); this shell only owns what is
 * specific to a separate Tauri window: its title, the close request, and the
 * state reports the main window's taskbar listens to.
 */
export function SshTerminalPopup() {
  const [popup] = useState(popupQuery);
  const { profile, title } = popup;
  const currentWindow = getCurrentWebviewWindow();
  const terminal = useSshEntryTerminal({ profile, title, source: "SSH popup", autoConnect: true });
  const terminalRef = useRef(terminal);
  terminalRef.current = terminal;

  // Report connection / unsaved-recording state to the main window so its
  // taskbar can show this native window next to the in-app Pane windows.
  const statePayload: SshPopupStatePayload = {
    label: currentWindow.label,
    title,
    entryId: profile?.id || "",
    connected: terminal.connected,
    recordingUnsaved: terminal.recordingUnsaved,
  };
  const statePayloadRef = useRef(statePayload);
  statePayloadRef.current = statePayload;
  useEffect(() => {
    void emitTo("main", SSH_POPUP_STATE_EVENT, statePayloadRef.current).catch(() => undefined);
  }, [terminal.connected, terminal.recordingUnsaved, title, profile?.id]);

  // The main window asks for a fresh report when it (re)builds its registry,
  // e.g. after a reload, so it learns which SSH entry this window belongs to
  // and whether it is connected (needed to enable SFTP for that entry).
  useEffect(() => {
    const unlisten = listen(SSH_POPUP_STATE_REQUEST_EVENT, () => {
      void emitTo("main", SSH_POPUP_STATE_EVENT, statePayloadRef.current).catch(() => undefined);
    });
    return () => { void unlisten.then((dispose) => dispose()).catch(() => undefined); };
  }, []);

  useEffect(() => {
    document.title = title;
    void currentWindow.setTitle(title);
    const unlistenClose = currentWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      const current = terminalRef.current;
      if (current.hasUnsavedRecording() && !window.confirm("This SSH recording has not been saved. Close and discard it?")) return;
      await current.dispose();
      await currentWindow.destroy().catch(() => undefined);
    });
    return () => { void unlistenClose.then((dispose) => dispose()); };
  }, [title]);

  return <SshEntryTerminalView terminal={terminal} title={title} variant="native" />;
}
