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
  layout = paneReducer(layout, { type: "closeUnavailable", available: ["local", "remote"] });
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

test("window ids: singleton kinds keep their id, Browser panes use browser:<n>, SFTP windows are sftp:<entryId>, SSH windows are ssh:<entryId>#<n>", () => {
  assert.equal(model.sftpWindowId("entry-1"), "sftp:entry-1");
  assert.equal(model.sshEntryIdOf("sftp:entry-1"), "entry-1");
  assert.equal(model.sshEntryIdOf("sftp:"), null);
  assert.equal(model.sshEntryIdOf("local"), null);
  assert.equal(model.sshEntryIdOf("ssh:entry-1#1"), null, "an SSH window is not an SFTP window");
  assert.equal(model.sshWindowId("entry-1", 1), "ssh:entry-1#1");
  assert.equal(model.sshWindowId("entry-1", 12), "ssh:entry-1#12");
  assert.equal(model.sshPaneEntryIdOf("ssh:entry-1#2"), "entry-1");
  assert.equal(model.sshPaneInstanceOf("ssh:entry-1#2"), 2);
  assert.equal(model.sshPaneEntryIdOf("ssh:a#b#3"), "a#b", "the number is whatever follows the last #");
  assert.equal(model.sshPaneInstanceOf("ssh:a#b#3"), 3);
  for (const malformed of ["ssh:", "ssh:#1", "ssh:entry-1", "ssh:entry-1#", "ssh:entry-1#0", "ssh:entry-1#x", "ssh:entry-1#-2", "ssh:entry-1#1.5", "ssh:entry-1#01"]) {
    assert.equal(model.sshPaneEntryIdOf(malformed), null, malformed);
    assert.equal(model.sshPaneInstanceOf(malformed), null, malformed);
    assert.equal(model.kindOf(malformed), null, malformed);
  }
  assert.equal(model.sshPaneEntryIdOf("sftp:entry-1"), null);
  assert.equal(model.sshPaneInstanceOf("local"), null);
  assert.equal(model.browserWindowId(1), "browser:1");
  assert.equal(model.browserWindowId(12), "browser:12");
  assert.equal(model.browserPaneInstanceOf("browser:2"), 2);
  assert.equal(model.browserPaneInstanceOf("browser:0"), null);
  assert.equal(model.browserPaneInstanceOf("browser:01"), null);
  assert.equal(model.browserPaneInstanceOf("browser:abc"), null);
  assert.equal(model.browserPaneInstanceOf("browser:9007199254740992"), null);
  for (const id of ["local", "remote", "vnc", "rest"]) assert.equal(model.kindOf(id), id);
  assert.equal(model.kindOf("terminal"), null, "the shared Terminal window no longer exists");
  assert.equal(model.kindOf("sftp:entry-1"), "sftp");
  assert.equal(model.kindOf("ssh:entry-1#1"), "ssh");
  assert.equal(model.kindOf("browser:1"), "browser");
  assert.equal(model.kindOf("browser:01"), null);
  assert.equal(model.kindOf("sftp:"), null);
  assert.equal(model.kindOf("bogus"), null);
  assert.equal(model.kindOf(undefined), null);
  assert.deepEqual(model.minSizeOf("sftp:entry-1"), model.PANE_MIN_SIZE.sftp);
  assert.deepEqual(model.minSizeOf("ssh:entry-1#1"), model.PANE_MIN_SIZE.ssh);
  assert.equal(model.isEntryWindow("sftp:a"), true);
  assert.equal(model.isEntryWindow("ssh:a#1"), true);
  assert.equal(model.isEntryWindow("local"), false);
  assert.equal(model.isTransientWindow("browser:1"), true);
  assert.equal(model.isDynamicWindow("browser:2"), true);
  assert.deepEqual(model.minSizeOf("browser:1"), model.PANE_MIN_SIZE.browser);
});

