// Desktop wallpaper: the image Blob lives in IndexedDB (localStorage is too
// small for pictures), the placement settings in localStorage. A tiny external
// store lets the Settings dialog and the desktop share one source of truth.
import { useSyncExternalStore } from "react";

export type WallpaperFit = "cover" | "center" | "stretch";

export type WallpaperConfig = {
  fit: WallpaperFit;
  /** 0.5 .. 2 */
  scale: number;
  /** background position, percent 0 .. 100 */
  x: number;
  y: number;
  /** file name of the stored image, "" when none */
  name: string;
};

export const WALLPAPER_MAX_BYTES = 5 * 1024 * 1024;
export const WALLPAPER_SCALE_MIN = 0.5;
export const WALLPAPER_SCALE_MAX = 2;
export const WALLPAPER_STEP = 10;

const CONFIG_KEY = "fileapi-pane-wallpaper";
const DB_NAME = "fileapi-pane";
const STORE_NAME = "wallpaper";
const IMAGE_KEY = "image";

export const defaultWallpaperConfig = (): WallpaperConfig => ({ fit: "cover", scale: 1, x: 50, y: 50, name: "" });

const clampNumber = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export function normalizeWallpaperConfig(raw: unknown): WallpaperConfig {
  const base = defaultWallpaperConfig();
  if (!raw || typeof raw !== "object") return base;
  const record = raw as Record<string, unknown>;
  const fit: WallpaperFit = record.fit === "center" || record.fit === "stretch" || record.fit === "cover" ? record.fit : base.fit;
  return {
    fit,
    scale: Math.round(clampNumber(record.scale, WALLPAPER_SCALE_MIN, WALLPAPER_SCALE_MAX, base.scale) * 10) / 10,
    x: Math.round(clampNumber(record.x, 0, 100, base.x)),
    y: Math.round(clampNumber(record.y, 0, 100, base.y)),
    name: typeof record.name === "string" ? record.name.slice(0, 200) : "",
  };
}

/** CSS custom properties consumed by .pane-wallpaper-image. */
export function wallpaperCssVariables(config: WallpaperConfig, imageUrl: string | null): Record<string, string> {
  const size = config.fit === "cover" ? "cover" : config.fit === "stretch" ? "100% 100%" : "auto";
  return {
    "--pane-wallpaper-image": imageUrl ? `url("${imageUrl}")` : "none",
    "--pane-wallpaper-size": size,
    "--pane-wallpaper-position": `${config.x}% ${config.y}%`,
    "--pane-wallpaper-scale": String(config.scale),
  };
}

type WallpaperState = { config: WallpaperConfig; imageUrl: string | null; loading: boolean };

let state: WallpaperState = { config: defaultWallpaperConfig(), imageUrl: null, loading: false };
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const setState = (next: Partial<WallpaperState>) => { state = { ...state, ...next }; emit(); };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open wallpaper storage"));
  });
}

async function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Wallpaper storage request failed"));
    });
  } finally {
    db.close();
  }
}

const readConfig = (): WallpaperConfig => {
  try {
    const text = localStorage.getItem(CONFIG_KEY);
    return normalizeWallpaperConfig(text ? JSON.parse(text) : null);
  } catch {
    return defaultWallpaperConfig();
  }
};

const writeConfig = (config: WallpaperConfig) => {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch { /* placement is then not remembered */ }
};

const replaceImageUrl = (blob: Blob | null) => {
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  return blob ? URL.createObjectURL(blob) : null;
};

/** Load the stored wallpaper once per app run. Safe to call repeatedly. */
export async function loadWallpaper() {
  if (loaded) return;
  loaded = true;
  const config = readConfig();
  setState({ config, loading: true });
  try {
    const blob = await idb<Blob | undefined>("readonly", (store) => store.get(IMAGE_KEY));
    if (blob instanceof Blob) setState({ imageUrl: replaceImageUrl(blob), loading: false });
    else setState({ imageUrl: replaceImageUrl(null), loading: false, config: config.name ? { ...config, name: "" } : config });
  } catch {
    setState({ loading: false });
  }
}

export async function setWallpaperImage(file: File) {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > WALLPAPER_MAX_BYTES) throw new Error(`The image is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${WALLPAPER_MAX_BYTES / 1048576} MB.`);
  await idb("readwrite", (store) => store.put(file, IMAGE_KEY));
  const config = { ...defaultWallpaperConfig(), name: file.name };
  writeConfig(config);
  setState({ config, imageUrl: replaceImageUrl(file) });
}

export async function clearWallpaper() {
  await idb("readwrite", (store) => store.delete(IMAGE_KEY));
  const config = defaultWallpaperConfig();
  writeConfig(config);
  setState({ config, imageUrl: replaceImageUrl(null) });
}

export function updateWallpaperConfig(change: Partial<Omit<WallpaperConfig, "name">>) {
  const config = normalizeWallpaperConfig({ ...state.config, ...change });
  writeConfig(config);
  setState({ config });
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => state;

export function useWallpaper() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
