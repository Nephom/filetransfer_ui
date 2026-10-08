import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * A native Browser view always paints above the DOM, so it is hidden whenever
 * its pane is not the active one or an overlay is open. The last picture of the
 * page is kept here so the pane (and the taskbar preview) can show it meanwhile.
 * Images only live in memory; nothing is written to disk.
 */
export type BrowserSnapshot = {
  /** `data:image/jpeg;base64,...` of the visible page area. */
  dataUrl: string;
  /** Address of the page when the picture was taken. */
  url: string;
  capturedAt: number;
};

const snapshots = new Map<string, BrowserSnapshot>();
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());

export function subscribeBrowserSnapshots(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getBrowserSnapshot(paneId: string): BrowserSnapshot | undefined {
  return snapshots.get(paneId);
}

export function useBrowserSnapshot(paneId: string): BrowserSnapshot | undefined {
  return useSyncExternalStore(subscribeBrowserSnapshots, () => snapshots.get(paneId), () => undefined);
}

export function clearBrowserSnapshot(paneId: string): void {
  if (snapshots.delete(paneId)) notify();
}

/**
 * Takes a picture of the pane's visible page area and stores it. The native
 * view has to be shown while this runs. Returns false (keeping the previous
 * picture) when the browser could not deliver an image.
 */
export async function captureBrowserSnapshot(paneId: string, url: string): Promise<boolean> {
  try {
    const data = await invoke<string>("browser_capture_preview", { paneId });
    if (!data) return false;
    snapshots.set(paneId, { dataUrl: `data:image/jpeg;base64,${data}`, url, capturedAt: Date.now() });
    notify();
    return true;
  } catch {
    return false;
  }
}
