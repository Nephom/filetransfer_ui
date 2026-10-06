import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript } from "./test-utils.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const accountKey = (host, port, username) => `direct-vnc-account:${JSON.stringify([host.toLowerCase(), port, username])}`;

// A small hook/DOM driver: all connection and credential logic is production
// TSX, including its effects and rendered button/input handlers.
function workspace(options = {}) {
  const hooks = [], effects = [], timers = new Map(), calls = [], clients = [];
  const storage = new Map(Object.entries(options.storage || {}));
  const secrets = new Map(Object.entries(options.secrets || {}));
  const dom = new Map(), documentListeners = new Map();
  let cursor = 0, dirty = true, tree, mounted = true, lateUpdates = 0;
  let now = 0, nextTimer = 0, nextConnection = 0;
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === "function" ? initial() : initial };
      return [hooks[index].value, (value) => {
        if (!mounted) { lateUpdates++; return; }
        const next = typeof value === "function" ? value(hooks[index].value) : value;
        if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true; }
      }];
    },
    useRef(value) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { current: value };
      return hooks[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        hooks[index] = { deps, cleanup: previous?.cleanup };
        effects.push(() => {
          hooks[index].cleanup?.();
          hooks[index].cleanup = effect();
        });
      }
    },
  };
  const document = {
    body: { name: "body" }, fullscreenElement: null,
    addEventListener: (type, handler) => documentListeners.set(type, handler),
    removeEventListener: (type) => documentListeners.delete(type),
    async exitFullscreen() { document.fullscreenElement = null; documentListeners.get("fullscreenchange")?.(); },
  };
  const window = {
    location: { href: "http://localhost/" }, innerWidth: 1280,
    confirm: () => true,
    addEventListener() {}, removeEventListener() {},
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  class RFB {
    constructor(screen, url, config) {
      if (options.constructorError) throw new Error(options.constructorError);
      this.screen = screen; this.url = url; this.config = config;
      this.events = new Map(); this.credentials = []; this.disconnects = 0;
      clients.push(this);
    }
    addEventListener(type, handler) { this.events.set(type, handler); }
    emit(type, detail) { this.events.get(type)?.({ detail }); }
    sendCredentials(credentials) {
      this.credentials.push(credentials);
      options.onSend?.(this, credentials);
    }
    disconnect() {
      this.disconnects++;
      if (options.synchronousDisconnect) this.emit("disconnect");
    }
    sendCtrlAltDel() {}
    focus() {}
  }
  const entry = { id: "pve", name: "Guest", baseUrl: "https://pve.local", username: "root@pam", node: "node", vmid: 100, guestType: "lxc", proxmoxVersion: "auto", ignoreTlsErrors: false };
  const props = {
    workspaceName: "Test", entries: [entry], activeEntryId: entry.id, secrets: { pve: { password: "pve-login" } },
    commandbarHost: { name: "commandbar" }, collapseMainPaneEnabled: false,
    screenMode: options.screenMode, screenSessionId: options.screenSessionId, proxmoxSessionId: options.proxmoxSessionId,
    initialVms: options.initialVms, directHost: options.directHost, directPort: options.directPort,
    onOpenFiles: options.onOpenFiles, onFileTransferUpdate: options.onFileTransferUpdate,
    onSelectEntry(id) { props.activeEntryId = id; dirty = true; },
    onChangeEntries(entries) { props.entries = entries; dirty = true; },
    onChangeSecret() {}, onAddEntry() {}, onEditEntry() {}, onRemoveEntry() {},
  };
  const invoke = async (command, args) => {
    calls.push({ command, args: structuredClone(args) });
    if (options.handlers?.[command]) return options.handlers[command](args);
    if (command === "proxmox_load_secret") return secrets.get(args.entryId) ?? null;
    if (command === "proxmox_save_secret") { secrets.set(args.entryId, args.value); return; }
    if (command === "proxmox_forget_secret") { secrets.delete(args.entryId); return; }
    if (command === "direct_vnc_start" || command === "proxmox_vnc_start_session") {
      const id = `connection-${++nextConnection}`;
      return { id, websocketUrl: `ws://localhost/${id}`, password: "backend-ticket" };
    }
    if (command === "proxmox_login") return "pve-session";
    if (command === "proxmox_list_vms_session") return [{ vmid: 100, node: "node", guestType: "lxc" }];
    if (command === "ssh_has_password") return false;
    if (command.endsWith("_cancel")) return;
    throw new Error(`Unexpected invocation: ${command}`);
  };
  const noop = () => null;
  const { ProxmoxVncWorkspace } = loadTypeScript("proxmox-vnc.tsx", {
    mocks: {
      react,
      "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
      "react-dom": { createPortal: (children, container) => jsx("portal", { children, container }) },
      "@tauri-apps/api/core": { invoke },
      "@tauri-apps/api/event": { listen: async () => () => {} },
      "./resizable-pane": { PaneResizeHandle: noop },
      "./ui/MobileChoiceMenu": { MobileChoiceMenu: noop },
      "./ui/EntryActionsMenu": { EntryActionsMenu: noop },
      "./ui/icons": { ChevronLeftIcon: noop, ChevronRightIcon: noop },
      "./ui/Dropdown": { Dropdown: noop },
      "http://localhost/noVNC/core/rfb.js": options.noVncModule || { __esModule: true, default: RFB },
    },
    globals: { window, document, localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } },
  });
  function expand(node) {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") return expand(node.type(node.props));
    if (node.props.ref) {
      if (!dom.has(node.props.ref)) dom.set(node.props.ref, {
        className: node.props.className,
        async requestFullscreen() { document.fullscreenElement = this; documentListeners.get("fullscreenchange")?.(); },
      });
      node.props.ref.current = dom.get(node.props.ref);
    }
    return { ...node, props: { ...node.props, children: expand(node.props.children) } };
  }
  function render() {
    let rounds = 0;
    while (dirty && mounted) {
      assert.ok(++rounds < 30, "render must settle");
      dirty = false; cursor = 0;
      tree = expand(ProxmoxVncWorkspace(props));
      effects.splice(0).forEach((effect) => effect());
    }
    return tree;
  }
  function all(predicate, node = render()) {
    if (Array.isArray(node)) return node.flatMap((child) => all(predicate, child ?? null));
    if (!node || typeof node !== "object") return [];
    return [...(predicate(node) ? [node] : []), ...all(predicate, node.props.children ?? null)];
  }
  function text(node = render()) {
    if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join("");
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (typeof node !== "object") return String(node);
    return text(node.props.children ?? null);
  }
  function button(label) {
    const result = all((node) => node.type === "button" && text(node) === label);
    assert.equal(result.length, 1, `one button: ${label}`);
    return result[0];
  }
  function click(label) {
    const target = button(label);
    assert.ok(!target.props.disabled, `enabled button: ${label}`);
    target.props.onClick(); render();
  }
  function input(label) {
    const field = all((node) => node.type === "label" && text(node) === label)[0];
    assert.ok(field, `input label: ${label}`);
    return all((node) => node.type === "input", field)[0];
  }
  function change(label, value) { input(label).props.onChange({ target: { value } }); render(); }
  async function settle() { for (let i = 0; i < 12; i++) { await Promise.resolve(); render(); } }
  function advance(ms) {
    const end = now + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback(); render();
    }
    now = end;
  }
  function direct() {
    all((node) => node.props["data-direct-vnc-action"])[0].props.onClick(); render();
  }
  async function start() { click("Connect"); await settle(); return clients.at(-1); }
  async function negotiate(types = ["password"]) { const client = await start(); client.emit("credentialsrequired", { types }); await settle(); return client; }
  function unmount() { mounted = false; hooks.forEach((hook) => hook.cleanup?.()); }
  render();
  return { all, text, button, click, input, change, settle, advance, direct, start, negotiate, unmount, render,
    clients, calls, timers, secrets, props, document, get lateUpdates() { return lateUpdates; },
    commands: (command) => calls.filter((call) => call.command === command),
  };
}

