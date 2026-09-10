import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTypeScript } from "./test-utils.js";

const require = createRequire(import.meta.url);
const { Terminal: RealTerminal } = require("@xterm/xterm");
const utils = loadTypeScript("features/terminal/terminal-utils.ts");
const ref = (current) => ({ current });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const key = (changes = {}) => ({
  type: "keydown", key: "v", code: "KeyV", ctrlKey: true, metaKey: false,
  shiftKey: false, altKey: false, isComposing: false, keyCode: 86,
  getModifierState: () => false,
  preventDefault() { this.prevented = true; },
  stopPropagation() { this.stopped = true; },
  ...changes,
});

test("recording plain transcript expands tabs and removes split VT sequences", () => {
  const parser = new utils.RecordingPlainTranscript();
  assert.equal(parser.consume("plat\tfre\u001b[1"), "plat    fre");
  assert.equal(parser.consume("P u\u001b]0;title"), " u");
  assert.equal(parser.consume("\u0007read\n"), "read\n");
});

test("recording plain transcript keeps raw recording behavior isolated", () => {
  const parser = new utils.RecordingPlainTranscript();
  assert.equal(parser.consume("one\r\ntwo\u001b[2"), "one\ntwo");
  assert.equal(parser.consume("Kthree"), "three");
  assert.equal(utils.stripAnsi("one\u001b[1Ptwo"), "onetwo");
});

// Small effect/ref runner: dependency changes clean up effects, not persistent refs.
// The hook bodies, clipboard policy, VT parser, paste API and onData are production code.
function hookRunner() {
  const slots = [];
  let index = 0, pending = [];
  return {
    react: {
      useRef(value) { return (slots[index++] ??= ref(value)); },
      useEffect(effect, deps) {
        const slot = slots[index++] ??= {};
        if (!slot.deps || deps.some((value, i) => !Object.is(value, slot.deps[i]))) {
          pending.push({ slot, effect, deps });
        }
      },
    },
    render(body) {
      index = 0;
      pending = [];
      body();
      for (const { slot } of pending) slot.cleanup?.();
      for (const { slot, effect, deps } of pending) {
        slot.deps = deps;
        slot.cleanup = effect();
      }
    },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
  };
}

class Host {
  listeners = new Map();
  addEventListener(type, callback, capture) {
    assert.equal(capture, true);
    this.listeners.set(type, callback);
  }
  removeEventListener(type, callback, capture) {
    assert.equal(capture, true);
    assert.equal(this.listeners.get(type), callback);
    this.listeners.delete(type);
  }
  fire(type, changes = {}) {
    const event = {
      button: 0,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...changes,
    };
    this.listeners.get(type)?.(event);
    return event;
  }
}

const makeTab = (id) => ({
  id, title: id, workspaceId: "workspace", sshEntryId: "profile",
  sessionId: `${id}-session`, connected: true, connecting: false, output: "",
  recording: false, recordingStartedAt: null, recordingRawBytes: 10,
  recordingPlainBytes: 10, recordingCommandCount: 0, savedLogPaths: [],
});