test("Browser panes open independently, cascade, close individually, and are never persisted", () => {
  let layout = open(open(empty(), "browser:1"), "browser:2");
  const first = win(layout, "browser:1");
  const second = win(layout, "browser:2");
  assert.ok(first && second);
  assert.ok(second.x !== first.x || second.y !== first.y, "the second Browser pane does not sit exactly on the first");
  assert.equal(layout.activeId, "browser:2");
  layout = paneReducer(layout, { type: "closeUnavailable", available: ["local"], entryIds: [] });
  assert.ok(win(layout, "browser:1") && win(layout, "browser:2"), "on-demand Browser panes stay available without entry ids");

  layout = paneReducer(layout, { type: "close", id: "browser:1" });
  assert.equal(win(layout, "browser:1"), undefined);
  assert.ok(win(layout, "browser:2"), "closing one Browser leaves the other open");

  const stored = JSON.parse(model.serializeLayout(open(open(empty(), "local"), "browser:3")));
  assert.deepEqual(stored.windows.map((item) => item.id), ["local"]);
  const restored = model.normalizeStoredLayout({
    version: 1,
    windows: [
      ...stored.windows,
      { id: "browser:3", x: 0, y: 0, w: 600, h: 400, z: 3, open: true },
    ],
  });
  assert.deepEqual(restored.windows.map((item) => item.id), ["local"]);
});

test("several SFTP windows can be open at once, one per SSH entry", () => {
  let layout = open(open(empty(), "local"), "remote");
  layout = open(layout, "sftp:a");
  layout = open(layout, "sftp:b");
  assert.equal(layout.windows.filter((item) => model.kindOf(item.id) === "sftp").length, 2);
  assert.equal(layout.activeId, "sftp:b");
  // opening an entry that already has a window raises that window instead of adding another one
  layout = paneReducer(layout, { type: "focus", id: "sftp:a" });
  assert.equal(layout.activeId, "sftp:a");
  const count = layout.windows.length;
  layout = open(layout, "sftp:b");
  assert.equal(layout.windows.length, count);
  assert.equal(layout.activeId, "sftp:b");
  // unknown ids are ignored
  assert.equal(open(layout, "bogus"), layout);
});

test("new SFTP windows are cascaded and stay inside the layer", () => {
  let layout = open(open(open(empty(), "local"), "remote"), "sftp:a");
  layout = open(layout, "sftp:b");
  const first = win(layout, "sftp:a");
  const second = win(layout, "sftp:b");
  assert.ok(second.x !== first.x || second.y !== first.y, "the second SFTP window does not sit exactly on the first");
  for (const item of [first, second]) {
    assert.ok(item.x >= 0 && item.y >= 0 && item.x + item.w <= layer.w && item.y + item.h <= layer.h);
    assert.ok(item.w >= model.PANE_MIN_SIZE.sftp.w && item.h >= model.PANE_MIN_SIZE.sftp.h);
  }
});

test("closing an SFTP window discards it; other kinds keep their geometry", () => {
  let layout = open(open(empty(), "local"), "sftp:a");
  layout = paneReducer(layout, { type: "close", id: "sftp:a" });
  assert.equal(win(layout, "sftp:a"), undefined);
  assert.equal(layout.activeId, "local");
  layout = paneReducer(layout, { type: "close", id: "local" });
  assert.equal(win(layout, "local").open, false);
});

test("closeUnavailable drops SFTP windows whose SSH entry was removed", () => {
  let layout = open(open(open(empty(), "local"), "sftp:a"), "sftp:b");
  layout = paneReducer(layout, { type: "closeUnavailable", available: ["local", "sftp:a"], entryIds: [] });
  assert.ok(win(layout, "sftp:a"));
  assert.equal(win(layout, "sftp:b"), undefined);
});

test("SFTP windows are never persisted or restored", () => {
  const layout = open(open(open(empty(), "local"), "remote"), "sftp:a");
  const stored = JSON.parse(model.serializeLayout(layout));
  assert.deepEqual(stored.windows.map((item) => item.id).sort(), ["local", "remote"]);
  const withSftp = { version: 1, windows: [...stored.windows, { id: "sftp:a", x: 0, y: 0, w: 500, h: 400, z: 99, open: true }] };
  const restored = model.normalizeStoredLayout(withSftp);
  assert.deepEqual(restored.windows.map((item) => item.id).sort(), ["local", "remote"]);
  assert.notEqual(restored.activeId, "sftp:a");
});

