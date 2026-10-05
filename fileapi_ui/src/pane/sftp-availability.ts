import type { SshPopupInfo } from "./ssh-popup-registry";

/**
 * An SSH entry can be opened as an SFTP window once the user has a live
 * connection for it: either a connected tab in the main window's Terminal, or
 * a connected native "Open in New Window" terminal (those run in their own
 * webview, so the main window only learns about them from the popup registry).
 */
export function isSshEntryConnected(
  entryId: string,
  tabs: readonly { sshEntryId: string; connected: boolean }[],
  popups: readonly Pick<SshPopupInfo, "entryId" | "connected">[],
): boolean {
  if (!entryId) return false;
  return tabs.some((tab) => tab.sshEntryId === entryId && tab.connected)
    || popups.some((popup) => popup.entryId === entryId && popup.connected);
}