async function harness(t, initial = {}) {
  const hooks = hookRunner();
  const calls = [], notices = [], copies = [], reads = [], pastes = [], writes = [], actions = [];
  const instances = [];
  let selection = "", selectedTextarea, clipboard = "clipboard", picker = "";
  let bridge, connectResult = "new-session", disconnectResult;
  class Terminal extends RealTerminal {
    constructor(options) { super(options); instances.push(this); }
    open() {
      // xterm's paste API only needs a textarea to clear. All VT/input code stays real.
      this._core.textarea = { value: "" };
    }
    focus() {}
    getSelection() { return selection; }
    attachCustomKeyEventHandler(handler) { this.keyHandler = handler; }
    paste(text) { pastes.push(text); super.paste(text); }
    write(text, callback) {
      const done = deferred();
      writes.push(done.promise);
      super.write(text, () => { callback?.(); done.resolve(); });
    }
  }
  class FitAddon { activate() {} fit() {} dispose() {} }
  class WebglAddon { activate() {} onContextLoss() {} dispose() {} }
  const tabsRef = ref(initial.tabs || [makeTab("a"), makeTab("b")]);
  const terminalsRef = ref(new Map());
  const hostRefsRef = ref(new Map(tabsRef.current.map((tab) => [tab.id, new Host()])));
  const activeTabIdRef = ref("a");
  const pendingRequestsRef = ref({}), connectingRef = ref(false), recordingWriteQueuesRef = ref(new Map());
  const props = {
    enabled: true, activeTabId: "a", bracketedPasteControlEnabled: false,
    tabsRef, terminalsRef, hostRefsRef, activeTabIdRef, pendingRequestsRef, connectingRef,
    recordingWriteQueuesRef, writeQueuesRef: ref(new Map()), recordingRef: ref(false),
    outputRef: ref(""), sessionIdRef: ref(""), secretPromptRef: ref(false), shellInputRef: ref(""),
    setTabs(update) { tabsRef.current = typeof update === "function" ? update(tabsRef.current) : update; },
    setConnected() {}, setNotice(message) { notices.push(message); },
  };
  const mocks = {
    react: hooks.react,
    "./terminal-utils": utils,
    "./useSshEventBridge": { useSshEventBridge(options) { bridge = options; } },
    "@xterm/xterm": { Terminal },
    "@xterm/addon-fit": { FitAddon },
    "@xterm/addon-webgl": { WebglAddon },
    "@tauri-apps/plugin-clipboard-manager": { readText() { reads.push(true); return Promise.resolve(clipboard); } },
    "@tauri-apps/api/core": { async invoke(command, args) {
      calls.push({ command, args });
      if (command === "pick_local_directory") return picker;
      if (command === "ssh_connect") return connectResult;
      if (command === "ssh_disconnect") return disconnectResult;
      if (command === "save_ssh_logs") return { raw: "raw", plain: "plain", commands: "commands", metadata: "metadata" };
    } },
  };
  const globals = {
    window: { confirm() { throw new Error("Unsafe Continue must not be offered"); }, requestAnimationFrame(fn) { fn(); } },
    ResizeObserver: class { observe() {} disconnect() {} },
    document: {
      body: { appendChild() {} },
      createElement() { return { style: {}, setAttribute() {}, select() { selectedTextarea = this; }, remove() {} }; },
      execCommand(command) { assert.equal(command, "copy"); copies.push(selectedTextarea.value); return true; },
    },
    navigator: {},
  };
  const { useSshTerminal } = loadTypeScript("features/terminal/useSshTerminal.ts", { mocks, globals });
  const { useSshTerminalActions } = loadTypeScript("features/terminal/useSshTerminalActions.ts", { mocks, globals });
  const lifecycle = loadTypeScript("features/terminal/useTerminalLifecycle.ts", { mocks, globals });
  const actionState = { destination: "old", nameOpen: false, name: "" };
  const api = {
    props, tabsRef, terminalsRef, hostRefsRef, calls, notices, copies, reads, pastes, instances, actionState,
    get bridge() { return bridge; },
    get terminal() { return terminalsRef.current.get(props.activeTabId); },
    get sent() { return calls.filter((call) => call.command === "ssh_write"); },
    setClipboard(value) { clipboard = value; },
    setPicker(value) { picker = value; },
    setConnectResult(value) { connectResult = value; },
    setDisconnectResult(value) { disconnectResult = value; },
    setSelection(value) { selection = value; },
    lifecycle,
    render(changes = {}) {
      Object.assign(props, changes);
      props.tabIds = tabsRef.current.map((tab) => tab.id);
      activeTabIdRef.current = props.activeTabId;
      for (const id of props.tabIds) if (!hostRefsRef.current.has(id)) hostRefsRef.current.set(id, new Host());
      hooks.render(() => useSshTerminal(props));
    },
    async settle() {
      // Imports, xterm's asynchronous write parser, and the SSH promise queue.
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        await Promise.all(writes.splice(0));
        await Promise.all(props.writeQueuesRef.current.values());
      }
    },
    native(text, id = props.activeTabId) {
      return hostRefsRef.current.get(id).fire("paste", { clipboardData: text === undefined ? undefined : { getData(type) { assert.equal(type, "text/plain"); return text; } } });
    },
    rightClick(id = props.activeTabId) { return hostRefsRef.current.get(id).fire("contextmenu", { button: 2 }); },
    actions() {
      return useSshTerminalActions({
        tabs: tabsRef.current, setTabs: props.setTabs, activeTabId: props.activeTabId,
        terminalInstancesRef: terminalsRef, connectAttemptRef: api.connectAttemptRef,
        pendingRequestsRef, connectingRef, recordingWriteQueuesRef,
        workspaces: [{ id: "workspace", sshEntries: [{ id: "profile", name: "Server", host: "host", username: "user", port: 22 }] }],
        workspaceId: "workspace", selectedEntryId: "profile",
        setActiveTabId(id) { props.activeTabId = id; }, setWorkspaceId() {}, setSelectedEntryId() {},
        setSshProfileId() {}, setTerminalOpen() {}, loadSshProfileDraft() {}, onOpenWorkspaceManager() {},
        onNotify() {}, onSetNotice: props.setNotice, onWriteOperationLog() {}, describeError: String,
        run(action) { actions.push(action()); },
        saveLogNameDraft: actionState.name, setSaveLogNameDraft(value) { actionState.name = value; },
        saveLogDestinationPath: actionState.destination, setSaveLogDestinationPath(value) { actionState.destination = value; },
        saveLogNameOpen: actionState.nameOpen, setSaveLogNameOpen(value) { actionState.nameOpen = value; },
      });
    },
    connectAttemptRef: ref({}),
    async finishActions() { await Promise.all(actions.splice(0)); await api.settle(); },
    unmount() { hooks.unmount(); },
  };
  t.after(() => api.unmount());
  api.render(initial.props);
  await api.settle();
  return api;
}