function directWorkspace(options = {}) {
  const app = workspace({ ...options, storage: { "fileapi-direct-vnc-host": "server.local", ...options.storage } });
  app.direct();
  return app;
}

test("Direct needs only host and a valid integer port; no-auth connects without secrets", async () => {
  const app = directWorkspace();
  assert.ok(!app.button("Connect").props.disabled);
  assert.equal(app.all((node) => node.type === "input" && node.props.type === "password").length, 1, "only hidden Proxmox login exists before negotiation");
  for (const port of ["0", "-1", "65536", "5900.5", ""]) {
    app.change("Port", port);
    assert.ok(app.button("Connect").props.disabled);
    app.button("Connect").props.onClick();
    assert.equal(app.commands("direct_vnc_start").length, 0);
  }
  app.change("Port", "5901");
  app.change("Host", "  ");
  assert.ok(app.button("Connect").props.disabled);
  app.change("Host", "  server.local  ");
  const client = await app.start();
  assert.deepEqual(app.commands("direct_vnc_start")[0].args, { host: "server.local", port: 5901 });
  assert.deepEqual(client.config, { forceCursorFallback: true });
  client.emit("connect"); app.render();
  assert.match(app.text(), /Connected/);
  assert.equal(app.timers.size, 0);
  assert.deepEqual(client.credentials, []);
  assert.equal(app.commands("proxmox_load_secret").length, 0);
  assert.equal(app.commands("proxmox_save_secret").length, 0);
  assert.doesNotMatch(app.text(), /macOS/);
  app.unmount();
});

