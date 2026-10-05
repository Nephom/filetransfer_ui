import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript } from "./test-utils.js";

const { isSshEntryConnected } = loadTypeScript("pane/sftp-availability.ts");

const panes = (...states) => Object.fromEntries(states.map(([entryId, connected]) => [entryId, { connected }]));
const popup = (entryId, connected) => ({ entryId, connected });

test("a connected SSH pane enables SFTP for its entry only", () => {
  assert.equal(isSshEntryConnected("a", panes(["a", true]), []), true);
  assert.equal(isSshEntryConnected("b", panes(["a", true]), []), false);
  assert.equal(isSshEntryConnected("a", panes(["a", false]), []), false, "a disconnected pane does not count");
  assert.equal(isSshEntryConnected("a", { a: undefined }, []), false, "an entry whose pane reported nothing does not count");
});

test("a connected native SSH window enables SFTP for its entry", () => {
  assert.equal(isSshEntryConnected("a", {}, [popup("a", true)]), true);
  assert.equal(isSshEntryConnected("a", {}, [popup("b", true)]), false, "another entry's window does not count");
  assert.equal(isSshEntryConnected("a", {}, [popup("a", false)]), false, "an unconnected window does not count");
});

test("either source is enough, and nothing connected means not available", () => {
  assert.equal(isSshEntryConnected("a", panes(["a", false]), [popup("a", true)]), true);
  assert.equal(isSshEntryConnected("a", panes(["a", true]), [popup("a", false)]), true);
  assert.equal(isSshEntryConnected("a", {}, []), false);
});

test("a popup whose entry is not known yet (empty entryId) never enables an entry", () => {
  assert.equal(isSshEntryConnected("a", {}, [popup("", true)]), false);
  assert.equal(isSshEntryConnected("", panes(["", true]), [popup("", true)]), false);
});