test("paste shortcuts include usual variants but exclude Alt, AltGr and IME", () => {
  for (const event of [key(), key({ shiftKey: true, key: "V" }), key({ ctrlKey: false, metaKey: true }), key({ ctrlKey: false, key: "Insert", code: "Insert", shiftKey: true })]) {
    assert.equal(utils.isTerminalPasteShortcut(event), true);
  }
  for (const changes of [
    { type: "keyup" }, { altKey: true }, { isComposing: true }, { keyCode: 229 },
    { getModifierState: (name) => name === "AltGraph" }, { ctrlKey: false },
    { key: "Insert", code: "Insert", shiftKey: true },
    { ctrlKey: false, key: "Insert", code: "Insert", shiftKey: true, altKey: true },
    { key: "c", code: "KeyC" },
  ]) assert.equal(utils.isTerminalPasteShortcut(key(changes)), false, JSON.stringify(changes));
});

test("an older reset callback cannot make a newer connection boundary ready", () => {
  const callbacks = [];
  const terminal = { write(data, callback) {
    assert.equal(data, utils.SSH_SESSION_BOUNDARY_GUARD);
    callbacks.push(callback);
  } };
  utils.resetTerminalConnection(terminal);
  const first = utils.getTerminalConnectionBoundary(terminal);
  utils.resetTerminalConnection(terminal);
  const second = utils.getTerminalConnectionBoundary(terminal);
  assert.notEqual(first, second);
  callbacks[0]();
  assert.equal(first.ready, true);
  assert.equal(utils.getTerminalConnectionBoundary(terminal), second);
  assert.equal(second.ready, false);
  callbacks[1]();
  assert.equal(second.ready, true);
});

test("all paste routes preserve Python indentation and logical newlines in one xterm input", async (t) => {
  const h = await harness(t);
  h.terminal.write("\x1b[?2004h");
  await h.settle();
  const source = 'def demo():\r\n    text = "[200~ and [201~"\r\n\tprint(text)\r\n\r\n    return 1  \n';
  h.setClipboard(source);
  const right = h.rightClick();
  await h.settle();
  const keyboard = key();
  assert.equal(h.terminal.keyHandler(keyboard), false);
  await h.settle();
  const native = h.native(source);
  await h.settle();
  for (const event of [right, keyboard, native]) {
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
  }
  assert.equal(h.sent.length, 3);
  assert.deepEqual(h.pastes, Array(3).fill(source.replace(/\r\n?/g, "\n")));
  for (const { args } of h.sent) {
    assert.equal(args.sessionId, "a-session");
    assert.equal(args.data, `\x1b[200~${source.replace(/\r\n?|\n/g, "\r")}\x1b[201~`);
  }
});