test("viewer candidate requires explicit submission of current draft, once, and saves only on success", async () => {
  const app = directWorkspace({ secrets: { "direct-vnc": "legacy-viewer" }, storage: { "fileapi-direct-vnc-username": "old-account" } });
  const client = await app.negotiate();
  assert.equal(app.input("VNC viewer password").props.value, "legacy-viewer");
  assert.equal(app.all((node) => node.type === "label" && app.text(node) === "Username").length, 0);
  assert.deepEqual(client.credentials, []);
  app.change("VNC viewer password", "current-viewer");
  assert.equal(app.commands("proxmox_save_secret").length, 0);
  const submit = app.button("Continue").props.onClick;
  submit(); submit(); app.render();
  assert.deepEqual(client.credentials, [{ password: "current-viewer" }]);
  assert.equal(app.commands("proxmox_save_secret").length, 0);
  client.emit("connect"); await app.settle();
  assert.deepEqual(app.commands("proxmox_save_secret")[0].args, { entryId: "direct-vnc", kind: "password", value: "current-viewer" });
  app.unmount();
});

test("account negotiation never reuses legacy viewer; sends current username and account password together", async () => {
  const key = accountKey("server.local", 5900, "alice");
  const app = directWorkspace({ secrets: { "direct-vnc": "legacy-viewer", [key]: "alice-password" }, storage: { "fileapi-direct-vnc-username": "alice" } });
  const client = await app.negotiate(["username", "password"]);
  assert.equal(app.input("Username").props.value, "alice");
  assert.equal(app.input("Account password").props.value, "alice-password");
  assert.equal(app.commands("proxmox_load_secret")[0].args.entryId, key);
  assert.match(app.text(), /If this server uses macOS Screen Sharing \(ARD\)/);
  app.change("Username", "  bob  "); await app.settle();
  assert.equal(app.input("Account password").props.value, "");
  app.change("Account password", "bob-current");
  app.click("Continue");
  assert.deepEqual(client.credentials, [{ username: "bob", password: "bob-current" }]);
  client.emit("connect"); await app.settle();
  assert.equal(app.secrets.get(accountKey("server.local", 5900, "bob")), "bob-current");
  assert.equal(app.secrets.get("direct-vnc"), "legacy-viewer");
  assert.equal(app.secrets.get(key), "alice-password");
  assert.equal(app.commands("proxmox_forget_secret").length, 0);
  app.unmount();
});

test("account without saved identity waits, never sends blank username or a viewer secret", async () => {
  const app = directWorkspace({ secrets: { "direct-vnc": "legacy-viewer" } });
  const client = await app.negotiate(["password", "username"]);
  assert.equal(app.input("Account password").props.value, "");
  assert.equal(app.commands("proxmox_load_secret").length, 0);
  app.change("Account password", "account-password");
  assert.ok(app.button("Continue").props.disabled);
  app.button("Continue").props.onClick();
  assert.deepEqual(client.credentials, []);
  app.click("Cancel");
  assert.equal(client.disconnects, 1);
  assert.equal(app.timers.size, 0);
  assert.equal(app.secrets.get("direct-vnc"), "legacy-viewer");
  app.unmount();
});

test("waiting pauses the 15s timer; submit re-arms a full 15s and timeout survives disconnect", async () => {
  const app = directWorkspace({ synchronousDisconnect: true });
  const client = await app.start();
  const queuedTimeout = [...app.timers.values()][0].callback;
  app.advance(14_000);
  client.emit("credentialsrequired", { types: ["password"] }); app.render();
  queuedTimeout(); app.render();
  assert.equal(app.timers.size, 0);
  app.advance(60_000);
  assert.equal(client.disconnects, 0);
  app.change("VNC viewer password", "entered"); app.click("Continue");
  queuedTimeout(); app.render();
  app.advance(14_999);
  assert.equal(client.disconnects, 0);
  app.advance(1);
  assert.equal(client.disconnects, 1);
  client.emit("disconnect"); app.render();
  assert.match(app.text(), /Connection failed/);
  assert.match(app.text(), /timed out after 15 seconds/);
  assert.ok(!app.button("Connect").props.disabled);
  assert.equal(app.commands("proxmox_save_secret").length, 0);
  app.unmount();
});

test("old RFB events and queued timeout cannot mutate replacement or its timer", async () => {
  const app = directWorkspace();
  const old = await app.start();
  const oldTimeout = [...app.timers.values()][0].callback;
  app.click("Disconnect");
  const current = await app.start();
  const timer = [...app.timers.keys()][0];
  old.emit("disconnect"); old.emit("securityfailure", { reason: "stale failure" });
  old.emit("connect"); old.emit("credentialsrequired", { types: ["username", "password"] }); oldTimeout();
  app.render();
  assert.ok(app.timers.has(timer));
  assert.equal(app.text().includes("stale failure"), false);
  assert.deepEqual(old.credentials, []);
  assert.equal(app.all((node) => node.props.role === "dialog").length, 0);
  app.advance(15_000);
  assert.equal(current.disconnects, 1);
  assert.match(app.text(), /timed out/);
  app.unmount();
});

