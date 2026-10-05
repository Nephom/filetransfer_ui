import type { SshPopupInfo } from "./ssh-popup-registry";

/**
 * An SSH entry can be opened as an SFTP window once the user has a live
 * connection for it: either one of its SSH panes in the main window is
 * connected (an entry can have several), or a connected native "Open a new
 * Window" terminal exists (those run in their own webview, so the main window
 * only learns about them from the popup registry).
 */
export function isSshEntryConnected(
  entryId: string,
  panes: Readonly<Record<string, { entryId: string; connected: boolean } | undefined>>,
  popups: readonly Pick<SshPopupInfo, "entryId" | "connected">[],
): boolean {
  if (!entryId) return false;
  return Object.values(panes).some((pane) => pane?.entryId === entryId && pane.connected)
    || popups.some((popup) => popup.entryId === entryId && popup.connected);
}