test("the same SSH entry can be opened any number of times: every ssh:<entryId>#<n> is its own window", () => {
  let layout = open(open(empty(), "local"), "ssh:a#1");
  layout = open(layout, "ssh:a#2");
  layout = open(layout, "ssh:b#1");
  assert.equal(layout.windows.filter((item) => model.kindOf(item.id) === "ssh").length, 3);
  assert.equal(layout.windows.filter((item) => model.sshPaneEntryIdOf(item.id) === "a").length, 2, "one entry, two terminals");
  assert.equal(layout.activeId, "ssh:b#1");
  layout = paneReducer(layout, { type: "focus", id: "ssh:a#1" });
  const count = layout.windows.length;
  layout = open(layout, "ssh:a#2");
  assert.equal(layout.windows.length, count, "opening a window id that exists raises it instead of adding another");
  assert.equal(layout.activeId, "ssh:a#2");
  // an entry may have SSH windows and an SFTP window at the same time
  layout = open(layout, "sftp:a");
  assert.ok(win(layout, "ssh:a#1") && win(layout, "ssh:a#2") && win(layout, "sftp:a"));
});

test("new SSH windows are cascaded and stay inside the layer", () => {
  let layout = open(open(open(empty(), "local"), "remote"), "ssh:a#1");
  layout = open(layout, "ssh:a#2");
  const first = win(layout, "ssh:a#1");
  const second = win(layout, "ssh:a#2");
  assert.ok(second.x !== first.x || second.y !== first.y, "the second SSH window does not sit exactly on the first");
  for (const item of [first, second]) {
    assert.ok(item.x >= 0 && item.y >= 0 && item.x + item.w <= layer.w && item.y + item.h <= layer.h);
    assert.ok(item.w >= model.PANE_MIN_SIZE.ssh.w && item.h >= model.PANE_MIN_SIZE.ssh.h);
  }
});

test("closing one SSH window discards only that one; a removed SSH entry drops all of its windows", () => {
  let layout = open(open(empty(), "local"), "ssh:a#1");
  layout = open(layout, "ssh:a#2");
  layout = open(layout, "ssh:b#1");
  layout = paneReducer(layout, { type: "close", id: "ssh:a#1" });
  assert.equal(win(layout, "ssh:a#1"), undefined);
  assert.ok(win(layout, "ssh:a#2") && win(layout, "ssh:b#1"), "the other terminals stay");
  // SSH windows are not listed in `available`: they stay while their entry exists.
  layout = paneReducer(layout, { type: "closeUnavailable", available: ["local"], entryIds: ["a", "b"] });
  assert.ok(win(layout, "ssh:a#2") && win(layout, "ssh:b#1"));
  layout = paneReducer(layout, { type: "closeUnavailable", available: ["local"], entryIds: ["b"] });
  assert.equal(win(layout, "ssh:a#2"), undefined, "its entry no longer exists");
  assert.ok(win(layout, "ssh:b#1"));
  assert.equal(win(layout, "local").open, true);
});

test("SSH windows and the removed shared Terminal window are never restored", () => {
  const layout = open(open(open(empty(), "local"), "remote"), "ssh:a#1");
  const stored = JSON.parse(model.serializeLayout(layout));
  assert.deepEqual(stored.windows.map((item) => item.id).sort(), ["local", "remote"]);
  const old = { version: 1, windows: [
    ...stored.windows,
    { id: "ssh:a#1", x: 0, y: 0, w: 500, h: 400, z: 98, open: true },
    { id: "ssh:a", x: 0, y: 0, w: 500, h: 400, z: 97, open: true },
    { id: "terminal", x: 0, y: 0, w: 500, h: 400, z: 99, open: true },
  ] };
  const restored = model.normalizeStoredLayout(old);
  assert.deepEqual(restored.windows.map((item) => item.id).sort(), ["local", "remote"]);
});