test("security reason wins over synchronous and late disconnect; rejected credentials are not retried or saved", async () => {
  const app = directWorkspace({ synchronousDisconnect: true, secrets: { "direct-vnc": "legacy" } });
  const client = await app.negotiate();
  app.change("VNC viewer password", "wrong"); app.click("Continue");
  client.emit("securityfailure", { reason: "Authentication denied by server" });
  client.emit("disconnect"); client.emit("credentialsrequired", { types: ["password"] }); client.emit("connect");
  await app.settle();
  assert.match(app.text(), /Authentication denied by server/);
  assert.match(app.text(), /Connection failed/);
  assert.equal(client.credentials.length, 1);
  assert.equal(app.timers.size, 0);
  assert.equal(app.commands("proxmox_save_secret").length, 0);
  assert.equal(app.secrets.get("direct-vnc"), "legacy");
  app.unmount();
});

test("duplicate waiting requests do not reset drafts; requests after submit fail instead of auto-retry", async () => {
  const app = directWorkspace();
  const client = await app.negotiate();
  app.change("VNC viewer password", "draft");
  client.emit("credentialsrequired", { types: ["password"] }); app.render();
  assert.equal(app.input("VNC viewer password").props.value, "draft");
  app.click("Continue");
  client.emit("credentialsrequired", { types: ["password"] }); app.render();
  assert.match(app.text(), /requested again/);
  assert.equal(client.credentials.length, 1);
  assert.equal(client.disconnects, 1);
  app.unmount();
});

for (const types of [undefined, [], ["username"], ["username", "password", "target"], ["token"], "password"]) {
  test(`unsupported credential fields fail clearly: ${JSON.stringify(types)}`, async () => {
    const app = directWorkspace();
    const client = await app.start();
    client.emit("credentialsrequired", { types }); app.render();
    assert.match(app.text(), /Unsupported VNC credential request/);
    assert.equal(client.disconnects, 1);
    assert.equal(app.timers.size, 0);
    assert.deepEqual(client.credentials, []);
    app.unmount();
  });
}

test("disconnect during handshake fails, but disconnect after connect is not an authentication error", async () => {
  const app = directWorkspace();
  const first = await app.start();
  first.emit("disconnect"); app.render();
  assert.match(app.text(), /disconnected during connection or authentication/);
  const second = await app.start();
  second.emit("connect"); app.render(); second.emit("disconnect"); app.render();
  assert.match(app.text(), /Disconnected/);
  assert.doesNotMatch(app.text(), /during connection or authentication/);
  assert.equal(app.timers.size, 0);
  app.unmount();
});

test("cancel before noVNC import resolves never starts backend; late import error is ignored", async () => {
  for (const broken of [false, true]) {
    const options = broken ? { noVncModule: { __esModule: true, get default() { throw new Error("late import error"); } } } : {};
    const app = directWorkspace(options);
    app.click("Connect"); app.click("Disconnect"); await app.settle();
    assert.equal(app.commands("direct_vnc_start").length, 0);
    assert.equal(app.clients.length, 0);
    assert.doesNotMatch(app.text(), /late import error/);
    assert.ok(!app.button("Connect").props.disabled);
    app.unmount();
  }
});

test("stale backend completion cancels its own ticket without touching a newer attempt", async () => {
  const pending = deferred(); let starts = 0;
  const app = directWorkspace({ handlers: { direct_vnc_start: () => ++starts === 1 ? pending.promise : { id: "new", websocketUrl: "ws://new", password: "" } } });
  app.click("Connect"); await app.settle(); app.click("Disconnect");
  const current = await app.start();
  pending.resolve({ id: "old", websocketUrl: "ws://old", password: "" }); await app.settle();
  assert.equal(app.clients.length, 1);
  assert.equal(current.disconnects, 0);
  assert.equal(app.timers.size, 1);
  assert.deepEqual(app.commands("direct_vnc_cancel").map((call) => call.args.connectionId), ["old"]);
  app.click("Disconnect");
  assert.deepEqual(app.commands("direct_vnc_cancel").map((call) => call.args.connectionId), ["old", "new"]);
  app.unmount();
});

test("unmount invalidates import, pending startup and live RFB without late state updates", async () => {
  for (const stage of ["import", "backend", "rfb", "prompt"]) {
    const pending = deferred();
    const app = directWorkspace(stage === "backend" ? { handlers: { direct_vnc_start: () => pending.promise } } : {});
    // Finish the unrelated initial SSH-profile check before exercising VNC
    // import/start teardown. Transfer effects are outside this change's scope.
    await app.settle();
    app.click("Connect");
    if (stage !== "import") await app.settle();
    const client = app.clients[0];
    if (stage === "prompt") { client.emit("credentialsrequired", { types: ["password"] }); app.render(); }
    app.unmount();
    if (stage === "backend") pending.resolve({ id: "late-unmount", websocketUrl: "ws://late", password: "" });
    client?.emit("disconnect"); client?.emit("connect"); client?.emit("credentialsrequired", { types: ["password"] });
    await app.settle();
    assert.equal(app.lateUpdates, 0, stage);
    assert.equal(app.timers.size, 0, stage);
    if (client) assert.equal(client.disconnects, 1, stage);
    assert.equal(app.commands("direct_vnc_cancel").length, stage === "import" ? 0 : 1, stage);
  }
});

