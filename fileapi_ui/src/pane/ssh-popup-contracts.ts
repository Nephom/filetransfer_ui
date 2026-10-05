// Contract shared by the main window (taskbar) and SSH popup windows.
export const SSH_POPUP_PREFIX = "ssh-entry-popup-";
export const SSH_POPUP_STATE_EVENT = "ssh-popup-state";
/** Broadcast by the main window: every popup answers with a fresh SSH_POPUP_STATE_EVENT. */
export const SSH_POPUP_STATE_REQUEST_EVENT = "ssh-popup-state-request";

export type SshPopupStatePayload = {
  label: string;
  title: string;
  entryId: string;
  connected: boolean;
  /** true while a recording is running or has output that was never saved. */
  recordingUnsaved: boolean;
};
