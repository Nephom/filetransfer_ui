// Tracks the native Tauri windows opened for "Open in New Window" SSH
// terminals. They are real OS windows with their own webview, so they cannot
// live inside the Pane desktop; instead the main window keeps a registry so
// the taskbar can list, focus and close them.
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { SSH_POPUP_PREFIX, SSH_POPUP_STATE_EVENT, SSH_POPUP_STATE_REQUEST_EVENT, type SshPopupStatePayload } from "./ssh-popup-contracts";

export type SshPopupInfo = {
  label: string;
  title: string;
  entryId: string;
  connected: boolean;
  recordingUnsaved: boolean;
};

const popups = new Map<string, SshPopupInfo>();
const handles = new Map<string, WebviewWindow>();
const listeners = new Set<() => void>();
let snapshot: readonly SshPopupInfo[] = [];

const publish = () => {
  snapshot = Array.from(popups.values());
  listeners.forEach((listener) => listener());
};

export const subscribeSshPopups = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const getSshPopupSnapshot = () => snapshot;

const remove = (label: string) => {
  handles.delete(label);
  if (popups.delete(label)) publish();
};

/** Register a popup that this window just created. */
export function trackSshPopup(handle: WebviewWindow, info: Pick<SshPopupInfo, "label" | "title" | "entryId">) {
  popups.set(info.label, { ...info, connected: false, recordingUnsaved: false });
  handles.set(info.label, handle);
  publish();
  void handle.once("tauri://destroyed", () => remove(info.label));
  void handle.once("tauri://error", () => remove(info.label));
}

/**
 * Rebuild the registry from the windows that really exist. Needed after the
 * main webview reloads (handles are lost while the popups survive) and as a
 * safety net if a destroyed event was missed.
 */
export async function reconcileSshPopups() {
  const all = await WebviewWindow.getAll();
  const alive = new Map<string, WebviewWindow>();
  for (const handle of all) {
    if (handle.label.startsWith(SSH_POPUP_PREFIX)) alive.set(handle.label, handle);
  }
  let changed = false;
  for (const label of Array.from(popups.keys())) {
    if (!alive.has(label)) { popups.delete(label); handles.delete(label); changed = true; }
  }
  for (const [label, handle] of alive) {
    handles.set(label, handle);
    if (!popups.has(label)) {
      let title = label;
      try { title = await handle.title(); } catch { /* keep the label as a fallback title */ }
      popups.set(label, { label, title, entryId: "", connected: false, recordingUnsaved: false });
      void handle.once("tauri://destroyed", () => remove(label));
      changed = true;
    }
  }
  if (changed) publish();
  // Popups that survived a reload of this window cannot be matched to an SSH
  // entry from the handle alone; ask each of them to report its state again.
  if (alive.size > 0) void emit(SSH_POPUP_STATE_REQUEST_EVENT).catch(() => undefined);
}

/** Listen for state reports from the popups. Returns the disposer. */
export async function startSshPopupBridge(): Promise<UnlistenFn> {
  const unlisten = await listen<SshPopupStatePayload>(SSH_POPUP_STATE_EVENT, (event) => {
    const payload = event.payload;
    if (!payload?.label || !payload.label.startsWith(SSH_POPUP_PREFIX)) return;
    const current = popups.get(payload.label);
    popups.set(payload.label, {
      label: payload.label,
      title: payload.title || current?.title || payload.label,
      entryId: payload.entryId || current?.entryId || "",
      connected: payload.connected,
      recordingUnsaved: payload.recordingUnsaved,
    });
    publish();
  });
  // The bridge is now listening: collect the state of popups opened earlier.
  void emit(SSH_POPUP_STATE_REQUEST_EVENT).catch(() => undefined);
  return unlisten;
}

/** Bring a popup to the front: restore it when minimized, show it, focus it. */
export async function focusSshPopup(label: string) {
  const handle = handles.get(label) || (await WebviewWindow.getByLabel(label));
  if (!handle) { remove(label); return; }
  if (await handle.isMinimized()) await handle.unminimize();
  await handle.show();
  await handle.setFocus();
}

/** Ask a popup to close; its own close handler still guards unsaved recordings. */
export async function closeSshPopup(label: string) {
  const handle = handles.get(label) || (await WebviewWindow.getByLabel(label));
  if (!handle) { remove(label); return; }
  await handle.close();
}

export const hasUnsavedSshPopupRecording = () => Array.from(popups.values()).some((popup) => popup.recordingUnsaved);

/**
 * Close every popup. With `force` the windows are destroyed without running
 * their own close handler (which would ask about unsaved recordings again);
 * the caller has already confirmed.
 */
export async function closeAllSshPopups(force = false) {
  await Promise.all(Array.from(popups.keys()).map(async (label) => {
    try {
      if (!force) { await closeSshPopup(label); return; }
      const handle = handles.get(label) || (await WebviewWindow.getByLabel(label));
      if (handle) await handle.destroy();
      remove(label);
    } catch { /* a window that is already gone needs no further handling */ }
  }));
}