test("startup and constructor errors release ownership and permit another connection", async () => {
  for (const options of [
    { noVncModule: { __esModule: true, get default() { throw new Error("import failed"); } } },
    { handlers: { direct_vnc_start: () => Promise.reject(new Error("backend failed")) } },
    { constructorError: "constructor failed" },
  ]) {
    const app = directWorkspace(options);
    app.click("Connect"); await app.settle();
    assert.match(app.text(), /Connection failed/);
    assert.ok(!app.button("Connect").props.disabled);
    assert.ok(app.button("Disconnect").props.disabled);
    assert.equal(app.timers.size, 0);
    assert.equal(app.commands("direct_vnc_cancel").length, options.constructorError ? 1 : 0);
    app.unmount();
  }
});

test("late viewer load cannot overwrite edits, cancelled prompt, or replacement attempt", async () => {
  const loads = [];
  const app = directWorkspace({ handlers: { proxmox_load_secret: () => { const load = deferred(); loads.push(load); return load.promise; } } });
  await app.negotiate();
  app.change("VNC viewer password", "typed");
  loads[0].resolve("old-keyring"); await app.settle();
  assert.equal(app.input("VNC viewer password").props.value, "typed");
  app.click("Cancel");
  await app.negotiate(); app.click("Cancel");
  await app.negotiate();
  loads[1].resolve("cancelled-load"); await app.settle();
  assert.equal(app.input("VNC viewer password").props.value, "");
  loads[2].resolve("current-load"); await app.settle();
  assert.equal(app.input("VNC viewer password").props.value, "current-load");
  app.unmount();
});

test("late account load cannot cross identities, endpoints, or overwrite a typed password", async () => {
  const loads = [];
  const app = directWorkspace({ storage: { "fileapi-direct-vnc-username": "alice" }, handlers: { proxmox_load_secret: (args) => { const load = deferred(); loads.push({ ...load, args }); return load.promise; } } });
  await app.negotiate(["username", "password"]);
  app.change("Username", "bob");
  loads[0].resolve("alice-secret"); await app.settle();
  assert.equal(app.input("Account password").props.value, "");
  app.change("Account password", "bob-typed");
  loads[1].resolve("bob-stored"); await app.settle();
  assert.equal(app.input("Account password").props.value, "bob-typed");
  app.click("Cancel");
  app.change("Host", "other.local"); app.change("Port", "5901");
  await app.negotiate(["username", "password"]);
  assert.equal(loads[2].args.entryId, accountKey("other.local", 5901, "bob"));
  assert.equal(app.input("Account password").props.value, "");
  app.unmount(); loads[2].resolve("after-unmount"); await app.settle();
  assert.equal(app.lateUpdates, 0);
});

test("explicit forget affects only the selected credential key and invalidates pending load", async () => {
  const load = deferred();
  const key = accountKey("server.local", 5900, "alice");
  const app = directWorkspace({ storage: { "fileapi-direct-vnc-username": "alice" }, secrets: { "direct-vnc": "legacy", [key]: "account" }, handlers: { proxmox_load_secret: () => load.promise } });
  await app.negotiate(["username", "password"]);
  app.click("Forget saved password");
  load.resolve("forgotten-account"); await app.settle();
  assert.equal(app.input("Account password").props.value, "");
  assert.equal(app.secrets.get("direct-vnc"), "legacy");
  assert.equal(app.secrets.has(key), false);
  assert.deepEqual(app.commands("proxmox_forget_secret")[0].args, { entryId: key, kind: "password" });
  app.unmount();
});

test("keyring errors are notices, not network failures; successful submission snapshot is retained", async () => {
  const app = directWorkspace({ handlers: {
    proxmox_load_secret: () => Promise.reject(new Error("locked")),
    proxmox_save_secret: () => Promise.reject(new Error("locked")),
    proxmox_forget_secret: () => Promise.reject(new Error("locked")),
  } });
  const client = await app.negotiate();
  assert.match(app.text(), /could not be loaded/);
  app.click("Forget saved password"); await app.settle();
  assert.match(app.text(), /could not be forgotten/);
  app.change("VNC viewer password", "snapshot"); app.click("Continue");
  client.emit("connect"); await app.settle();
  assert.match(app.text(), /Connected, but credentials could not be saved/);
  assert.doesNotMatch(app.text(), /Connection failed/);
  assert.equal(client.disconnects, 0);
  assert.equal(app.commands("proxmox_save_secret")[0].args.value, "snapshot");
  app.unmount();
});

