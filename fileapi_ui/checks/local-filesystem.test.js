import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript } from "./test-utils.js";

const { downloadPath, isAbsoluteLocalPath, localBreadcrumbSegments, localParentPath, showLocalUp } = loadTypeScript("path-utils.ts");

test("LOCAL roots are atomic, normalized and cannot navigate Up", () => {
  for (const [input, root] of [
    ["", ""], ["/", "/"], ["///", "/"],
    ["C:", "C:/"], ["C:/", "C:/"], ["C:\\", "C:/"], ["z:///", "z:/"],
    ["//server/share", "//server/share"], ["//server/share/", "//server/share"],
    ["//server/share///", "//server/share"], ["\\\\server\\share\\", "//server/share"],
    ["//server/Share Name/", "//server/Share Name"],
  ]) {
    assert.deepEqual(localBreadcrumbSegments(input), [{ label: root || "HOMEDIR/", target: root }], input);
    assert.equal(localParentPath(input), root, input);
    assert.equal(localParentPath(localParentPath(input)), root, input);
    assert.equal(showLocalUp(input), false, input);
    assert.equal(isAbsoluteLocalPath(input), Boolean(root), input);
  }
});

test("LOCAL breadcrumbs retain each root and each child navigation target", () => {
  for (const [path, expected] of [
    ["Documents/Logs/", [["HOMEDIR/", ""], ["Documents", "Documents"], ["Logs", "Documents/Logs"]]],
    ["/var/log/", [["/", "/"], ["var", "/var"], ["log", "/var/log"]]],
    ["D:/Projects/logs/", [["D:/", "D:/"], ["Projects", "D:/Projects"], ["logs", "D:/Projects/logs"]]],
    ["D:\\Projects\\logs\\", [["D:/", "D:/"], ["Projects", "D:/Projects"], ["logs", "D:/Projects/logs"]]],
    ["//server/share/folder/logs/", [["//server/share", "//server/share"], ["folder", "//server/share/folder"], ["logs", "//server/share/folder/logs"]]],
    ["\\\\server\\share\\folder\\logs\\", [["//server/share", "//server/share"], ["folder", "//server/share/folder"], ["logs", "//server/share/folder/logs"]]],
    ["//server/Share Name/report #1/", [["//server/Share Name", "//server/Share Name"], ["report #1", "//server/Share Name/report #1"]]],
  ]) {
    const segments = localBreadcrumbSegments(path);
    assert.deepEqual(segments, expected.map(([label, target]) => ({ label, target })), path);
    assert.equal(localParentPath(path), expected.at(-2)[1], path);
    assert.equal(showLocalUp(path), true, path);
    for (let index = 1; index < segments.length; index++) {
      assert.equal(localParentPath(segments[index].target), segments[index - 1].target, path);
    }
  }
});

test("HOME-relative navigation only leaves HOME when an elevated HOME path is supplied", () => {
  for (const [home, parent, up] of [
    ["", "", false], ["/home/alice", "/home", true], ["C:/Users/alice", "C:/Users", true],
    ["//server/share/alice", "//server/share", true],
    ["/", "/", false], ["C:/", "C:/", false], ["//server/share/", "//server/share", false],
  ]) {
    assert.equal(localParentPath("", home), parent, home);
    assert.equal(showLocalUp("", home), up, home);
    assert.equal(localParentPath("Documents", home), "", home);
    assert.equal(localParentPath("Documents/logs", home), "Documents", home);
    assert.equal(showLocalUp("Documents", home), true, home);
    assert.deepEqual(localBreadcrumbSegments(""), [{ label: "HOMEDIR/", target: "" }]);
  }
  assert.equal(isAbsoluteLocalPath("Documents/logs"), false);
  assert.equal(localParentPath("/var/log", "C:/Users/alice"), "/var");
});

test("LOCAL helpers preserve Unix names and REMOTE URL encoding is unchanged", () => {
  assert.deepEqual(localBreadcrumbSegments("/var/a\\b"), [
    { label: "/", target: "/" }, { label: "var", target: "/var" }, { label: "a\\b", target: "/var/a\\b" },
  ]);
  assert.equal(downloadPath("/folder name/report#1?.txt"), "/folder%20name/report%231%3F.txt");
  assert.equal(downloadPath("//server/share/a%20b"), "//server/share/a%2520b");
});

