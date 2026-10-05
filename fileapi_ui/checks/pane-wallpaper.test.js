import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript } from "./test-utils.js";

const { normalizeWallpaperConfig, wallpaperCssVariables, defaultWallpaperConfig } = loadTypeScript("pane/pane-wallpaper-store.ts", {
  mocks: { react: { useSyncExternalStore: () => undefined } },
});

test("wallpaper placement is clamped to its documented ranges", () => {
  assert.deepEqual(normalizeWallpaperConfig({ fit: "stretch", scale: 9, x: -20, y: 250, name: "a.png" }), { fit: "stretch", scale: 2, x: 0, y: 100, name: "a.png" });
  assert.deepEqual(normalizeWallpaperConfig({ scale: 0.1 }).scale, 0.5);
  assert.equal(normalizeWallpaperConfig({ scale: 1.26 }).scale, 1.3, "scale snaps to one decimal");
  assert.deepEqual(normalizeWallpaperConfig(null), defaultWallpaperConfig());
  assert.equal(normalizeWallpaperConfig({ fit: "diagonal" }).fit, "cover");
  assert.equal(normalizeWallpaperConfig({ x: NaN, y: "5" }).x, 50);
});

test("wallpaper CSS variables map the fit presets", () => {
  const base = { scale: 1.5, x: 30, y: 70, name: "" };
  assert.equal(wallpaperCssVariables({ ...base, fit: "cover" }, "blob:x")["--pane-wallpaper-size"], "cover");
  assert.equal(wallpaperCssVariables({ ...base, fit: "stretch" }, "blob:x")["--pane-wallpaper-size"], "100% 100%");
  assert.equal(wallpaperCssVariables({ ...base, fit: "center" }, "blob:x")["--pane-wallpaper-size"], "auto");
  const vars = wallpaperCssVariables({ ...base, fit: "cover" }, "blob:x");
  assert.equal(vars["--pane-wallpaper-position"], "30% 70%");
  assert.equal(vars["--pane-wallpaper-scale"], "1.5");
  assert.equal(vars["--pane-wallpaper-image"], 'url("blob:x")');
  assert.equal(wallpaperCssVariables({ ...base, fit: "cover" }, null)["--pane-wallpaper-image"], "none");
});