test("credential dialog stays outside collapsed controls and inside the fullscreen root", async () => {
  const app = directWorkspace();
  const client = await app.start();
  app.click("Collapse");
  app.click("Fullscreen"); await app.settle();
  const fullscreenRoot = app.document.fullscreenElement;
  client.emit("credentialsrequired", { types: ["password"] }); app.render();
  const portal = app.all((node) => node.type === "portal" && node.props.container === fullscreenRoot)[0];
  assert.ok(portal);
  assert.equal(app.all((node) => node.props.role === "dialog", portal).length, 1);
  app.click("Collapse");
  assert.equal(app.all((node) => node.props.role === "dialog").length, 1);
  app.click("Cancel");
  assert.equal(client.disconnects, 1);
  app.unmount();
});

test("Proxmox uses only backend connection.password, never Direct credentials or persistence", async () => {
  const app = directWorkspace({ secrets: { "direct-vnc": "viewer" }, storage: { "fileapi-direct-vnc-username": "alice" } });
  const direct = await app.negotiate(["username", "password"]);
  app.change("Account password", "direct-account"); app.click("Continue");
  app.direct();
  assert.equal(direct.disconnects, 1);
  app.click("Login"); await app.settle();
  const client = await app.start();
  client.emit("credentialsrequired", { types: ["password"] }); app.render();
  assert.deepEqual(client.credentials, [{ password: "backend-ticket" }]);
  assert.deepEqual(client.config, { forceCursorFallback: false });
  assert.equal(app.all((node) => node.props.role === "dialog").length, 0);
  client.emit("connect"); await app.settle();
  assert.equal(app.commands("proxmox_save_secret").length, 0);
  app.unmount();
  assert.equal(app.commands("direct_vnc_cancel").length, 1);
  assert.equal(app.commands("proxmox_vnc_cancel").length, 1);
});

test("Proxmox rejects account and unknown fields instead of sending incomplete or Direct credentials", async () => {
  for (const types of [["username", "password"], ["password", "target"], ["password", "x"]]) {
    const app = workspace({ storage: { "fileapi-direct-vnc-username": "alice" } });
    app.click("Login"); await app.settle();
    const client = await app.start();
    client.emit("credentialsrequired", { types }); app.render();
    assert.deepEqual(client.credentials, []);
    assert.match(app.text(), /Unsupported VNC credential request/);
    app.unmount();
  }
});

test("cleared handshake timeout cannot fail an already-connected session", async () => {
  const app = directWorkspace();
  const client = await app.start();
  const queuedTimeout = [...app.timers.values()][0].callback;
  client.emit("connect"); queuedTimeout(); app.render();
  assert.match(app.text(), /Connected/);
  assert.doesNotMatch(app.text(), /timed out/);
  assert.equal(client.disconnects, 0);
  app.unmount();
});

test("stale Continue callback cannot send credentials or arm a replacement timer", async () => {
  const app = directWorkspace();
  const old = await app.negotiate();
  app.change("VNC viewer password", "old-draft");
  const submit = app.button("Continue").props.onClick;
  app.click("Cancel");
  const current = await app.negotiate(["username", "password"]);
  submit(); app.render();
  assert.deepEqual(old.credentials, []);
  assert.deepEqual(current.credentials, []);
  assert.equal(app.timers.size, 0);
  assert.equal(app.input("Account password").props.value, "");
  app.unmount();
});

test("mode change and entry-selection effect cancel the originating backend kind", async () => {
  const pending = deferred();
  const app = workspace({ handlers: { proxmox_vnc_start_session: () => pending.promise } });
  app.click("Login"); await app.settle(); app.click("Connect"); await app.settle();
  app.direct(); app.change("Host", "server.local");
  const current = await app.start();
  pending.resolve({ id: "old-pve", websocketUrl: "ws://pve", password: "old-ticket" }); await app.settle();
  assert.deepEqual(app.commands("proxmox_vnc_cancel")[0].args, { connectionId: "old-pve" });
  assert.equal(current.disconnects, 0);
  app.props.onSelectEntry("changed-externally"); app.render();
  assert.equal(current.disconnects, 1);
  assert.equal(app.commands("direct_vnc_cancel").length, 1);
  assert.equal(app.timers.size, 0);
  app.unmount();
});

test("late startup rejection and save rejection cannot change a replacement's state", async () => {
  const startup = deferred(), save = deferred(); let starts = 0;
  const app = directWorkspace({ handlers: {
    direct_vnc_start: () => ++starts === 1 ? startup.promise : { id: `direct-${starts}`, websocketUrl: "ws://direct", password: "" },
    proxmox_save_secret: () => save.promise,
  } });
  app.click("Connect"); await app.settle(); app.click("Disconnect");
  const authenticated = await app.negotiate();
  app.change("VNC viewer password", "successful-snapshot"); app.click("Continue");
  authenticated.emit("connect"); app.render();
  app.click("Expand"); app.click("Disconnect");
  const current = await app.start();
  startup.reject(new Error("stale startup failure")); save.reject(new Error("stale save failure")); await app.settle();
  assert.equal(current.disconnects, 0);
  assert.equal(app.timers.size, 1);
  assert.doesNotMatch(app.text(), /failure|could not be saved/);
  assert.equal(app.commands("proxmox_save_secret")[0].args.value, "successful-snapshot");
  app.unmount();
});

