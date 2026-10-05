import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript } from "./test-utils.js";

const { isSshEntryConnected } = loadTypeScript("pane/sftp-availability.ts");

// SSH panes by window id, so one entry can appear more than once.
const panes = (...states) => Object.fromEntries(states.map(([windowId, entryId, connected]) => [windowId, { entryId, connected }]));
const popup = (entryId, connected) => ({ entryId, connected });

test("a connected SSH pane enables SFTP for its entry only", () => {
  assert.equal(isSshEntryConnected("a", panes(["ssh:a#1", "a", true]), []), true);
  assert.equal(isSshEntryConnected("b", panes(["ssh:a#1", "a", true]), []), false);
  assert.equal(isSshEntryConnected("a", panes(["ssh:a#1", "a", false]), []), false, "a disconnected pane does not count");
  assert.equal(isSshEntryConnected("a", { "ssh:a#1": undefined }, []), false, "a pane that reported nothing does not count");
});

test("an entry with several SSH panes is available while any one of them is connected", () => {
  const both = panes(["ssh:a#1", "a", true], ["ssh:a#2", "a", true]);
  assert.equal(isSshEntryConnected("a", both, []), true);
  assert.equal(isSshEntryConnected("a", panes(["ssh:a#1", "a", false], ["ssh:a#2", "a", true]), []), true, "the second pane is enough");
  assert.equal(isSshEntryConnected("a", panes(["ssh:a#1", "a", true], ["ssh:a#2", "a", false]), []), true, "a disconnected second pane does not take it away");
  assert.equal(isSshEntryConnected("a", panes(["ssh:a#1", "a", false], ["ssh:a#2", "a", false]), []), false);
  assert.equal(isSshEntryConnected("a", panes(["ssh:b#1", "b", true], ["ssh:a#1", "a", false]), []), false, "another entry's pane does not count");
});

test("a connected native SSH window enables SFTP for its entry", () => {
  assert.equal(isSshEntryConnected("a", {}, [popup("a", true)]), true);
  assert.equal(isSshEntryConnected("a", {}, [popup("b", true)]), false, "another entry's window does not count");
  assert.equal(isSshEntryConnected("a", {}, [popup("a", false)]), false, "an unconnected window does not count");
});

test("either source is enough, and nothing connected means not available", () => {
  assert.equal(isSshEntryConnected("a", panes(["ssh:a#1", "a", false]), [popup("a", true)]), true);
  assert.equal(isSshEntryConnected("a", panes(["ssh:a#1", "a", true]), [popup("a", false)]), true);
  assert.equal(isSshEntryConnected("a", {}, []), false);
});

test("a popup whose entry is not known yet (empty entryId) never enables an entry", () => {
  assert.equal(isSshEntryConnected("a", {}, [popup("", true)]), false);
  assert.equal(isSshEntryConnected("", panes(["ssh:#1", "", true]), [popup("", true)]), false);
});