test("actual keyboard handlers intercept each paste variant once and leave Alt/IME alone", async (t) => {
  const h = await harness(t);
  h.setClipboard("  single line  ");
  for (const event of [key(), key({ shiftKey: true }), key({ ctrlKey: false, metaKey: true }), key({ ctrlKey: false, key: "Insert", code: "Insert", shiftKey: true })]) {
    assert.equal(h.terminal.keyHandler(event), false);
    assert.equal(event.prevented, true);
    await h.settle();
  }
  for (const event of [key({ altKey: true }), key({ isComposing: true }), key({ keyCode: 229 }), key({ getModifierState: () => true }), key({ type: "keyup" })]) {
    assert.equal(h.terminal.keyHandler(event), true);
    assert.equal(event.prevented, undefined);
  }
  assert.equal(h.reads.length, 4);
  assert.equal(h.sent.length, 4);
  assert.ok(h.sent.every(({ args }) => args.data === "  single line  "));
});

test("unprotected line breaks and tabs send zero bytes through every route, without Continue", async (t) => {
  const h = await harness(t);
  for (const text of ["a\nb", "a\rb", "a\r\nb", "a\n", "a\r", "a\r\n", "a\tb", "\t", "\n"]) {
    h.setClipboard(text);
    h.native(text);
    h.rightClick();
    h.terminal.keyHandler(key());
    await h.settle();
  }
  assert.equal(h.sent.length, 0);
  assert.equal(h.pastes.length, 0);
  assert.equal(h.notices.length, 27);
  h.native("  echo safe  ");
  await h.settle();
  assert.equal(h.sent[0].args.data, "  echo safe  ");
  h.terminal.write("\x1b[?2004h");
  await h.settle();
  h.terminal.options.ignoreBracketedPasteMode = true;
  h.native("a\nb");
  await h.settle();
  assert.equal(h.sent.length, 1);
});

test("controls and embedded delimiters cannot break protection with either setting", async (t) => {
  const h = await harness(t);
  h.terminal.write("\x1b[?2004h");
  await h.settle();
  for (const checked of [false, true]) {
    h.render({ bracketedPasteControlEnabled: checked });
    for (const code of [...Array(32).keys(), ...Array.from({ length: 33 }, (_, i) => i + 127)]) {
      if ([9, 10, 13].includes(code)) continue;
      h.native(`before${String.fromCharCode(code)}after`);
    }
    h.native("a\x1b[20\x1b[200~1~b");
  }
  await h.settle();
  assert.equal(h.sent.length, 0);
  h.render({ bracketedPasteControlEnabled: false });
  h.native("ok\x1b[201~\nevil\x1b[200~");
  h.native("ok\x9b201~\nevil\x9b200~");
  await h.settle();
  assert.equal(h.sent.length, 0);
  h.render({ bracketedPasteControlEnabled: true });
  h.native("ok\x1b[201~\nevil\x9b200~");
  await h.settle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].args.data, "\x1b[200~ok\revil\x1b[201~");
});

test("checked sanitation removes only outer visible markers and real controls, not source literals", async (t) => {
  const h = await harness(t);
  const source = 'def f():\n    return "[200~ ^[[201~ \\x1b[201~"\n';
  const normalize = h.lifecycle.normalizeTerminalPaste;
  for (const prefix of ["", "^[", "\\x1b", "\\u001b", "\\033", "\\e"]) {
    assert.equal(normalize(`${prefix}[200~${source}${prefix}[201~`, true), source);
  }
  assert.equal(normalize(`\x1b[200~${source}\x1b[201~`, true), source);
  assert.equal(normalize(`[200~${source}[201~`, false), `[200~${source}[201~`);
  assert.equal(normalize(source, true), source);
  assert.equal(normalize("  [200~abc[201~  ", true), "  abc  ");
  assert.equal(normalize("[200~[200~abc[201~[201~", true), "abc");
});

test("surviving handlers work after collapse, create, delete and reorder", async (t) => {
  const h = await harness(t);
  const original = h.terminal;
  h.render({ enabled: false });
  h.native("hidden");
  h.rightClick();
  h.render({ enabled: true });
  h.native("reopened");
  h.tabsRef.current.push(makeTab("c"));
  h.render();
  await h.settle();
  h.native("created");
  h.tabsRef.current.reverse();
  h.render();
  h.native("reordered");
  h.tabsRef.current = h.tabsRef.current.filter((tab) => tab.id !== "c");
  h.render();
  h.setClipboard("deleted");
  h.rightClick();
  await h.settle();
  assert.equal(h.terminal, original);
  assert.deepEqual(h.sent.map(({ args }) => args.data), ["reopened", "created", "reordered", "deleted"]);
  assert.equal(h.hostRefsRef.current.get("c").listeners.size, 0);
  assert.equal(h.instances.length, 3);
});