const vncController = loadTypeScript("features/vnc/VncWorkspaceController.tsx", {
  mocks: {
    react: { useState() {}, useEffect() {} },
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null },
    "@tauri-apps/api/core": { invoke: async () => undefined },
    "../../ui/FloatingWindow": { FloatingWindow: () => null },
    "../../proxmox-vnc": {
      ProxmoxVncWorkspace: () => null,
      vmSshProfileId: (entryId, node, vmid) => `${entryId}:${node}:${vmid}`,
      vmSshProfileKey: (node, vmid) => `${node}:${vmid}`,
    },
  },
});

test("choosing a VNC Entry loads its saved password, logs in, then fetches VMs", async () => {
  const entry = { id: "pve", name: "PVE", baseUrl: "https://pve.local:8006", username: "root@pam", node: "node", vmid: null, guestType: "qemu", proxmoxVersion: "auto", ignoreTlsErrors: false };
  const calls = [];
  const result = await vncController.loginProxmoxVncEntry(entry, {
    async loadPassword(id) { calls.push(["load", id]); return "stored-password"; },
    async login(value, password) { calls.push(["login", value.id, password]); return "pve-session"; },
    async listVms(value, sessionId) { calls.push(["list", value.id, sessionId]); return [{ vmid: 101, node: "node", guestType: "qemu" }]; },
    async logout(sessionId) { calls.push(["logout", sessionId]); },
  });
  assert.equal(result.kind, "ready");
  assert.equal(result.sessionId, "pve-session");
  assert.equal(result.vms[0].vmid, 101);
  assert.deepEqual(calls, [["load", "pve"], ["login", "pve", "stored-password"], ["list", "pve", "pve-session"]]);
});

test("VNC Entry login reports a missing password without starting an API session", async () => {
  let loginCalls = 0;
  const result = await vncController.loginProxmoxVncEntry({ id: "pve" }, {
    async loadPassword() { return null; },
    async login() { loginCalls++; return "should-not-start"; },
    async listVms() { throw new Error("should not list"); },
    async logout() {},
  });
  assert.deepEqual(result, { kind: "missing-password" });
  assert.equal(loginCalls, 0);
});

test("VM-list failure logs out the newly authenticated Proxmox session", async () => {
  const calls = [];
  await assert.rejects(vncController.loginProxmoxVncEntry({ id: "pve" }, {
    async loadPassword() { return "stored-password"; },
    async login() { return "pve-session"; },
    async listVms() { throw new Error("VM list unavailable"); },
    async logout(sessionId) { calls.push(sessionId); },
  }), /VM list unavailable/);
  assert.deepEqual(calls, ["pve-session"]);
});

test("VM picker Connect passes the currently selected node and guest", () => {
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = { useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}], useEffect() {} };
  const { VncVmPickerPane } = loadTypeScript("features/vnc/VncWorkspaceController.tsx", {
    mocks: {
      react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "@tauri-apps/api/core": { invoke: async () => false },
      "../../ui/FloatingWindow": { FloatingWindow: () => null },
      "../../proxmox-vnc": {
        ProxmoxVncWorkspace: () => null,
        vmSshProfileId: () => "vm-profile",
        vmSshProfileKey: (node, vmid) => `${node}:${vmid}`,
      },
    },
  });
  const vm = { vmid: 100, node: "node-a", name: "Guest A", status: "running", guestType: "qemu" };
  let connectedVm = null;
  const tree = VncVmPickerPane({
    entry: { id: "pve", name: "PVE", baseUrl: "https://pve.local", node: "node-a", vmid: 100 },
    vms: [vm], authenticated: true, loading: false, error: "", onChangeEntry() {}, onConnect: (selected) => { connectedVm = selected; }, onRetry() {}, onLogout() {}, onEditEntry() {},
  });
  const collect = (node, predicate, output = []) => {
    if (Array.isArray(node)) { node.forEach((child) => collect(child, predicate, output)); return output; }
    if (!node || typeof node !== "object") return output;
    if (predicate(node)) output.push(node);
    collect(node.props?.children, predicate, output);
    return output;
  };
  const connect = collect(tree, (node) => node.type === "button" && node.props.children === "Connect")[0];
  assert.ok(connect);
  assert.equal(connect.props.disabled, false);
  connect.props.onClick();
  assert.equal(connectedVm, vm);
});

test("Proxmox screen is an independent viewer using the selected VM session and Files action", async () => {
  let openFiles = 0;
  const updates = [];
  const app = workspace({
    screenMode: "proxmox",
    screenSessionId: "screen-one",
    proxmoxSessionId: "pve-session",
    initialVms: [{ vmid: 100, node: "node", guestType: "lxc", name: "Guest" }],
    onOpenFiles: () => { openFiles++; },
    onFileTransferUpdate: (sessionId, state) => updates.push([sessionId, state]),
  });
  await app.settle();
  assert.equal(app.commands("proxmox_login").length, 0, "the screen reuses the VM picker session");
  assert.deepEqual(app.commands("proxmox_vnc_start_session")[0].args, {
    entry: { ...app.props.entries[0], guestType: "lxc", ignoreTlsErrors: false },
    sessionId: "pve-session",
  });
  const client = app.clients[0];
  assert.ok(client);
  client.emit("connect"); await app.settle();
  const filesButton = app.button("Files");
  assert.equal(filesButton.props.disabled, false);
  filesButton.props.onClick();
  assert.equal(openFiles, 1);
  assert.equal(client.disconnects, 0, "opening the file pane does not disconnect the VNC client");
  assert.ok(updates.some(([id, state]) => id === "screen-one" && state?.mode === "unavailable"));
  app.unmount();
});

