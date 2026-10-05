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
