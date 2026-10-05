import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript } from "./test-utils.js";

const model = loadTypeScript("pane/pane-window-model.ts");
const reactMock = { useCallback: (fn) => fn, useEffect() {}, useMemo: (fn) => fn(), useReducer() { throw new Error("not used"); } };
const { paneReducer } = loadTypeScript("pane/usePaneWindows.ts", { mocks: { react: reactMock } });

const layer = { w: 1000, h: 600 };
const empty = () => ({ windows: [], activeId: null });
const open = (layout, id) => paneReducer(layout, { type: "open", id, layer });
const win = (layout, id) => layout.windows.find((item) => item.id === id);

test("clampRect keeps windows inside the layer and above the minimum size", () => {
  const min = { w: 360, h: 260 };
  assert.deepEqual(model.clampRect({ x: -50, y: -10, w: 100, h: 100 }, layer, min), { x: 0, y: 0, w: 360, h: 260 });
  assert.deepEqual(model.clampRect({ x: 900, y: 580, w: 400, h: 300 }, layer, min), { x: 600, y: 300, w: 400, h: 300 });
  assert.deepEqual(model.clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, layer, min), { x: 0, y: 0, w: 1000, h: 600 });
  // a layer smaller than the minimum never produces a window larger than the layer
  assert.deepEqual(model.clampRect({ x: 10, y: 10, w: 400, h: 400 }, { w: 300, h: 200 }, min), { x: 0, y: 0, w: 300, h: 200 });
});

test("resizeRect anchors the opposite edge at the minimum size and stops at the layer", () => {
  const min = { w: 300, h: 200 };
  const start = { x: 100, y: 100, w: 400, h: 300 };
  assert.deepEqual(model.resizeRect(start, { e: true, s: true }, 50, 40, layer, min), { x: 100, y: 100, w: 450, h: 340 });
  assert.deepEqual(model.resizeRect(start, { w: true }, 500, 0, layer, min), { x: 200, y: 100, w: 300, h: 300 });
  assert.deepEqual(model.resizeRect(start, { n: true }, 0, -500, layer, min), { x: 100, y: 0, w: 400, h: 400 });
  assert.deepEqual(model.resizeRect(start, { e: true, s: true }, 9999, 9999, layer, min), { x: 100, y: 100, w: 900, h: 500 });
});

test("opening, focusing and minimizing keep z-order and the active window consistent", () => {
  let layout = open(open(empty(), "local"), "remote");
  assert.equal(layout.activeId, "remote");
  assert.ok(win(layout, "remote").z > win(layout, "local").z);
  layout = paneReducer(layout, { type: "focus", id: "local" });
  assert.equal(layout.activeId, "local");
  layout = paneReducer(layout, { type: "minimize", id: "local" });
  assert.equal(layout.activeId, "remote", "focus falls back to the next visible window");
  // a minimized window cannot be focused; opening it again restores it on top
  assert.equal(paneReducer(layout, { type: "focus", id: "local" }), layout);
  layout = open(layout, "local");
  assert.equal(win(layout, "local").minimized, false);
  assert.equal(layout.activeId, "local");
  layout = paneReducer(layout, { type: "close", id: "local" });
  assert.equal(win(layout, "local").open, false);
  assert.equal(layout.activeId, "remote");
  assert.equal(layout.windows.length, 2, "closed windows keep their geometry");
});

test("setRect and layerResized clamp every window to the available area", () => {
  let layout = open(open(empty(), "local"), "remote");
  layout = paneReducer(layout, { type: "setRect", id: "local", rect: { x: 5000, y: 5000, w: 400, h: 300 }, layer });
  assert.deepEqual({ x: win(layout, "local").x, y: win(layout, "local").y }, { x: 600, y: 300 });
  layout = paneReducer(layout, { type: "layerResized", layer: { w: 700, h: 400 } });
  for (const item of layout.windows) {
    assert.ok(item.x + item.w <= 700 && item.y + item.h <= 400, `${item.id} fits the shrunken layer`);
  }
  assert.equal(paneReducer(layout, { type: "layerResized", layer: { w: 0, h: 0 } }), layout, "an unmeasured layer is ignored");
});

test("closeUnavailable closes windows whose feature was disabled", () => {
  let layout = open(open(empty(), "local"), "rest");
  layout = paneReducer(layout, { type: "closeUnavailable", available: ["local", "remote", "terminal"] });
  assert.equal(win(layout, "rest").open, false);
  assert.equal(win(layout, "local").open, true);
});

test("stored layouts are validated before use", () => {
  const good = JSON.parse(model.serializeLayout(open(open(empty(), "local"), "remote")));
  const restored = model.normalizeStoredLayout(good);
  assert.equal(restored.windows.length, 2);
  assert.equal(restored.activeId, "remote");
  assert.equal(model.normalizeStoredLayout({ ...good, version: 99 }), null);
  assert.equal(model.normalizeStoredLayout({ version: 1, windows: [{ id: "bogus", x: 0, y: 0, w: 1, h: 1, z: 1 }] }), null);
  assert.equal(model.normalizeStoredLayout({ version: 1, windows: [{ id: "local", x: "a", y: 0, w: 1, h: 1, z: 1 }] }), null);
  assert.equal(model.loadStoredLayout({ getItem: () => "{not json" }), null);
});