test("Direct setup screen connects to its configured host and has no Files action", async () => {
  const app = workspace({ screenMode: "direct", screenSessionId: "direct-screen", directHost: "mac.local", directPort: 5901 });
  await app.settle();
  assert.deepEqual(app.commands("direct_vnc_start")[0].args, { host: "mac.local", port: 5901 });
  assert.equal(app.all((node) => node.type === "button" && app.text(node) === "Files").length, 0);
  app.unmount();
});

test("Direct VNC setup keeps host and port settings and opens a screen with those values", () => {
  const jsx = (type, props) => ({ type, props: props || {} });
  const stored = new Map([["fileapi-direct-vnc-host", "mac.local"], ["fileapi-direct-vnc-port", "5902"]]);
  const { VncDirectSetupPane } = loadTypeScript("features/vnc/VncWorkspaceController.tsx", {
    mocks: {
      react: { useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}], useEffect() {} },
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "@tauri-apps/api/core": { invoke: async () => undefined },
      "../../ui/FloatingWindow": { FloatingWindow: () => null },
      "../../proxmox-vnc": {
        ProxmoxVncWorkspace: () => null,
        ProxmoxVncScreenPane: () => null,
        vmSshProfileId: () => "vm-profile",
        vmSshProfileKey: () => "vm-key",
      },
    },
    globals: { localStorage: { getItem: (key) => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) } },
  });
  let target = null;
  const tree = VncDirectSetupPane({ onConnect: (host, port) => { target = { host, port }; } });
  const collect = (node, predicate, output = []) => {
    if (Array.isArray(node)) { node.forEach((child) => collect(child, predicate, output)); return output; }
    if (!node || typeof node !== "object") return output;
    if (predicate(node)) output.push(node);
    collect(node.props?.children, predicate, output);
    return output;
  };
  const connect = collect(tree, (node) => node.type === "button" && node.props.children === "Connect")[0];
  assert.ok(connect);
  assert.equal(connect.props.disabled, false);
  connect.props.onClick();
  assert.deepEqual(target, { host: "mac.local", port: 5902 });
});

test("independent Files pane routes navigation, selection, and upload actions to its VM session", () => {
  const jsx = (type, props) => ({ type, props: props || {} });
  const { VncFileTransferPane } = loadTypeScript("features/vnc/VncFileTransferPane.tsx", {
    mocks: {
      react: {},
      "react/jsx-runtime": { jsx, jsxs: jsx },
    },
  });
  const actions = [];
  const fileBrowser = {
    visible: true, hasRoute: true, loading: false, modeLabel: "SFTP (direct)", mode: "direct-sftp", guestIp: "10.0.0.8", filesReady: true,
    path: "/home/foo/", files: [{ name: "notes.txt", path: "/home/foo/notes.txt", isDirectory: false, size: 8, modified: 1 }],
    filesLoading: false, filesError: "", transferError: "", canTryHostJump: false, selectedPaths: new Set(["/home/foo/notes.txt"]), queue: [],
    onBack() {}, onReturn() {}, onNavigate(path) { actions.push(["navigate", path]); }, onToggleSelect(path) { actions.push(["select", path]); },
    onUpload() { actions.push(["upload"]); }, onDownload() { actions.push(["download"]); }, onRefresh() {}, onTryHostJump() {}, onRemoveQueueItem() {},
  };
  const tree = VncFileTransferPane({ entry: { name: "PVE" }, vmName: "Guest", vmid: 100, fileBrowser });
  const collect = (node, predicate, output = []) => {
    if (Array.isArray(node)) { node.forEach((child) => collect(child, predicate, output)); return output; }
    if (!node || typeof node !== "object") return output;
    if (predicate(node)) output.push(node);
    collect(node.props?.children, predicate, output);
    return output;
  };
  const buttons = collect(tree, (node) => node.type === "button");
  const upload = buttons.find((button) => button.props.children === "Upload");
  assert.ok(upload);
  upload.props.onClick();
  const folderButton = buttons.find((button) => button.props.className === "tree-folder");
  folderButton.props.onClick();
  const checkbox = collect(tree, (node) => node.type === "input" && node.props.type === "checkbox")[0];
  checkbox.props.onChange();
  assert.deepEqual(actions, [["upload"], ["navigate", "/home"], ["select", "/home/foo/notes.txt"]]);
});
