import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript } from "./test-utils.js";

const { normalizeDesktopSettings, defaultDesktopSettings } = loadTypeScript("features/settings/settings-contracts.ts");

test("window shadows are on by default, also for settings saved before the option existed", () => {
  assert.equal(defaultDesktopSettings.paneShadowEnabled, true);
  assert.equal(normalizeDesktopSettings(null).paneShadowEnabled, true);
  assert.equal(normalizeDesktopSettings({ glassMainEnabled: false }).paneShadowEnabled, true);
});

test("window shadows keep an explicit choice and ignore invalid values", () => {
  assert.equal(normalizeDesktopSettings({ paneShadowEnabled: false }).paneShadowEnabled, false);
  assert.equal(normalizeDesktopSettings({ paneShadowEnabled: true }).paneShadowEnabled, true);
  assert.equal(normalizeDesktopSettings({ paneShadowEnabled: "no" }).paneShadowEnabled, true);
  // the other settings are untouched by the new one
  assert.equal(normalizeDesktopSettings({ paneShadowEnabled: false, glassMainEnabled: false }).glassMainEnabled, false);
});
