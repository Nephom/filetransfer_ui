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

// Small state/effect/ref runner: dependency changes clean up effects, not persistent refs.
// The hook bodies, clipboard policy, VT parser, paste API and onData are production code.
function hookRunner() {
  const slots = [];
  let index = 0, pending = [];
  return {
    react: {
      useRef(value) { return (slots[index++] ??= ref(value)); },
      useState(initial) {
        const slot = slots[index++] ??= { value: typeof initial === "function" ? initial() : initial };
        return [slot.value, (update) => { slot.value = typeof update === "function" ? update(slot.value) : update; }];
      },
      useCallback(fn) { slots[index++] ??= {}; return fn; },
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
      const result = body();
      for (const { slot } of pending) slot.cleanup?.();
      for (const { slot, effect, deps } of pending) {
        slot.deps = deps;
        slot.cleanup = effect();
      }
      return result;
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
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

const PROFILE = { id: "profile", name: "Server", host: "host", port: 22, username: "user" };

// Drives the production useSshEntryTerminal hook (the terminal of one SSH entry, shared by the
// native window and the SSH pane) with the real useTerminalLifecycle and a real xterm.js Terminal.
// Only Tauri commands/events and the browser shell are replaced.
async function harness(t, { connect = "a-session", onStateChange, onOperationLog } = {}) {
  const hooks = hookRunner();
  const calls = [], notices = [], copies = [], reads = [], pastes = [], writes = [], states = [], logs = [];
  const instances = [], focused = [];
  const fitCalls = [];
  let selection = "", selectedTextarea, clipboard = "clipboard", picker = "";
  const documentListeners = new Map();
  const windowListeners = new Map();
  let bridge, connectResult = connect, disconnectResult;
  class Terminal extends RealTerminal {
    constructor(options) { super(options); instances.push(this); }
    open() {
      // xterm's paste API only needs a textarea to clear. All VT/input code stays real.
      this._core.textarea = { value: "" };
    }
    focus() { focused.push(this); }
    getSelection() { return selection; }
    attachCustomKeyEventHandler(handler) { this.keyHandler = handler; }
    paste(text) { pastes.push(text); super.paste(text); }
    write(text, callback) {
      const done = deferred();
      writes.push(done.promise);
      super.write(text, () => { callback?.(); done.resolve(); });
    }
  }
  class FitAddon { activate() {} fit() { fitCalls.push(true); } dispose() {} }
  class WebglAddon { activate() {} onContextLoss() {} dispose() {} }
  const host = new Host();
  const props = {
    profile: PROFILE, title: "Server", source: "SSH test", autoConnect: true, bracketedPasteControlEnabled: false,
    onStateChange(state) { states.push(state); onStateChange?.(state); },
    onOperationLog(...args) { logs.push(args); onOperationLog?.(...args); },
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
      if (command === "start_ssh_recording") return { rawBytes: 20, plainBytes: 18, commandCount: 0 };
      if (command === "append_ssh_recording") return { rawBytes: 40, plainBytes: 36, commandCount: 0 };
      if (command === "append_ssh_recording_command") return { rawBytes: 40, plainBytes: 36, commandCount: 1 };
    } },
  };
  const globals = {
    window: {
      confirm() { throw new Error("Unsafe Continue must not be offered"); },
      requestAnimationFrame(fn) { fn(); return 1; },
      cancelAnimationFrame() {},
      addEventListener(type, callback) { windowListeners.set(type, callback); },
      removeEventListener(type, callback) { if (windowListeners.get(type) === callback) windowListeners.delete(type); },
    },
    ResizeObserver: class { observe() {} disconnect() {} },
    document: {
      body: { appendChild() {} },
      createElement() { return { style: {}, setAttribute() {}, select() { selectedTextarea = this; }, remove() {} }; },
      execCommand(command) { assert.equal(command, "copy"); copies.push(selectedTextarea.value); return true; },
      addEventListener(type, callback, capture) { assert.equal(capture, true); documentListeners.set(type, callback); },
      removeEventListener(type, callback, capture) { assert.equal(capture, true); if (documentListeners.get(type) === callback) documentListeners.delete(type); },
    },
    navigator: {},
  };
  const { useSshEntryTerminal } = loadTypeScript("features/terminal/useSshEntryTerminal.ts", { mocks, globals });
  const lifecycle = loadTypeScript("features/terminal/useTerminalLifecycle.ts", { mocks, globals });
  let controller;
  const api = {
    props, host, calls, notices, copies, reads, pastes, writes, instances, focused, fitCalls, states, logs, lifecycle,
    get bridge() { return bridge; },
    get ctl() { return controller; },
    get terminal() { return instances[0]; },
    get sent() { return calls.filter((call) => call.command === "ssh_write"); },
    requestId(n = -1) { return calls.filter((call) => call.command === "ssh_connect").at(n).args.requestId; },
    setClipboard(value) { clipboard = value; },
    setPicker(value) { picker = value; },
    setConnectResult(value) { connectResult = value; },
    setDisconnectResult(value) { disconnectResult = value; },
    setSelection(value) { selection = value; },
    screen() {
      const buffer = this.terminal.buffer.active;
      return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "").join("\n");
    },
    render(changes = {}) {
      Object.assign(props, changes);
      controller = hooks.render(() => useSshEntryTerminal(props));
      return controller;
    },
    detachHost() { controller.setHost(null); api.render(); },
    attachHost() { controller.setHost(host); api.render(); },
    async settle() {
      // Imports, xterm's asynchronous write parser, and the SSH promise queue.
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        await Promise.all(writes.splice(0));
      }
      api.render();
    },
    native(text) {
      return host.fire("paste", { clipboardData: text === undefined ? undefined : { getData(type) { assert.equal(type, "text/plain"); return text; } } });
    },
    documentMouseup(changes = {}) {
      const event = { button: 0, ...changes };
      documentListeners.get("mouseup")?.(event);
      return event;
    },
    windowEvent(type, changes = {}) {
      const event = { ...changes };
      windowListeners.get(type)?.(event);
      return event;
    },
    rightClick() { return host.fire("contextmenu", { button: 2 }); },
    unmount() { hooks.unmount(); },
  };
  t.after(() => api.unmount());
  api.render();            // mounts: the entry connects on its own
  api.attachHost();        // the xterm host is mounted
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

