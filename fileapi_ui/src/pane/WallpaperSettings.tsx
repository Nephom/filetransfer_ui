import React, { useRef, useState } from "react";
import { Dropdown } from "../ui/Dropdown";
import {
  WALLPAPER_MAX_BYTES,
  WALLPAPER_SCALE_MAX,
  WALLPAPER_SCALE_MIN,
  WALLPAPER_STEP,
  clearWallpaper,
  setWallpaperImage,
  updateWallpaperConfig,
  useWallpaper,
  wallpaperCssVariables,
  type WallpaperFit,
} from "./pane-wallpaper-store";

const FIT_OPTIONS: { value: WallpaperFit; label: string }[] = [
  { value: "cover", label: "Fill (crop to fit)" },
  { value: "center", label: "Center (original size)" },
  { value: "stretch", label: "Stretch" },
];

/** Settings section for the Pane desktop wallpaper: image, fit, zoom and position. */
export function WallpaperSettings() {
  const { config, imageUrl } = useWallpaper();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const hasImage = Boolean(imageUrl);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      await setWallpaperImage(file);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await clearWallpaper();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  // background-position grows toward the image's far edge, so moving the
  // picture left/up means *increasing* the percentage.
  const move = (dx: number, dy: number) => updateWallpaperConfig({ x: config.x - dx, y: config.y - dy });

  return (
    <section className="settings-section wallpaper-settings">
      <h3>Desktop wallpaper</h3>
      <div className="settings-check">
        <span>
          <strong>Background image</strong>
          <small>{hasImage ? `${config.name || "Custom image"}` : "Using the built-in gradient."} Images up to {WALLPAPER_MAX_BYTES / 1048576} MB; stored on this computer only.</small>
        </span>
        <span className="wallpaper-actions">
          <input ref={inputRef} type="file" accept="image/*" hidden onChange={(event) => void choose(event.target.files?.[0])} />
          <button type="button" disabled={busy} onClick={() => inputRef.current?.click()}>Choose image…</button>
          <button type="button" disabled={busy || !hasImage} onClick={() => void remove()}>Use default</button>
        </span>
      </div>
      {error && <p className="settings-accent-warning" role="alert">{error}</p>}
      {hasImage && (
        <div className="wallpaper-editor">
          <div className="wallpaper-preview pane-wallpaper has-image" style={wallpaperCssVariables(config, imageUrl) as React.CSSProperties} aria-hidden="true">
            <div className="pane-wallpaper-image" />
          </div>
          <div className="wallpaper-controls">
            <label className="wallpaper-row">
              <span>Fit</span>
              <Dropdown label="Wallpaper fit" value={config.fit} onChange={(value) => updateWallpaperConfig({ fit: value as WallpaperFit })} options={FIT_OPTIONS} />
            </label>
            <label className="wallpaper-row">
              <span>Zoom {Math.round(config.scale * 100)}%</span>
              <input
                type="range"
                min={WALLPAPER_SCALE_MIN}
                max={WALLPAPER_SCALE_MAX}
                step={0.1}
                value={config.scale}
                onChange={(event) => updateWallpaperConfig({ scale: Number(event.target.value) })}
              />
            </label>
            <div className="wallpaper-row">
              <span>Position {config.x}% / {config.y}%</span>
              <span className="wallpaper-nudge" role="group" aria-label="Move wallpaper">
                <button type="button" aria-label="Move image left" onClick={() => move(-WALLPAPER_STEP, 0)}>←</button>
                <button type="button" aria-label="Move image up" onClick={() => move(0, -WALLPAPER_STEP)}>↑</button>
                <button type="button" aria-label="Move image down" onClick={() => move(0, WALLPAPER_STEP)}>↓</button>
                <button type="button" aria-label="Move image right" onClick={() => move(WALLPAPER_STEP, 0)}>→</button>
                <button type="button" onClick={() => updateWallpaperConfig({ x: 50, y: 50 })}>Center</button>
                <button type="button" onClick={() => updateWallpaperConfig({ scale: 1, x: 50, y: 50, fit: "cover" })}>Reset</button>
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