test("stale reads are cancelled after context changes, without poisoning later pastes", async (t) => {
  const h = await harness(t);
  for (const transition of [
    () => { h.render({ activeTabId: "b" }); h.render({ activeTabId: "a" }); },
    () => { h.render({ enabled: false }); h.render({ enabled: true }); },
    () => {
      h.tabsRef.current[0].sessionId = "new-session";
      h.render();
      h.tabsRef.current[0].sessionId = "a-session";
      h.render();
    },
    () => { utils.resetTerminalConnection(h.terminal); },
  ]) {
    const pending = deferred();
    h.setClipboard(pending.promise);
    h.rightClick();
    transition();
    pending.resolve("stale");
    await h.settle();
    assert.equal(h.sent.some(({ args }) => args.data === "stale"), false);
    h.setClipboard("fresh");
    h.terminal.keyHandler(key());
    await h.settle();
  }
  assert.equal(h.sent.length, 4);
  const late = deferred();
  h.setClipboard(late.promise);
  h.rightClick();
  h.render({ enabled: false });
  late.reject(new Error("denied"));
  await h.settle();
  assert.equal(h.notices.length, 0);
  h.render({ enabled: true });
  h.setClipboard(Promise.reject(new Error("denied")));
  h.rightClick();
  await h.settle();
  assert.match(h.notices[0], /Unable to read/);
});

test("clipboard reads cannot follow a closed tab or an unmounted instance", async (t) => {
  const h = await harness(t);
  const pending = deferred();
  h.setClipboard(pending.promise);
  h.rightClick();
  h.tabsRef.current = [makeTab("b")];
  h.render({ activeTabId: "b" });
  pending.resolve("closed");
  await h.settle();
  assert.equal(h.sent.length, 0);
  const late = deferred();
  h.setClipboard(late.promise);
  h.rightClick();
  h.unmount();
  late.resolve("unmounted");
  await h.settle();
  assert.equal(h.sent.length, 0);
});

test("live session state blocks disconnected, connecting and inactive native input", async (t) => {
  const h = await harness(t);
  h.native("inactive", "b");
  h.tabsRef.current[0].connected = false;
  h.native("disconnected");
  h.rightClick();
  h.tabsRef.current[0].connected = true;
  h.tabsRef.current[0].connecting = true;
  h.native("connecting");
  h.tabsRef.current[0].connecting = false;
  const event = h.native(undefined);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  await h.settle();
  assert.equal(h.sent.length, 0);
  assert.equal(h.reads.length, 0);
  h.native("connected");
  await h.settle();
  assert.equal(h.sent[0].args.data, "connected");
});

test("left-button selection-copy and OSC52 set remain intact; OSC52 query never reads", async (t) => {
  const h = await harness(t);
  const host = h.hostRefsRef.current.get("a");
  h.setSelection("old");
  host.fire("mousedown");
  h.setSelection("  new selection\n\ttext");
  host.fire("mouseup");
  assert.deepEqual(h.copies, ["  new selection\n\ttext"]);
  host.fire("mousedown");
  host.fire("mouseup");
  host.fire("mousedown", { button: 2 });
  h.setSelection("not a left selection");
  host.fire("mouseup", { button: 2 });
  assert.equal(h.copies.length, 1);
  const text = "remote selection \u4e2d\u6587";
  h.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  h.terminal.write("\x1b]52;c;?\x07\x1b]52;c;%%%\x07");
  await h.settle();
  assert.deepEqual(h.copies, ["  new selection\n\ttext", text]);
  assert.equal(h.reads.length, 0);
  assert.equal(h.sent.length, 0);
});

