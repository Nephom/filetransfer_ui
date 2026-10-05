import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript, hookDriver, deferred } from "./test-utils.js";

const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const nodes = (tree, predicate) => {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
};
const text = (tree) => Array.isArray(tree) ? tree.map(text).join("") : tree && typeof tree === "object" ? text(tree.props?.children) : typeof tree === "string" ? tree : "";

const file = (name, directory = false, parent = "") => ({ name, path: `${parent}/${name}`, isDirectory: directory, size: directory ? 0 : 5, modified: 1 });
const listings = {
  "/": { path: "/", files: [file("docs", true), file("a.txt")] },
  "/docs": { path: "/docs", files: [file("inner.txt", false, "/docs")] },
  "/other": { path: "/other", files: [file("x.txt", false, "/other")] },
};

// Mounts one production SftpWindow with its own hook state, mocked native
// commands and spy bridges. `entryId` selects which SSH entry it represents.
function mount(entryId, handler = () => undefined, extra = {}) {
  const driver = hookDriver(), calls = [], storage = new Map();
  const jsx = (type, props) => ({ type, props });
  const invoke = async (command, args) => {
    calls.push({ command, args });
    const result = handler(command, args);
    if (result !== undefined) return result;
    if (command === "ssh_list_directory") return listings[args.path] || { path: args.path, files: [] };
    if (command === "ssh_sftp_disconnect" || command === "ssh_rename_path") return command === "ssh_rename_path" ? args.newPath : null;
    throw new Error(`Unexpected native invocation: ${command}`);
  };
  const window = {
    innerWidth: 1280, innerHeight: 800, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  };
  const { SftpWindow } = loadTypeScript("features/sftp/SftpWindow.tsx", {
    mocks: {
      react: driver.react, "react/jsx-runtime": { jsx, jsxs: jsx }, "react-dom": { createPortal: jsx },
      "@tauri-apps/api/core": { invoke },
    },
    globals: {
      window, document: { body: {} },
      localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    },
  });
  const spies = { logs: [], undo: [], removedUndo: [], uploads: [], downloads: [], refresh: new Map(), paths: [], finished: 0, crossNotices: 0, finishedAfterDrop: 0 };
  const dnd = {
    dragItems: [],
    itemsRef: { current: [] }, sourceRef: { current: "" }, entryRef: { current: "" },
    begin(_event, from, items) { dnd.itemsRef.current = items; dnd.sourceRef.current = "remote"; dnd.entryRef.current = from; },
    finish() { spies.finished++; dnd.itemsRef.current = []; dnd.sourceRef.current = ""; },
    finishAfterDrop() { spies.finishedAfterDrop++; },
    isExternalFileDrag: () => false, notifyExternalFileDrag: () => false,
    showCrossWindowNotice() { spies.crossNotices++; },
  };
  const profile = { id: entryId, name: `Entry ${entryId}`, host: "ssh.test", port: 22, username: "user", privateKeyPath: "" };
  const props = {
    entryId, profile,
    writeOperationLog: (...args) => spies.logs.push(args), describeError: String,
    requestName: async () => "renamed", requestConfirmation: async () => true, confirmDelete: true, folderResizeEnabled: false,
    undoEnabled: true, undoEntries: [], recordUndo: (entry) => spies.undo.push(entry), removeUndo: (id) => spies.removedUndo.push(id),
    dnd,
    transfer: {
      uploadPaths: (...args) => spies.uploads.push(["paths", ...args]),
      uploadLocalItems: (...args) => spies.uploads.push(["local", ...args]),
      downloadToLocal: (...args) => spies.downloads.push(args),
    },
    registerRefresh: (id, refresh) => { if (refresh) spies.refresh.set(id, refresh); else spies.refresh.delete(id); },
    onPathChange: (id, nextPath) => spies.paths.push([id, nextPath]),
    ...extra,
  };
  const render = () => driver.render(() => SftpWindow(props));
  const listed = () => calls.filter((call) => call.command === "ssh_list_directory").map((call) => call.args.path);
  return { render, calls, props, spies, driver, dnd, listed, profile };
}

const rowFor = (tree, path) => nodes(tree, (node) => node.props?.["data-path"] === path)[0];
const button = (tree, label) => nodes(tree, (node) => node.type === "button" && text(node) === label)[0];
const dropEvent = () => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: {} });

test("an SFTP window lists the root of its own SSH entry on open and reports its folder", async () => {
  const app = mount("ssh-A");
  app.render(); await tick();
  const tree = app.render();
  assert.deepEqual(app.listed(), ["/", "/"], "folder list and tree both read the root through SFTP");
  assert.ok(app.calls.filter((call) => call.command === "ssh_list_directory").every((call) => call.args.profile.id === "ssh-A"));
  assert.ok(rowFor(tree, "/a.txt") && rowFor(tree, "/docs"));
  assert.match(text(tree), /Entry ssh-A/);
  assert.deepEqual(app.spies.paths.at(-1), ["ssh-A", "/"]);
  assert.ok(app.spies.refresh.has("ssh-A"), "registers for queue refreshes");
});