function saveLogHarness(selectedPath, tabOverrides = {}) {
  const calls = [];
  const updates = [];
  const pending = [];
  const savedPaths = { raw: "logs/raw.log", plain: "logs/plain.log", commands: "logs/commands.log", metadata: "logs/metadata.json" };
  const { useSshTerminalActions } = loadTypeScript("features/terminal/useSshTerminalActions.ts", {
    mocks: {
      "@tauri-apps/api/core": {
        invoke: async (command, args) => {
          calls.push({ command, args });
          if (command === "pick_local_directory") return selectedPath;
          if (command === "save_ssh_logs") return savedPaths;
          throw new Error(`Unexpected command: ${command}`);
        },
      },
    },
  });
  const props = {
    tabs: [{ id: "tab", workspaceId: "workspace", sshEntryId: "entry", sessionId: "session", recording: false, recordingRawBytes: 10, recordingPlainBytes: 10, recordingStartedAt: 1, savedLogPaths: [], ...tabOverrides }],
    activeTabId: "tab",
    workspaces: [{ id: "workspace", sshEntries: [{ id: "entry", name: "Test server", host: "server" }] }],
    saveLogNameDraft: "",
    saveLogDestinationPath: "previous-folder",
    saveLogNameOpen: false,
    setTabs: (update) => { props.tabs = update(props.tabs); },
    setSaveLogNameDraft: (value) => { props.saveLogNameDraft = value; updates.push(["name", value]); },
    setSaveLogDestinationPath: (value) => { props.saveLogDestinationPath = value; updates.push(["destination", value]); },
    setSaveLogNameOpen: (value) => { props.saveLogNameOpen = value; updates.push(["open", value]); },
    run: (action) => { pending.push(action()); },
    onWriteOperationLog: () => {},
    onNotify: () => {},
    onSetNotice: (value) => { updates.push(["notice", value]); },
    describeError: String,
  };
  return { render: () => useSshTerminalActions(props), calls, updates, props, savedPaths, settle: () => Promise.all(pending) };
}

test("Save Log starts its native picker at HOME and cancellation does not open the dialog", async () => {
  const harness = saveLogHarness(null);
  harness.render().openSaveLogDialog();
  await harness.settle();
  assert.deepEqual(harness.calls, [{ command: "pick_local_directory", args: { path: "" } }]);
  assert.deepEqual(harness.updates, [["name", "Test server"]]);
  assert.equal(harness.props.saveLogDestinationPath, "previous-folder");
  assert.equal(harness.props.saveLogNameOpen, false);
});

test("Save Log accepts empty HOME and explicit destinations, then passes the selected path to save", async () => {
  for (const destination of ["", "Documents/logs", "D:/Logs", "//server/share/logs"]) {
    const harness = saveLogHarness(destination);
    harness.render().openSaveLogDialog();
    await harness.settle();
    assert.deepEqual(harness.calls[0], { command: "pick_local_directory", args: { path: "" } });
    assert.deepEqual(harness.updates, [["name", "Test server"], ["destination", destination], ["open", true]]);
    harness.render().saveSshLogs();
    await harness.settle();
    assert.equal(harness.calls.length, 2);
    assert.equal(harness.calls[1].command, "save_ssh_logs");
    assert.equal(harness.calls[1].args.destinationPath, destination);
    assert.equal(harness.calls[1].args.profileName, "Test server");
    assert.equal(harness.props.saveLogNameOpen, false);
    assert.deepEqual(harness.props.tabs[0].savedLogPaths, Object.values(harness.savedPaths));
  }
});

test("Save Log does not invoke a picker for active or empty recordings", async () => {
  for (const tab of [{ recording: true }, { recordingRawBytes: 0, recordingPlainBytes: 0 }]) {
    const harness = saveLogHarness("", tab);
    harness.render().openSaveLogDialog();
    await harness.settle();
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.updates, []);
  }
});