test("an SSH entry connects on its own and reports the connection to its owner", async (t) => {
  const h = await harness(t);
  const connectCalls = h.calls.filter((call) => call.command === "ssh_connect");
  assert.equal(connectCalls.length, 1);
  assert.deepEqual(connectCalls[0].args.profile, { id: "profile", name: "Server", host: "host", port: 22, username: "user", privateKeyPath: null });
  assert.equal(h.ctl.connected, true);
  assert.equal(h.ctl.connecting, false);
  assert.equal(h.ctl.status, "Connected");
  assert.deepEqual(h.states.at(0), { connected: false, connecting: false, recordingUnsaved: false }, "starts before the connection exists");
  assert.ok(h.states.some((state) => state.connecting && !state.connected), "reports the connecting phase");
  assert.deepEqual(h.states.at(-1), { connected: true, connecting: false, recordingUnsaved: false });
  assert.ok(h.calls.some((call) => call.command === "ssh_resize" && call.args.sessionId === "a-session"), "the known xterm size is handed to the remote PTY once the session exists");
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
  assert.match(h.ctl.status, /Paste blocked/, "the user is told why nothing was pasted");
  assert.equal(h.ctl.connected, true, "a blocked paste does not end the session");
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

test("the xterm instance and its handlers survive the host being detached and mounted again", async (t) => {
  const h = await harness(t);
  const original = h.terminal;
  h.detachHost();
  h.native("hidden");
  h.rightClick();
  h.attachHost();
  h.native("reopened");
  await h.settle();
  h.setClipboard("again");
  h.rightClick();
  await h.settle();
  assert.equal(h.terminal, original);
  assert.deepEqual(h.sent.map(({ args }) => args.data), ["reopened", "again"]);
  assert.equal(h.instances.length, 1, "no second xterm is created for the same entry");
});

test("focusing the entry terminal focuses its xterm instance", async (t) => {
  const h = await harness(t);
  h.ctl.focus();
  assert.equal(h.focused.at(-1), h.terminal);
});

test("stale reads are cancelled after context changes, without poisoning later pastes", async (t) => {
  const h = await harness(t);
  for (const transition of [
    async () => { h.detachHost(); h.attachHost(); },
    async () => { utils.resetTerminalConnection(h.terminal); },
    async () => {
      await h.ctl.disconnect();
      h.setConnectResult("a-session");
      h.ctl.connect();
      await h.settle();
    },
  ]) {
    const pending = deferred();
    h.setClipboard(pending.promise);
    h.rightClick();
    await transition();
    pending.resolve("stale");
    await h.settle();
    assert.equal(h.sent.some(({ args }) => args.data === "stale"), false);
    h.setClipboard("fresh");
    h.terminal.keyHandler(key());
    await h.settle();
  }
  assert.equal(h.sent.length, 3);
  const late = deferred();
  h.setClipboard(late.promise);
  h.rightClick();
  h.detachHost();
  late.reject(new Error("denied"));
  await h.settle();
  assert.equal(h.ctl.status.includes("Unable to read"), false);
  h.attachHost();
  h.setClipboard(Promise.reject(new Error("denied")));
  h.rightClick();
  await h.settle();
  assert.match(h.ctl.status, /Unable to read/);
});

test("clipboard reads cannot follow a closed window or an unmounted instance", async (t) => {
  const h = await harness(t);
  const pending = deferred();
  h.setClipboard(pending.promise);
  h.rightClick();
  await h.ctl.dispose();
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

test("live session state blocks connecting and disconnected native input", async (t) => {
  const connect = deferred();
  const h = await harness(t, { connect: connect.promise });
  assert.equal(h.ctl.connecting, true);
  assert.equal(h.ctl.status, "Connecting…");
  h.native("connecting");
  h.rightClick();
  await h.settle();
  assert.equal(h.sent.length, 0);
  assert.equal(h.reads.length, 0);
  connect.resolve("a-session");
  await h.settle();
  const event = h.native(undefined);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  await h.settle();
  assert.equal(h.sent.length, 0);
  assert.equal(h.reads.length, 0);
  h.native("connected");
  await h.settle();
  assert.equal(h.sent[0].args.data, "connected");
  await h.ctl.disconnect();
  await h.settle();
  h.native("disconnected");
  h.rightClick();
  await h.settle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.reads.length, 0);
});

test("left-button selection-copy and OSC52 set remain intact; OSC52 query never reads", async (t) => {
  const h = await harness(t);
  h.setSelection("old");
  h.host.fire("mousedown");
  h.host.fire("mouseup");
  // The host capture listener runs before xterm's document mouseup handler.
  // Update the fake selection after the host event to model xterm finishing
  // its selection before the deferred clipboard read.
  h.setSelection("  new selection\n\ttext");
  await h.settle();
  assert.deepEqual(h.copies, ["  new selection\n\ttext"]);
  h.host.fire("mousedown");
  h.host.fire("mouseup");
  await h.settle();
  h.host.fire("mousedown", { button: 2 });
  h.setSelection("not a left selection");
  h.host.fire("mouseup", { button: 2 });
  await h.settle();
  assert.equal(h.copies.length, 1);
  const text = "remote selection \u4e2d\u6587";
  h.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  h.terminal.write("\x1b]52;c;?\x07\x1b]52;c;%%%\x07");
  await h.settle();
  assert.deepEqual(h.copies, ["  new selection\n\ttext", text]);
  assert.equal(h.reads.length, 0);
  assert.equal(h.sent.length, 0);
});

test("selection-copy finishes when the pointer is released outside the terminal host", async (t) => {
  const h = await harness(t);
  h.setSelection("old");
  h.host.fire("mousedown");
  h.documentMouseup();
  h.setSelection("  multiple lines\nsecond line");
  await h.settle();
  assert.deepEqual(h.copies, ["  multiple lines\nsecond line"]);

  // A non-left button must never finish a left-button selection session.
  h.host.fire("mousedown", { button: 2 });
  h.setSelection("right click selection");
  h.documentMouseup({ button: 2 });
  await h.settle();
  assert.deepEqual(h.copies, ["  multiple lines\nsecond line"]);

  h.host.fire("mousedown");
  h.host.fire("mousedown", { button: 1 });
  h.setSelection("middle click selection");
  h.documentMouseup();
  await h.settle();
  assert.deepEqual(h.copies, ["  multiple lines\nsecond line"]);
});

test("native window resize re-fits xterm and reports the new PTY size", async (t) => {
  const h = await harness(t);
  const fitCallsBefore = h.fitCalls.length;
  const resizeCallsBefore = h.calls.filter(({ command }) => command === "ssh_resize").length;
  h.terminal.resize(h.terminal.cols + 1, h.terminal.rows + 1);

  h.windowEvent("resize");

  assert.ok(h.fitCalls.length > fitCallsBefore);
  const resizes = h.calls.filter(({ command }) => command === "ssh_resize");
  assert.ok(resizes.length > resizeCallsBefore);
  assert.deepEqual(
    { sessionId: resizes.at(-1).args.sessionId, source: resizes.at(-1).args.source, cols: resizes.at(-1).args.cols, rows: resizes.at(-1).args.rows },
    { sessionId: "a-session", source: "SSH test", cols: h.terminal.cols, rows: h.terminal.rows },
  );
  // An unchanged size is not sent to the remote PTY again.
  const before = h.calls.filter(({ command }) => command === "ssh_resize").length;
  h.windowEvent("resize");
  assert.equal(h.calls.filter(({ command }) => command === "ssh_resize").length, before);
});

test("selection-copy is cancelled by window blur or pointer cancellation", async (t) => {
  for (const cancelEvent of ["blur", "pointercancel"]) {
    const h = await harness(t);
    h.setSelection("old");
    h.host.fire("mousedown");
    h.windowEvent(cancelEvent);
    h.documentMouseup();
    h.setSelection("cancelled selection");
    await h.settle();
    assert.equal(h.copies.length, 0, cancelEvent);
  }
});

test("real xterm keeps DEC 2004 while the host is detached; only connection boundaries reset it", async (t) => {
  const h = await harness(t);
  h.bridge.onOutput("x", { sessionId: "a-session", requestId: h.requestId(), data: "prompt\x1b[?2004h" });
  await h.settle();
  assert.equal(h.terminal.modes.bracketedPasteMode, true);
  h.detachHost();
  h.attachHost();
  assert.equal(h.terminal.modes.bracketedPasteMode, true);
  const pending = deferred();
  h.setClipboard(pending.promise);
  h.rightClick();
  h.bridge.onExit("x", { sessionId: "a-session", requestId: h.requestId(), data: "exit" });
  pending.resolve("stale exit");
  await h.settle();
  assert.equal(h.terminal.modes.bracketedPasteMode, false);
  assert.equal(h.ctl.connected, false, "the remote exit ends the session");
  assert.equal(h.ctl.status, "exit");
  assert.equal(h.sent.length, 0);
  h.terminal.write("\x1b[?2004h");
  await h.settle();
  const connect = deferred();
  h.setConnectResult(connect.promise);
  h.ctl.connect();
  // Pending reset must block paste even before the async parser sees DEC 2004 off.
  assert.equal(utils.getTerminalConnectionBoundary(h.terminal).ready, false);
  h.native("no race\n");
  await h.settle();
  assert.equal(h.terminal.modes.bracketedPasteMode, false);
  // Login output can enable the mode before ssh_connect resolves. Do not reset on success.
  h.bridge.onOutput("x", { sessionId: "new-session", requestId: h.requestId(), data: "\x1b[?2004h" });
  connect.resolve("new-session");
  await h.settle();
  assert.equal(h.terminal.modes.bracketedPasteMode, true);
  h.native("  fresh\n\tcode");
  await h.settle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].args.sessionId, "new-session");
  assert.equal(h.sent[0].args.data, "\x1b[200~  fresh\r\tcode\x1b[201~");
  await h.ctl.disconnect();
  await h.settle();
  assert.equal(h.terminal.modes.bracketedPasteMode, false);
});

test("connect start and failure invalidate pending reads; a later connection can paste", async (t) => {
  const h = await harness(t);
  await h.ctl.disconnect();
  await h.settle();
  const clipboard = deferred(), connect = deferred();
  h.setClipboard(clipboard.promise);
  h.rightClick();
  h.setConnectResult(connect.promise);
  h.ctl.connect();
  clipboard.resolve("stale reconnect");
  h.terminal.write("\x1b[?2004h");
  await h.settle();
  connect.reject(new Error("connect failed"));
  await h.settle();
  assert.equal(h.sent.length, 0);
  assert.equal(h.terminal.modes.bracketedPasteMode, false);
  assert.equal(h.ctl.connected, false);
  assert.equal(h.ctl.connecting, false);
  assert.match(h.ctl.status, /connect failed/);
  assert.match(h.screen(), /connect failed/, "the reason is shown in the terminal as well");
  h.setConnectResult("later-session");
  h.ctl.connect();
  await h.settle();
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
  const finished = h.ctl.disconnect();
  clipboard.resolve("stale disconnect");
  disconnect.reject(new Error("disconnect failed"));
  await finished;
  await h.settle();
  assert.equal(h.terminal.modes.bracketedPasteMode, false);
  assert.equal(h.sent.length, 0);
  assert.equal(h.ctl.connected, true);
  assert.match(h.ctl.status, /disconnect failed/);
  h.native("still connected");
  await h.settle();
  assert.equal(h.sent[0].args.data, "still connected");
});

test("after the session ends the same window can connect again in the same terminal", async (t) => {
  const h = await harness(t);
  h.bridge.onOutput("x", { sessionId: "a-session", requestId: h.requestId(), data: "first session\r\n" });
  await h.settle();
  h.bridge.onExit("x", { sessionId: "a-session", requestId: h.requestId(), data: "Connection closed." });
  await h.settle();
  assert.equal(h.ctl.connected, false);
  assert.equal(h.ctl.status, "Connection closed.");
  assert.deepEqual(h.states.at(-1), { connected: false, connecting: false, recordingUnsaved: false });
  assert.match(h.screen(), /first session/, "the old output stays visible");
  h.setConnectResult("second-session");
  h.ctl.connect();
  await h.settle();
  assert.equal(h.calls.filter((call) => call.command === "ssh_connect").length, 2);
  assert.equal(h.requestId(0) === h.requestId(1), false, "every Connect uses its own request id");
  assert.equal(h.ctl.connected, true);
  assert.equal(h.ctl.status, "Connected");
  assert.equal(h.instances.length, 1, "the xterm is reused");
  assert.match(h.screen(), /first session/);
  assert.match(h.screen(), /Connecting to user@host:22/);
  h.native("second");
  await h.settle();
  assert.deepEqual(h.sent.at(-1).args, { sessionId: "second-session", data: "second" });
});

test("Connect while already connected or connecting starts nothing new", async (t) => {
  const connect = deferred();
  const h = await harness(t, { connect: connect.promise });
  h.ctl.connect();
  h.ctl.connect();
  assert.equal(h.calls.filter((call) => call.command === "ssh_connect").length, 1);
  connect.resolve("a-session");
  await h.settle();
  h.ctl.connect();
  await h.settle();
  assert.equal(h.calls.filter((call) => call.command === "ssh_connect").length, 1);
});

test("a cancelled connection attempt is ignored and a late session is closed", async (t) => {
  const connect = deferred();
  const h = await harness(t, { connect: connect.promise });
  h.ctl.cancelConnect();
  await h.settle();
  assert.equal(h.ctl.connecting, false);
  assert.match(h.ctl.status, /cancelled/);
  connect.resolve("late-session");
  await h.settle();
  assert.equal(h.ctl.connected, false, "a late success does not revive the cancelled attempt");
  assert.deepEqual(h.calls.find((call) => call.command === "ssh_disconnect").args, { sessionId: "late-session" });
  h.bridge.onOutput("x", { sessionId: "late-session", requestId: h.requestId(), data: "should not appear" });
  await h.settle();
  assert.doesNotMatch(h.screen(), /should not appear/);
});

test("output of another or an older session never reaches the terminal", async (t) => {
  const h = await harness(t);
  h.bridge.onOutput("x", { sessionId: "other-session", requestId: "other-request", data: "intruder" });
  h.bridge.onOutput("x", { sessionId: "a-session", requestId: h.requestId(), data: "mine" });
  await h.settle();
  assert.doesNotMatch(h.screen(), /intruder/);
  assert.match(h.screen(), /mine/);
  const firstRequest = h.requestId();
  await h.ctl.disconnect();
  h.setConnectResult("b-session");
  h.ctl.connect();
  await h.settle();
  h.bridge.onOutput("x", { sessionId: "a-session", requestId: firstRequest, data: "late output of the old session" });
  await h.settle();
  assert.doesNotMatch(h.screen(), /late output of the old session/);
});

test("recording output is appended through the disk-backed recording command", async (t) => {
  const h = await harness(t);
  await h.ctl.startRecording();
  await h.settle();
  assert.equal(h.ctl.recording, true);
  assert.equal(h.ctl.status, "Recording");
  const started = h.calls.find(({ command }) => command === "start_ssh_recording");
  h.bridge.onOutput("x", { sessionId: "a-session", requestId: h.requestId(), data: "recorded output" });
  await h.settle();
  const recordingCall = h.calls.find(({ command }) => command === "append_ssh_recording");
  assert.ok(recordingCall);
  assert.equal(recordingCall.args.tabId, started.args.tabId);
  assert.equal(recordingCall.args.rawChunk, "recorded output");
  assert.equal(recordingCall.args.plainChunk, "recorded output");
  assert.ok(h.logs.some(([operation, status]) => operation === "ssh_recording" && status === "started"));
});

test("Record needs a live session, and typed commands are recorded without secrets", async (t) => {
  const h = await harness(t);
  await h.ctl.disconnect();
  await h.settle();
  await h.ctl.startRecording();
  assert.equal(h.calls.some(({ command }) => command === "start_ssh_recording"), false, "no session, no recording");
  h.setConnectResult("again");
  h.ctl.connect();
  await h.settle();
  await h.ctl.startRecording();
  await h.settle();
  // Typed input arrives key by key through xterm's onData, like real typing.
  const type = (...keys) => { for (const typed of keys) h.terminal._core.coreService.triggerDataEvent(typed, true); };
  type("l", "s", "\r");
  await h.settle();
  const command = h.calls.find(({ command: name }) => name === "append_ssh_recording_command");
  assert.ok(command);
  assert.match(command.args.line, /^\[\d{4}-.*\] ls\n$/);
  h.bridge.onOutput("x", { sessionId: "again", requestId: h.requestId(), data: "Password: " });
  type("h", "u", "n", "t", "e", "r", "2", "\r");
  await h.settle();
  assert.equal(h.calls.filter(({ command: name }) => name === "append_ssh_recording_command").length, 1, "text typed at a password prompt is not recorded");
  assert.deepEqual(h.sent.map(({ args }) => args.data).slice(0, 3), ["l", "s", "\r"], "everything typed still reaches the session");
});

test("a session that ends while recording keeps the recording so it can still be saved", async (t) => {
  const h = await harness(t);
  await h.ctl.startRecording();
  await h.settle();
  h.bridge.onExit("x", { sessionId: "a-session", requestId: h.requestId(), data: "gone" });
  await h.settle();
  assert.equal(h.ctl.connected, false);
  assert.equal(h.ctl.recording, false, "the recording is stopped");
  assert.ok(h.calls.some(({ command }) => command === "stop_ssh_recording"));
  assert.equal(h.calls.some(({ command }) => command === "discard_ssh_recording"), false, "but not discarded");
  assert.equal(h.ctl.hasRecordedOutput, true);
  assert.equal(h.ctl.hasUnsavedRecording(), true);
  assert.equal(h.states.at(-1).recordingUnsaved, true, "the owner is told an unsaved recording exists");
  h.setPicker("logs");
  await h.ctl.openSaveLogDialog();
  await h.settle();
  assert.equal(h.ctl.saveLogDialog.open, true);
});

test("Save Log picker always starts at HOME; empty HOME selection is not cancellation", async (t) => {
  const h = await harness(t);
  await h.ctl.startRecording();
  await h.ctl.stopRecording();
  await h.settle();
  assert.equal(h.ctl.recording, false);
  for (const selected of [null, "", "logs", ""]) {
    h.ctl.saveLogDialog.close();
    await h.settle();
    h.setPicker(selected);
    await h.ctl.openSaveLogDialog();
    await h.settle();
    assert.deepEqual(h.calls.filter(({ command }) => command === "pick_local_directory").at(-1).args, { path: "" });
    assert.equal(h.ctl.saveLogDialog.open, selected !== null);
    if (selected !== null) assert.equal(h.ctl.saveLogDialog.destination, selected);
  }
  assert.equal(h.ctl.saveLogDialog.name, "Server");
  h.ctl.saveLogDialog.setName("My log");
  await h.settle();
  await h.ctl.saveLog();
  await h.settle();
  const save = h.calls.find(({ command }) => command === "save_ssh_logs");
  assert.equal(save.args.destinationPath, "");
  assert.equal(save.args.profileName, "My log");
  assert.equal(save.args.host, "host");
  assert.equal(h.ctl.saveLogDialog.open, false);
  assert.deepEqual(h.ctl.savedLogPaths, ["raw", "plain", "commands", "metadata"]);
  assert.equal(h.ctl.hasUnsavedRecording(), false, "a saved recording no longer blocks closing");
  assert.equal(h.states.at(-1).recordingUnsaved, false);
  assert.ok(h.logs.some(([operation, status]) => operation === "ssh_recording" && status === "saved"));
});

test("Save Log passes every kind of destination to save, and no picker opens for a running or empty recording", async (t) => {
  for (const destination of ["", "Documents/logs", "D:/Logs", "//server/share/logs"]) {
    const h = await harness(t);
    await h.ctl.startRecording();
    await h.ctl.stopRecording();
    await h.settle();
    h.setPicker(destination);
    await h.ctl.openSaveLogDialog();
    await h.settle();
    assert.deepEqual(h.calls.find(({ command }) => command === "pick_local_directory").args, { path: "" });
    assert.equal(h.ctl.saveLogDialog.open, true);
    assert.equal(h.ctl.saveLogDialog.destination, destination);
    await h.ctl.saveLog();
    await h.settle();
    const save = h.calls.find(({ command }) => command === "save_ssh_logs");
    assert.equal(save.args.destinationPath, destination);
    assert.equal(save.args.profileName, "Server");
    assert.equal(h.ctl.saveLogDialog.open, false);
    assert.deepEqual(h.ctl.savedLogPaths, ["raw", "plain", "commands", "metadata"]);
  }
  // Nothing recorded yet: Save Log does nothing.
  const empty = await harness(t);
  await empty.ctl.openSaveLogDialog();
  await empty.settle();
  assert.equal(empty.calls.some(({ command }) => command === "pick_local_directory"), false);
  assert.equal(empty.ctl.saveLogDialog.open, false);
  assert.equal(empty.ctl.hasRecordedOutput, false);
  // A recording that is still running cannot be saved.
  const running = await harness(t);
  await running.ctl.startRecording();
  await running.settle();
  await running.ctl.openSaveLogDialog();
  await running.settle();
  assert.equal(running.calls.some(({ command }) => command === "pick_local_directory"), false);
  assert.equal(running.ctl.saveLogDialog.open, false);
  await running.ctl.saveLog();
  assert.equal(running.calls.some(({ command }) => command === "save_ssh_logs"), false);
});

test("closing the window disconnects, and discards a recording that was never saved", async (t) => {
  const h = await harness(t);
  await h.ctl.startRecording();
  await h.settle();
  assert.equal(h.ctl.hasUnsavedRecording(), true);
  assert.equal(h.states.at(-1).recordingUnsaved, true);
  await h.ctl.dispose();
  const names = h.calls.map(({ command }) => command);
  assert.ok(names.includes("stop_ssh_recording"));
  assert.ok(names.includes("discard_ssh_recording"));
  assert.deepEqual(h.calls.find(({ command }) => command === "ssh_disconnect").args, { sessionId: "a-session" });
  assert.equal(h.ctl.hasUnsavedRecording(), false);
});

test("closing while the connection is still being made closes the session that arrives later", async (t) => {
  const connect = deferred();
  const h = await harness(t, { connect: connect.promise });
  await h.ctl.dispose();
  connect.resolve("arrives-late");
  await h.settle();
  assert.deepEqual(h.calls.find(({ command }) => command === "ssh_disconnect").args, { sessionId: "arrives-late" });
  assert.equal(h.ctl.connected, false);
});