test("navigating into a folder lists it and clears the selection", async () => {
  const app = mount("ssh-A");
  app.render(); await tick();
  rowFor(app.render(), "/a.txt").props.onClick({});
  assert.match(text(app.render()), /1 selected/);
  rowFor(app.render(), "/docs").props.onDoubleClick(); await tick();
  const tree = app.render();
  assert.ok(rowFor(tree, "/docs/inner.txt"));
  assert.equal(rowFor(tree, "/a.txt"), undefined);
  assert.doesNotMatch(text(tree), /1 selected/);
  assert.deepEqual(app.spies.paths.at(-1), ["ssh-A", "/docs"]);
});

test("a late reply for a previous folder cannot replace the folder the user moved to", async () => {
  const late = deferred();
  const app = mount("ssh-A", (command, args) => (command === "ssh_list_directory" && args.path === "/docs" ? late.promise : undefined));
  app.render(); await tick();
  rowFor(app.render(), "/docs").props.onDoubleClick(); await tick();
  nodes(app.render(), (node) => node.type === "button" && text(node) === "/")[0].props.onClick(); await tick();
  late.resolve(listings["/docs"]); await tick();
  const tree = app.render();
  assert.ok(rowFor(tree, "/a.txt"), "still showing the root");
  assert.equal(rowFor(tree, "/docs/inner.txt"), undefined);
});

test("two SFTP windows keep independent folders, selections and connections", async () => {
  const first = mount("ssh-A");
  const second = mount("ssh-B", (command, args) => (command === "ssh_list_directory" && args.path === "/" ? { path: "/", files: [file("only-b.txt")] } : undefined));
  first.render(); second.render(); await tick();
  rowFor(first.render(), "/docs").props.onDoubleClick(); await tick();
  rowFor(second.render(), "/only-b.txt").props.onClick({}); await tick();
  const a = first.render(), b = second.render();
  assert.ok(rowFor(a, "/docs/inner.txt") && !rowFor(a, "/only-b.txt"));
  assert.ok(rowFor(b, "/only-b.txt") && !rowFor(b, "/docs/inner.txt"));
  assert.match(text(b), /1 selected/);
  assert.doesNotMatch(text(a), /1 selected/);
  assert.ok(first.calls.every((call) => !call.args?.profile || call.args.profile.id === "ssh-A"));
  assert.ok(second.calls.every((call) => !call.args?.profile || call.args.profile.id === "ssh-B"));
});

test("a busy operation in one window does not disable another window", async () => {
  const slow = deferred();
  const first = mount("ssh-A", (command) => (command === "ssh_create_directory" ? slow.promise : undefined));
  const second = mount("ssh-B");
  first.render(); second.render(); await tick();
  button(first.render(), "New folder").props.onClick(); await tick();
  assert.equal(button(first.render(), "New folder").props.disabled, true, "the window running the operation is busy");
  assert.equal(button(second.render(), "New folder").props.disabled, false, "the other window stays usable");
  slow.resolve(null); await tick();
  assert.equal(button(first.render(), "New folder").props.disabled, false);
});

test("closing an SFTP window releases its SFTP connection", async () => {
  const app = mount("ssh-A");
  app.render(); await tick();
  app.driver.unmount(); await tick();
  const disconnect = app.calls.find((call) => call.command === "ssh_sftp_disconnect");
  assert.deepEqual(disconnect.args, { entryId: "ssh-A" });
  assert.equal(app.spies.refresh.has("ssh-A"), false, "unregisters from queue refreshes");
});

test("the queue refresh callback reloads only the folder currently shown", async () => {
  const app = mount("ssh-A");
  app.render(); await tick();
  const before = app.listed().length;
  app.spies.refresh.get("ssh-A")("/somewhere-else"); await tick();
  assert.equal(app.listed().length, before, "an unrelated folder is ignored");
  app.spies.refresh.get("ssh-A")("/"); await tick();
  assert.equal(app.listed().length, before + 1);
});

test("dropping LOCAL items on a folder uploads them to that SFTP folder", async () => {
  const app = mount("ssh-A");
  app.render(); await tick();
  const items = [{ name: "up.txt", path: "up.txt", isDirectory: false, size: 1, modified: 0 }];
  app.dnd.itemsRef.current = items; app.dnd.sourceRef.current = "local";
  const row = rowFor(app.render(), "/docs");
  let prevented = false;
  row.props.onDragOver({ preventDefault() { prevented = true; }, dataTransfer: {} });
  assert.equal(prevented, true, "a LOCAL drag is accepted over a folder");
  row.props.onDrop(dropEvent());
  assert.deepEqual(app.spies.uploads, [["local", "ssh-A", items, "/docs"]]);
  assert.equal(app.spies.finished, 1);
});