test("real xterm replay retains DEC 2004; only connection boundaries reset it", async (t) => {
  const a = { ...makeTab("a"), output: "prompt\x1b[?2004h" };
  const h = await harness(t, { tabs: [a, makeTab("b")] });
  assert.equal(h.terminal.modes.bracketedPasteMode, true);
  h.render({ enabled: false });
  h.render({ enabled: true });
  h.render({ activeTabId: "b" });
  h.render({ activeTabId: "a" });
  assert.equal(h.terminal.modes.bracketedPasteMode, true);
  const pending = deferred();
  h.setClipboard(pending.promise);
  h.rightClick();
  h.bridge.onExit("a", { sessionId: "a-session", data: "exit" });
  pending.resolve("stale exit");
  await h.settle();
  assert.equal(h.terminal.modes.bracketedPasteMode, false);
  assert.ok(h.tabsRef.current[0].output.includes(utils.SSH_SESSION_BOUNDARY_GUARD));
  assert.equal(h.sent.length, 0);
  h.terminal.write("\x1b[?2004h");
  await h.settle();
  const connect = deferred();
  h.setConnectResult(connect.promise);
  h.actions().performSshConnect("a", { id: "profile", username: "user", host: "host", port: 22 });
  // Pending reset must block paste even before the async parser sees DEC 2004 off.
  assert.equal(utils.getTerminalConnectionBoundary(h.terminal).ready, false);
  h.native("no race\n");
  await h.settle();
  assert.equal(h.terminal.modes.bracketedPasteMode, false);
  // Login output can enable the mode before ssh_connect resolves. Do not reset on success.
  h.bridge.onOutput("a", { sessionId: "new-session", data: "\x1b[?2004h" });
  connect.resolve("new-session");
  await h.finishActions();
  assert.equal(h.terminal.modes.bracketedPasteMode, true);
  h.native("  fresh\n\tcode");
  await h.settle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].args.sessionId, "new-session");
  assert.equal(h.sent[0].args.data, "\x1b[200~  fresh\r\tcode\x1b[201~");
  h.actions().disconnectSsh();
  await h.finishActions();
  assert.equal(h.terminal.modes.bracketedPasteMode, false);
});

test("connect start and failure invalidate pending reads; a later connection can paste", async (t) => {
  const h = await harness(t);
  const clipboard = deferred(), connect = deferred();
  h.setClipboard(clipboard.promise);
  h.rightClick();
  h.setConnectResult(connect.promise);
  const profile = { id: "profile", username: "user", host: "host", port: 22 };
  h.actions().performSshConnect("a", profile);
  clipboard.resolve("stale reconnect");
  h.terminal.write("\x1b[?2004h");
  await h.settle();
  connect.reject(new Error("connect failed"));
  await h.finishActions();
  assert.equal(h.sent.length, 0);
  assert.equal(h.terminal.modes.bracketedPasteMode, false);
  assert.match(h.tabsRef.current[0].output, /connect failed/);
  h.setConnectResult("later-session");
  h.actions().performSshConnect("a", profile);
  await h.finishActions();
  h.setClipboard("fresh reconnect");
  h.rightClick();
  await h.settle();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].args, { sessionId: "later-session", data: "fresh reconnect" });
});

test("disconnect failure cancels stale reads, but does not claim the live session ended", async (t) => {
  const h = await harness(t);
  const clipboard = deferred(), disconnect = deferred();
  h.terminal.write("\x1b[?2004h");
  await h.settle();
  h.setClipboard(clipboard.promise);
  h.rightClick();
  h.setDisconnectResult(disconnect.promise);
  h.actions().disconnectSsh();
  clipboard.resolve("stale disconnect");
  const finished = assert.rejects(() => h.finishActions(), /disconnect failed/);
  disconnect.reject(new Error("disconnect failed"));
  await finished;
  await h.settle();
  assert.equal(h.terminal.modes.bracketedPasteMode, false);
  assert.equal(h.sent.length, 0);
  assert.equal(h.tabsRef.current[0].connected, true);
  h.native("still connected");
  await h.settle();
  assert.equal(h.sent[0].args.data, "still connected");
});

test("Save Log picker always starts at HOME; empty HOME selection is not cancellation", async (t) => {
  const h = await harness(t);
  for (const selected of [null, "", "logs", ""]) {
    h.actionState.nameOpen = false;
    h.setPicker(selected);
    h.actions().openSaveLogDialog();
    await h.finishActions();
    assert.deepEqual(h.calls.filter(({ command }) => command === "pick_local_directory").at(-1).args, { path: "" });
    assert.equal(h.actionState.nameOpen, selected !== null);
    if (selected !== null) assert.equal(h.actionState.destination, selected);
  }
  h.actions().saveSshLogs();
  await h.finishActions();
  assert.equal(h.calls.find(({ command }) => command === "save_ssh_logs").args.destinationPath, "");
  assert.equal(h.actionState.nameOpen, false);
  assert.deepEqual(h.tabsRef.current[0].savedLogPaths, ["raw", "plain", "commands", "metadata"]);
});