test("moving within the same SFTP window renames over SFTP and records an undo entry", async () => {
  const app = mount("ssh-A");
  app.render(); await tick();
  const items = [file("a.txt")];
  app.dnd.begin({}, "ssh-A", items);
  rowFor(app.render(), "/docs").props.onDrop(dropEvent()); await tick();
  const rename = app.calls.find((call) => call.command === "ssh_rename_path");
  assert.deepEqual({ oldPath: rename.args.oldPath, newPath: rename.args.newPath, profile: rename.args.profile.id }, { oldPath: "/a.txt", newPath: "/docs/a.txt", profile: "ssh-A" });
  assert.deepEqual(app.spies.undo.map((entry) => [entry.source, entry.entryId, entry.oldPath, entry.newPath]), [["ssh", "ssh-A", "/a.txt", "/docs/a.txt"]]);
  assert.equal(app.spies.crossNotices, 0);
});

test("a drag from another remote window is refused with the manual download + upload notice", async () => {
  const app = mount("ssh-A");
  app.render(); await tick();
  app.dnd.begin({}, "ssh-B", [{ name: "b.txt", path: "/b.txt", isDirectory: false, size: 1, modified: 0 }]);
  const row = rowFor(app.render(), "/docs");
  let prevented = false;
  row.props.onDragOver({ preventDefault() { prevented = true; }, dataTransfer: {} });
  assert.equal(prevented, true, "the drop is accepted so the explanation can be shown");
  row.props.onDrop(dropEvent()); await tick();
  assert.equal(app.spies.crossNotices, 1);
  assert.equal(app.calls.some((call) => call.command === "ssh_rename_path"), false, "nothing was moved or copied");
  assert.deepEqual(app.spies.uploads, []);
  // an API Remote drag ("remote" source without an SFTP entry) is refused the same way
  app.dnd.sourceRef.current = "remote"; app.dnd.entryRef.current = ""; app.dnd.itemsRef.current = [file("api.txt")];
  rowFor(app.render(), "/docs").props.onDrop(dropEvent());
  assert.equal(app.spies.crossNotices, 2);
});

test("an item cannot be dropped into its own folder or its own subfolder", async () => {
  const app = mount("ssh-A");
  app.render(); await tick();
  app.dnd.begin({}, "ssh-A", [file("docs", true)]);
  let prevented = false;
  rowFor(app.render(), "/docs").props.onDragOver({ preventDefault() { prevented = true; }, dataTransfer: {} });
  assert.equal(prevented, false);
});

test("Download and double click bring SFTP files into LOCAL through the queue bridge", async () => {
  const app = mount("ssh-A");
  app.render(); await tick();
  rowFor(app.render(), "/a.txt").props.onClick({});
  button(app.render(), "Download").props.onClick();
  assert.deepEqual(app.spies.downloads.map(([entry, items]) => [entry, items.map((item) => item.path)]), [["ssh-A", ["/a.txt"]]]);
  rowFor(app.render(), "/a.txt").props.onDoubleClick();
  assert.equal(app.spies.downloads.length, 2);
});

test("Rename, Delete and Undo run through SFTP for this entry only", async () => {
  const app = mount("ssh-A", undefined, {
    undoEntries: [
      { id: "u-other", description: "other entry", source: "ssh", entryId: "ssh-B", oldPath: "/o", newPath: "/p" },
      { id: "u-mine", description: "mine", source: "ssh", entryId: "ssh-A", oldPath: "/old", newPath: "/new" },
      { id: "u-api", description: "api", source: "api", oldPath: "x", newPath: "y" },
    ],
  });
  app.render(); await tick();
  rowFor(app.render(), "/a.txt").props.onClick({});
  button(app.render(), "Rename").props.onClick(); await tick();
  const rename = app.calls.find((call) => call.command === "ssh_rename_path");
  assert.equal(rename.args.newPath, "/renamed");
  rowFor(app.render(), "/a.txt").props.onClick({});
  button(app.render(), "Delete").props.onClick(); await tick();
  assert.deepEqual(app.calls.find((call) => call.command === "ssh_delete_path").args.path, "/a.txt");
  button(app.render(), "Undo").props.onClick(); await tick();
  const undo = app.calls.filter((call) => call.command === "ssh_rename_path").at(-1);
  assert.deepEqual({ oldPath: undo.args.oldPath, newPath: undo.args.newPath }, { oldPath: "/new", newPath: "/old" });
  assert.deepEqual(app.spies.removedUndo, ["u-mine"]);
});

test("a window whose SSH entry disappeared reports it instead of listing", async () => {
  const app = mount("ssh-A", undefined, { profile: undefined });
  app.render(); await tick();
  assert.equal(app.listed().length, 0);
  assert.match(text(app.render()), /no longer available/);
  assert.equal(button(app.render(), "New folder").props.disabled, true);
});
