import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript, hookDriver, deferred, nativeJson } from "./test-utils.js";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const { locationHeaders, groupRemoteDeletes } = loadTypeScript("features/remote-browser/remote-browser-contracts.ts");
const { initialQueueProgress, updateQueueProgress } = loadTypeScript("queue/progress.ts");
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const nodes = (tree, predicate) => {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
};
const text = (tree) => Array.isArray(tree) ? tree.map(text).join("") : tree && typeof tree === "object" ? text(tree.props?.children) : typeof tree === "string" ? tree : "";

test("Location, revision and JSON headers do not depend on bearer authentication", () => {
  for (const token of ["cookie", "", "bearer"]) {
    const headers = Object.fromEntries(locationHeaders({ token, locationId: "B", locationRevision: "root-B" }, true));
    assert.equal(headers["X-Location-ID"], "B");
    assert.equal(headers["X-Location-Revision"], "root-B");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers.Authorization, token === "bearer" ? "Bearer bearer" : undefined);
  }
});

test("search deletes group duplicate basenames by actual parent, with full and legacy paths", () => {
  assert.deepEqual(groupRemoteDeletes([
    { name: "same", path: "a/same", isDirectory: false },
    { name: "same", path: "b/same", isDirectory: false },
    { name: "root", path: "root", isDirectory: true },
  ]), [
    { currentPath: "a", items: [{ name: "same", path: "a/same", isDirectory: false }] },
    { currentPath: "b", items: [{ name: "same", path: "b/same", isDirectory: false }] },
    { currentPath: "", items: [{ name: "root", path: "root", isDirectory: true }] },
  ]);
});

test("zero totals remain known; unknown totals and nonfinite values never fabricate progress", () => {
  assert.equal(initialQueueProgress(1, 0).totalBytes, 0);
  assert.equal(initialQueueProgress(1, 0).percentage, 0);
  assert.equal(updateQueueProgress(undefined, 0, 0, 1, 1, []).percentage, 100);
  assert.equal(updateQueueProgress(undefined, 0, null, 1, 1, []).percentage, null);
  assert.equal(updateQueueProgress(undefined, NaN, Infinity, 0, 1, []).completedBytes, 0);
});

test("Location refresh ignores logout and invalidates a changed root with the same Location ID", async () => {
  const driver = hookDriver(); const pending = deferred(); let invalidations = 0;
  const props = {
    sessionIdentity: "account-A", session: { locationId: "A", locationRevision: "old-root" },
    api: () => pending.promise, readError: async () => "failed", setSession: (update) => { props.session = update(props.session); },
    locations: [], setLocations: (value) => { props.locations = value; }, setLocationsLoading() {},
    locationsLoadedRef: { current: false }, locationRefreshInProgressRef: { current: false },
    managedSessions: [], sshTabs: [], remoteSshEntryId: "", onLocationInvalidated: () => invalidations++,
  };
  const { useRemoteApiActions } = loadTypeScript("features/remote-browser/useRemoteApiActions.ts", { mocks: { react: driver.react } });
  const render = () => driver.render(() => useRemoteApiActions(props));
  const loading = render().loadLocations();
  pending.resolve({ ok: true, json: async () => ({ locations: [{ id: "A", revision: "new-root" }] }) });
  await loading;
  assert.equal(props.session.locationRevision, "new-root"); assert.equal(invalidations, 1);
  const later = deferred(); props.api = () => later.promise;
  const stale = render().loadLocations(); driver.unmount();
  later.resolve({ ok: true, json: async () => ({ locations: [{ id: "wrong" }] }) }); await stale;
  assert.equal(props.session.locationId, "A");
});

test("share dialog captures its selected file and protected links never expose a direct URL", async () => {
  const driver = hookDriver(), calls = [];
  let current = true;
  const props = {
    run: async (action) => action(), notify() {},
    api: async (_endpoint, init) => { calls.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ data: { hasPassword: true, shareUrl: "/share/safe", directDownloadUrl: "/direct/unsafe" } }) }; },
    readError: async () => "error", session: { token: "cookie", locationId: "A", role: "user" }, serverUrl: () => "https://server.test",
    writeOperationLog() {}, describeError: String, shareLinkMode: "secure", shareLinkExpirationDays: 1,
    ensureApiRemote() {}, isContextCurrent: () => current,
    selectedShareableItem: { path: "original/file", isDirectory: false }, shareLinks: [], setShareLinks() {}, setShareLinksLoading() {},
    setShareUrl: (url) => { props.url = url; }, setShareLinksOpen() {}, setSharePasswordOpen() {}, setSharePasswordDraft() {},
  };
  const { useShareLinksActions } = loadTypeScript("features/share-links/useShareLinksActions.ts", { mocks: { react: driver.react } });
  const render = () => driver.render(() => useShareLinksActions(props));
  render().share(); props.selectedShareableItem = { path: "other/file", isDirectory: false };
  await render().createShareLink("secret");
  assert.equal(calls[0].filePath, "original/file"); assert.equal(calls[0].password, "secret");
  assert.equal(render().shareLinkUrl({ hasPassword: true, directDownloadUrl: "/unsafe" }, "direct"), "");
  assert.equal(props.url, "https://server.test/share/safe");
  render().share(); current = false;
  await assert.rejects(render().createShareLink("secret"), /original Location/);
  assert.equal(calls.length, 1);
});

function desktop(handler = () => undefined) {
  const driver = hookDriver({ effects: false }), calls = [], storage = new Map();
  const jsx = (type, props) => ({ type, props });
  const invoke = async (command, args) => {
    calls.push({ command, args });
    const result = handler(command, args);
    if (result !== undefined) return result;
    if (command === "append_structured_operation_log") return null;
    if (command === "api_request" && /\/api\/files(?:\?|\/(rename|delete|move|paste)$)/.test(args.url)) return nativeJson({ success: true, files: [], currentPath: "" });
    throw new Error(`Unexpected native invocation: ${command}`);
  };
  const window = { innerWidth: 1280, innerHeight: 800, setTimeout: () => 1, clearTimeout() {}, confirm: () => true, prompt: () => "renamed" };
  const { DesktopApp } = loadTypeScript("main.tsx", {
    importMeta: { env: {} },
    mocks: {
      react: driver.react, "react/jsx-runtime": { jsx, jsxs: jsx }, "react-dom/client": { createRoot: () => ({ render() {} }) }, "react-dom": { createPortal: jsx },
      "@tauri-apps/api/core": { invoke }, "@tauri-apps/api/event": { listen: async () => () => {} }, "@tauri-apps/api/path": { resolveResource: async () => "fake-icon" },
      "@tauri-apps/plugin-clipboard-manager": { readText: () => { throw new Error("Unexpected clipboard"); } },
    },
    globals: { window, document: { getElementById: () => ({}) }, FormData: class { constructor(form) { this.form = form; } get(name) { return this.form[name]; } }, localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } },
  });
  const props = {
    session: { host: "server.test", port: "9443", username: "admin", userId: 0, token: "cookie", nativeSessionId: "opaque-A", role: "admin", permissions: [], locationId: "A", saveUserInformation: false },
    setSession: (update) => { props.session = typeof update === "function" ? update(props.session) : update; },
    password: "", setPassword() {}, busy: false, setBusy(value) { props.busy = value; }, notice: "", setNotice(value) { props.notice = value; },
    refreshSessionToken: async () => { props.refreshes = (props.refreshes || 0) + 1; return "refreshed"; }, logoutSession: async () => {}, invalidateCredentials: async () => {},
  };
  const render = () => driver.render(() => DesktopApp(props));
  const search = (value) => {
    const field = nodes(render(), (node) => node.type === "input" && node.props.placeholder === "Search files")[0];
    assert.ok(field, "production search field"); field.props.onChange({ target: { value } });
    nodes(render(), (node) => node.type === "input" && node.props.placeholder === "Search files")[0].props.onKeyDown({ key: "Enter" });
  };
  return { props, calls, render, search, driver, window, storage };
}

test("desktop enabled Rename, Move, Undo and Delete operate on actual backend files", { timeout: 30000 }, async (t) => {
  const parent = join(tmpdir(), "opencode");
  await mkdir(parent, { recursive: true });
  const base = join(parent, `native-backend-${randomUUID()}`);
  await mkdir(base);
  const child = spawn(process.execPath, [fileURLToPath(new URL("backend-fixture.cjs", import.meta.url)), base, "--desktop-mutations"], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => { child.kill(); await exited; await rm(base, { recursive: true, force: true }); });
  const ready = await Promise.race([
    once(child.stdout, "data").then(([chunk]) => JSON.parse(String(chunk))),
    exited.then(() => { throw new Error(`Fixture exited: ${stderr}`); }),
  ]);
  const origin = `http://127.0.0.1:${ready.port}`;
  const login = await fetch(`${origin}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "fixture-admin", password: "native-fixture-password" }) });
  assert.equal(login.status, 200);
  let cookie = login.headers.get("set-cookie").split(";")[0];
  const expire = async () => {
    const response = await fetch(`${origin}/__test/expired-token`, { method: "POST", headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    cookie = `${cookie.split("=")[0]}=${(await response.json()).token}`;
  };
  const send = async (endpoint, method, body) => {
    const response = await fetch(`${origin}${endpoint}`, { method, headers: { Cookie: cookie, "Content-Type": "application/json", "X-Location-ID": "default" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
  };
  await send("/api/folders", "POST", { folderName: "source" });
  await send("/api/folders", "POST", { folderName: "target" });
  await send("/api/files/create", "POST", { currentPath: "source", fileName: "original.txt", content: "real mutation bytes" });
  let pending = 0;
  const app = desktop(async (command, args) => {
    if (command !== "api_request") return null;
    assert.equal(args.sessionId, "opaque-A");
    pending++;
    try {
      const url = new URL(args.url);
      const response = await fetch(`${origin}${url.pathname}${url.search}`, {
        method: args.method, headers: { ...Object.fromEntries(args.headers), Cookie: cookie },
        body: args.body ? Uint8Array.from(args.body) : undefined,
      });
      return { status: response.status, body: [...new Uint8Array(await response.arrayBuffer())] };
    } finally { pending--; }
  });
  app.props.session.locationId = "default";
  app.props.refreshSessionToken = async () => {
    app.props.refreshes = (app.props.refreshes || 0) + 1;
    const response = await fetch(`${origin}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "fixture-admin", password: "native-fixture-password" }) });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie").split(";")[0];
    return "cookie";
  };
  const settle = async () => {
    for (let i = 0; i < 300; i++) {
      app.render();
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (!pending && !app.props.busy) { app.render(); return; }
    }
    throw new Error(`Desktop did not settle: ${app.props.notice}`);
  };
  const click = async (label) => {
    const button = nodes(app.render(), (node) => node.type === "button" && text(node) === label)[0];
    assert.ok(button, label);
    assert.equal(Boolean(button.props.disabled), false, `${label} must be enabled`);
    button.props.onClick();
    await settle();
  };
  // Load real health/capabilities instead of invoking disabled buttons directly.
  await click("Refresh");
  await click("Refresh");
  const openSource = nodes(app.render(), (node) => node.props?.["data-path"] === "source")[0];
  assert.ok(openSource, app.props.notice);
  openSource.props.onDoubleClick();
  await settle();
  const row = () => nodes(app.render(), (node) => node.props?.["data-path"] === "source/original.txt")[0];
  assert.ok(row(), app.props.notice);
  row().props.onClick({});
  await expire();
  await click("Rename");
  assert.equal(await readFile(join(base, "storage/source/renamed"), "utf8"), "real mutation bytes");
  await assert.rejects(access(join(base, "storage/source/original.txt")), { code: "ENOENT" });
  const renamed = nodes(app.render(), (node) => node.props?.["data-path"] === "source/renamed")[0];
  assert.ok(renamed, app.props.notice);
  await expire();
  renamed.props.onDragStart({ dataTransfer: { setData() {} }, altKey: false });
  const root = nodes(app.render(), (node) => node.props?.className?.startsWith("tree-node") && node.props.onDropCapture)[0];
  root.props.onDropCapture({ preventDefault() {}, stopPropagation() {} });
  await settle();
  assert.equal(await readFile(join(base, "storage/renamed"), "utf8"), "real mutation bytes");
  await assert.rejects(access(join(base, "storage/source/renamed")), { code: "ENOENT" });
  await click("Undo");
  assert.equal(await readFile(join(base, "storage/source/renamed"), "utf8"), "real mutation bytes");
  nodes(app.render(), (node) => node.props?.["data-path"] === "source/renamed")[0].props.onClick({});
  await expire();
  await click("Delete");
  await assert.rejects(access(join(base, "storage/source/renamed")), { code: "ENOENT" });
  assert.equal(app.props.refreshes, 3, "Rename, Move and Delete each recover real expired cookie auth");
  for (const call of app.calls.filter((call) => /\/api\/files\/(rename|move|paste|delete)$/.test(call.args?.url))) {
    const headers = new Headers(call.args.headers);
    assert.equal(headers.get("X-Location-ID"), "default");
    assert.equal(headers.get("X-Location-Revision"), app.props.session.locationRevision);
    assert.equal(headers.get("Content-Type"), "application/json");
  }
});

test("production search ignores out-of-order responses, clearing, and Location switches", async () => {
  const first = deferred(), second = deferred();
  const app = desktop((command, args) => {
    if (args.url?.includes("query=first")) return first.promise;
    if (args.url?.includes("query=second")) return second.promise;
  });
  app.search("first"); app.search("second");
  second.resolve(nativeJson({ files: [{ path: "b/new", name: "new", isDirectory: false, size: 1 }] })); await tick();
  assert.match(text(app.render()), /new/);
  first.resolve(nativeJson({ files: [{ path: "a/stale", name: "stale", isDirectory: false, size: 1 }] })); await tick();
  assert.doesNotMatch(text(app.render()), /stale/);
  const cleared = deferred();
  const other = desktop((_command, args) => args.url?.includes("/search?") ? cleared.promise : undefined);
  other.search("pending");
  nodes(other.render(), (node) => node.props?.["aria-label"] === "Clear search")[0].props.onClick();
  cleared.resolve(nativeJson({ files: [{ path: "a/stale", name: "stale", isDirectory: false, size: 1 }] })); await tick();
  assert.doesNotMatch(text(other.render()), /stale/);
  const switched = deferred();
  const changed = desktop((_command, args) => args.url?.includes("/search?") ? switched.promise : undefined);
  changed.search("pending");
  nodes(changed.render(), (node) => node.props?.label === "LocationID")[0].props.onSelect("location:B"); changed.render();
  switched.resolve(nativeJson({ files: [{ path: "a/stale", name: "stale", isDirectory: false, size: 1 }] })); await tick();
  assert.doesNotMatch(text(changed.render()), /stale/);
});

test("production search rename/delete use the actual parent and full path", async () => {
  const app = desktop((_command, args) => args.url?.includes("/search?") ? nativeJson({ files: [{ path: "real/same", name: "same", isDirectory: false, size: 1 }] }) : undefined);
  app.search("same"); await tick();
  const row = nodes(app.render(), (node) => node.props?.["data-path"] === "real/same")[0];
  assert.ok(row); row.props.onClick({});
  const rename = nodes(app.render(), (node) => node.type === "button" && text(node) === "Rename")[0];
  assert.ok(rename); rename.props.onClick(); await tick();
  const request = app.calls.find((call) => call.args.url?.endsWith("/api/files/rename"));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(Uint8Array.from(request.args.body))), { oldName: "same", oldPath: "real/same", newName: "renamed", currentPath: "real" });
  assert.equal(request.args.sessionId, "opaque-A");
  app.search("same"); await tick();
  nodes(app.render(), (node) => node.props?.["data-path"] === "real/same")[0].props.onClick({});
  nodes(app.render(), (node) => node.type === "button" && text(node) === "Delete")[0].props.onClick(); await tick();
  const deletion = app.calls.find((call) => call.args.url?.endsWith("/api/files/delete"));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(Uint8Array.from(deletion.args.body))), { currentPath: "real", items: [{ name: "same", path: "real/same", isDirectory: false }] });
});

test("production cross-parent move undo calls move, not rename, with the complete destination path", async () => {
  const app = desktop((_command, args) => args.url?.includes("/search?") ? nativeJson({ files: [{ path: "real/same", name: "same", isDirectory: false, size: 1 }] }) : undefined);
  app.search("same"); await tick();
  const row = nodes(app.render(), (node) => node.props?.["data-path"] === "real/same")[0];
  row.props.onDragStart({ dataTransfer: { setData() {} }, altKey: false }); app.render();
  nodes(app.render(), (node) => node.props?.className?.startsWith("tree-node") && node.props.onDropCapture)[0].props.onDropCapture({ preventDefault() {}, stopPropagation() {} });
  await tick();
  nodes(app.render(), (node) => node.type === "button" && text(node) === "Undo")[0].props.onClick(); await tick();
  const undo = app.calls.find((call) => call.args.url?.endsWith("/api/files/move"));
  assert.ok(undo);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(Uint8Array.from(undo.args.body))), { sourcePath: "same", destinationPath: "real/same", sourceLocationId: "A", targetLocationId: "A" });
});

test("password rejection 401 is not replayed; ordinary expired-session reads retry once", async () => {
  let searches = 0;
  const app = desktop((_command, args) => {
    if (args.url?.endsWith("/auth/change-password")) return nativeJson({ error: "Wrong current password" }, 401);
    if (args.url?.includes("/search?") && ++searches === 1) return nativeJson({ error: "expired" }, 401);
    if (args.url?.includes("/search?")) return nativeJson({ files: [] });
  });
  nodes(app.render(), (node) => Boolean(node.props?.onChangePassword))[0].props.onChangePassword();
  nodes(app.render(), (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {}, currentTarget: { currentPassword: "wrong", newPassword: "new", confirmPassword: "new" } });
  await tick();
  assert.equal(app.calls.filter((call) => call.args.url?.endsWith("/auth/change-password")).length, 1);
  assert.equal(app.props.refreshes || 0, 0);
  app.search("read"); await tick();
  assert.equal(app.props.refreshes, 1); assert.equal(searches, 2);
});

test("expired-session Move and Delete recover authentication once before retrying", async () => {
  for (const operation of ["paste", "delete"]) {
    let mutations = 0;
    const app = desktop((_command, args) => {
      if (args.url?.includes("/search?")) return nativeJson({ files: [{ name: "same", path: "real/same", isDirectory: false, size: 1 }] });
      if (args.url?.endsWith(`/api/files/${operation}`)) {
        if (++mutations === 1) return nativeJson({ error: "Token expired" }, 401);
        assert.equal(new Headers(args.headers).get("Authorization"), "Bearer refreshed");
        return nativeJson({ success: true, results: [{ path: "real/same", success: true }] });
      }
    });
    app.search("same"); await tick();
    const row = nodes(app.render(), (node) => node.props?.["data-path"] === "real/same")[0];
    if (operation === "paste") {
      row.props.onDragStart({ dataTransfer: { setData() {} }, altKey: false });
      nodes(app.render(), (node) => node.props?.className?.startsWith("tree-node") && node.props.onDropCapture)[0].props.onDropCapture({ preventDefault() {}, stopPropagation() {} });
    } else {
      row.props.onClick({});
      nodes(app.render(), (node) => node.type === "button" && text(node) === "Delete")[0].props.onClick();
    }
    await tick();
    assert.equal(app.props.refreshes, 1, `${operation} must recover the expired session`);
    assert.equal(mutations, 2);
  }
});

test("Move and Delete show the backend rejection instead of only unconfirmed counts", async () => {
  for (const operation of ["paste", "delete"]) {
    const app = desktop((_command, args) => {
      if (args.url?.includes("/search?")) return nativeJson({ files: [{ name: "same", path: "real/same", isDirectory: false, size: 1 }] });
      if (args.url?.endsWith(`/api/files/${operation}`)) return nativeJson({ error: "Location changed; refresh before retrying", results: [] }, 409);
    });
    app.search("same"); await tick();
    const row = nodes(app.render(), (node) => node.props?.["data-path"] === "real/same")[0];
    if (operation === "paste") {
      row.props.onDragStart({ dataTransfer: { setData() {} }, altKey: false });
      nodes(app.render(), (node) => node.props?.className?.startsWith("tree-node") && node.props.onDropCapture)[0].props.onDropCapture({ preventDefault() {}, stopPropagation() {} });
    } else {
      row.props.onClick({});
      nodes(app.render(), (node) => node.type === "button" && text(node) === "Delete")[0].props.onClick();
    }
    await tick();
    assert.match(app.props.notice, /HTTP 409.*Location changed; refresh before retrying/);
    assert.equal(app.props.refreshes || 0, 0, "A stale root must never cause login/replay");
  }
});

test("Move must not replay an expired request after its session or root changes", async () => {
  const refresh = deferred();
  let mutations = 0;
  const app = desktop((_command, args) => {
    if (args.url?.includes("/search?")) return nativeJson({ files: [{ name: "same", path: "real/same", isDirectory: false, size: 1 }] });
    if (args.url?.endsWith("/api/files/paste")) { mutations++; return nativeJson({ error: "Token expired" }, 401); }
  });
  app.props.session = { ...app.props.session, locationRevision: "original-root" };
  app.props.refreshSessionToken = () => refresh.promise;
  app.search("same"); await tick();
  const row = nodes(app.render(), (node) => node.props?.["data-path"] === "real/same")[0];
  row.props.onDragStart({ dataTransfer: { setData() {} }, altKey: false });
  nodes(app.render(), (node) => node.props?.className?.startsWith("tree-node") && node.props.onDropCapture)[0].props.onDropCapture({ preventDefault() {}, stopPropagation() {} });
  await tick();
  assert.equal(mutations, 1);
  const request = app.calls.find((call) => call.args?.url?.endsWith("/api/files/paste"));
  assert.equal(new Headers(request.args.headers).get("X-Location-Revision"), "original-root");
  app.props.session = { ...app.props.session, locationRevision: "replacement-root", nativeSessionId: "new-session" };
  app.render();
  refresh.resolve("refreshed"); await tick();
  assert.equal(mutations, 1, "A mutation selected under the old root must not be replayed");
});

test("partial mutation explanations and rate-limit errors retain the actual backend reason", () => {
  const { remoteMutationError } = loadTypeScript("features/remote-browser/remote-browser-contracts.ts");
  assert.match(remoteMutationError({ error: "Too many file operations, please slow down." }, 429), /^HTTP 429.*Too many file operations/);
  assert.match(remoteMutationError({ results: [{ path: "a/file", success: false, error: "Permission denied" }] }, 207), /a\/file: Permission denied/);
  assert.equal(remoteMutationError({ success: true }, 200), "");
});

test("viewer responses cannot cross a Location switch", async () => {
  const pending = deferred();
  const app = desktop((_command, args) => {
    if (args.url?.includes("/search?")) return nativeJson({ files: [{ path: "a/file", name: "file", isDirectory: false, size: 1 }] });
    if (args.url?.includes("/content/")) return pending.promise;
  });
  app.search("file"); await tick();
  nodes(app.render(), (node) => node.props?.["data-path"] === "a/file")[0].props.onClick({});
  nodes(app.render(), (node) => node.type === "button" && text(node) === "View")[0].props.onClick();
  nodes(app.render(), (node) => node.props?.label === "LocationID")[0].props.onSelect("location:B"); app.render();
  pending.resolve(nativeJson({ content: "stale viewer" })); await tick();
  assert.equal(nodes(app.render(), (node) => node.props?.content === "stale viewer").length, 0);
});

test("stale search errors do not replace a newer result's notice", async () => {
  const stale = deferred();
  const app = desktop((_command, args) => args.url?.includes("query=old") ? stale.promise : args.url?.includes("/search?") ? nativeJson({ files: [] }) : undefined);
  app.search("old"); app.search("new"); await tick();
  stale.reject(new Error("stale search error")); await tick();
  assert.equal(app.props.notice, "");
});

test("late SSH directory and tree replies cannot replace the API Location after switching back", async () => {
  const ssh = deferred();
  const app = desktop((command) => command === "ssh_list_directory" ? ssh.promise : undefined);
  app.storage.set("fileapi-session-registry", JSON.stringify([{ id: "workspace", name: "test", sshEntries: [{ id: "ssh-A", name: "SSH A", host: "ssh.test", port: 22, username: "user" }] }]));
  nodes(app.render(), (node) => node.props?.label === "LocationID")[0].props.onSelect("ssh:ssh-A"); app.render();
  assert.equal(app.calls.filter((call) => call.command === "ssh_list_directory").length, 2);
  nodes(app.render(), (node) => node.props?.label === "LocationID")[0].props.onSelect("location:A"); app.render(); await tick();
  ssh.resolve({ path: "/", files: [{ name: "stale-ssh", path: "/stale-ssh", isDirectory: true, size: 0 }] }); await tick();
  assert.doesNotMatch(text(app.render()), /stale-ssh/);
  assert.ok(app.calls.some((call) => call.args.url?.includes("/api/files?")));
});

test("late folder-tree replies cannot cross a Location switch", async () => {
  const tree = deferred();
  const app = desktop((_command, args) => args.url?.endsWith("&sort=name&order=asc") ? tree.promise : undefined);
  nodes(app.render(), (node) => node.props?.label === "LocationID")[0].props.onSelect("location:A"); app.render(); await tick();
  nodes(app.render(), (node) => node.props?.label === "LocationID")[0].props.onSelect("location:B"); app.render();
  tree.resolve(nativeJson({ files: [{ name: "stale-tree", path: "stale-tree", isDirectory: true, size: 0 }] })); await tick();
  assert.doesNotMatch(text(app.render()), /stale-tree/);
});

const mutationFiles = [
  { path: "a/same", name: "same", isDirectory: false, size: 1 },
  { path: "b/other", name: "other", isDirectory: false, size: 1 },
];
const requestBody = (call) => JSON.parse(new TextDecoder().decode(Uint8Array.from(call.args.body)));
const clickAction = (app, label) => nodes(app.render(), (node) => node.type === "button" && text(node) === label)[0].props.onClick();
const startMove = async (app) => {
  app.search("selection"); await tick();
  clickAction(app, "Select all");
  const row = nodes(app.render(), (node) => node.props?.["data-path"] === mutationFiles[0].path)[0];
  row.props.onDragStart({ dataTransfer: { setData() {} }, altKey: false }); app.render();
  nodes(app.render(), (node) => node.props?.className?.startsWith("tree-node") && node.props.onDropCapture)[0].props.onDropCapture({ preventDefault() {}, stopPropagation() {} });
};

test("production partial move uses captured cookie admin ID 0 context and records only confirmed actual destinations", async () => {
  const app = desktop((_command, args) => {
    if (args.url?.includes("/search?")) return nativeJson({ files: mutationFiles });
    if (args.url?.endsWith("/paste")) return nativeJson({ success: false, processedItems: ["same"], results: [
      { path: "a/same", success: true, targetPath: "same_(1)" },
      { path: "b/other", success: false, error: "denied" },
    ] }, 207);
  });
  app.props.session.locationRevision = "root-A";
  await startMove(app); await tick();
  const paste = app.calls.find((call) => call.args.url?.endsWith("/paste"));
  assert.equal(paste.args.sessionId, "opaque-A");
  assert.equal(paste.args.url, "https://server.test:9443/api/files/paste");
  assert.deepEqual(Object.fromEntries(new Headers(paste.args.headers)), { "x-location-id": "A", "x-location-revision": "root-A", "content-type": "application/json" });
  assert.equal(requestBody(paste).sourceLocationId, "A");
  assert.equal(requestBody(paste).targetLocationId, "A");
  assert.equal(app.props.session.userId, 0);
  assert.match(app.props.notice, /1\/2 moves confirmed; 1 failed; 0 unconfirmed/);
  clickAction(app, "Undo"); await tick();
  const undo = app.calls.find((call) => call.args.url?.endsWith("/move"));
  assert.deepEqual(requestBody(undo), { sourcePath: "same_(1)", destinationPath: "a/same", sourceLocationId: "A", targetLocationId: "A" });
  assert.equal(nodes(app.render(), (node) => node.type === "button" && text(node) === "Undo")[0].props.disabled, true);
});

test("production moves never infer partial identities from 207, processed names, missing or conflicting results", async () => {
  for (const response of [
    nativeJson({ success: false, processedItems: ["same"] }, 207),
    nativeJson({ success: true, processedItems: ["same"] }),
    nativeJson({ success: true, results: [] }),
    nativeJson({ success: true, results: [{ path: "a/same", success: true }, { path: "a/same", success: false }] }, 207),
    nativeJson({ success: true, results: [{ path: "elsewhere/same", success: true }] }, 207),
  ]) {
    const app = desktop((_command, args) => args.url?.includes("/search?") ? nativeJson({ files: mutationFiles }) : args.url?.endsWith("/paste") ? response : undefined);
    await startMove(app); await tick();
    assert.match(app.props.notice, /0\/2 moves confirmed; 0 failed; 2 unconfirmed/);
    assert.equal(nodes(app.render(), (node) => node.type === "button" && text(node) === "Undo")[0].props.disabled, true);
  }
});

test("production late moves cannot refresh or attach undo to another server, owner, handle, Location or revision", async () => {
  for (const replacement of [{ host: "other.test" }, { userId: 2 }, { nativeSessionId: "opaque-B" }, { locationId: "B" }, { locationRevision: "root-B" }]) {
    const pending = deferred();
    const app = desktop((_command, args) => args.url?.includes("/search?") ? nativeJson({ files: mutationFiles }) : args.url?.endsWith("/paste") ? pending.promise : undefined);
    app.props.session.locationRevision = "root-A";
    await startMove(app);
    app.props.session = { ...app.props.session, ...replacement }; app.render();
    app.props.notice = "new context notice";
    pending.resolve(nativeJson({ success: true, results: mutationFiles.map((item) => ({ path: item.path, success: true })) })); await tick();
    assert.equal(app.props.notice, "new context notice");
    assert.equal(app.calls.filter((call) => call.args.url?.includes("/api/files?")).length, 0);
    assert.equal(nodes(app.render(), (node) => node.type === "button" && text(node) === "Undo")[0].props.disabled, true);
  }
});

test("production move completion does not replace a newer search in the same Location", async () => {
  const pending = deferred();
  const app = desktop((_command, args) => args.url?.includes("/search?") ? nativeJson({ files: mutationFiles }) : args.url?.endsWith("/paste") ? pending.promise : undefined);
  await startMove(app); app.search("new-query"); await tick();
  pending.resolve(nativeJson({ success: false, results: [{ path: "a/same", success: true }] }, 207)); await tick();
  assert.match(text(app.render()), /new-query/);
  assert.equal(app.calls.filter((call) => call.args.url?.includes("/api/files?")).length, 0);
});

test("production delete counts authoritative path results, not summary counts or HTTP 207", async () => {
  const files = mutationFiles.map((item) => ({ ...item, path: `a/${item.name}` }));
  for (const response of [
    nativeJson({ success: false, deletedCount: 2, failedCount: 0, results: [{ path: "a/same", success: true }, { path: "a/other", success: false }] }, 207),
    nativeJson({ success: true, deletedCount: 2, results: [{ path: "a/same", success: true }, { path: "a/other", success: false }] }),
  ]) {
    const app = desktop((_command, args) => args.url?.includes("/search?") ? nativeJson({ files }) : args.url?.endsWith("/delete") ? response : undefined);
    app.search("selection"); await tick(); clickAction(app, "Select all"); clickAction(app, "Delete"); await tick();
    assert.match(app.props.notice, /1\/2 deletions confirmed; 1 failed; 0 unconfirmed/);
  }
});

test("production delete preserves missing results as unconfirmed and stops unsent groups on context change", async () => {
  const pending = deferred();
  const app = desktop((_command, args) => args.url?.includes("/search?") ? nativeJson({ files: mutationFiles }) : args.url?.endsWith("/delete") ? pending.promise : undefined);
  app.search("selection"); await tick(); clickAction(app, "Select all"); clickAction(app, "Delete");
  app.props.session = { ...app.props.session, userId: 2, nativeSessionId: "opaque-B" }; app.render(); app.props.notice = "new account notice";
  pending.resolve(nativeJson({ success: false, deletedCount: 1, results: [] }, 207)); await tick();
  assert.equal(app.calls.filter((call) => call.args.url?.endsWith("/delete")).length, 1);
  assert.equal(app.props.notice, "new account notice");
  assert.equal(app.calls.filter((call) => call.args.url?.includes("/api/files?")).length, 0);
  const log = app.calls.find((call) => call.command === "append_structured_operation_log" && call.args.event === "unconfirmed");
  assert.match(log.args.detail, /0\/2 deletions confirmed; 0 failed; 2 unconfirmed/);
});

test("production undo stays bound to the original root and does not discard an unconfirmed undo", async () => {
  const app = desktop((_command, args) => args.url?.includes("/search?") ? nativeJson({ files: mutationFiles }) : args.url?.endsWith("/move") ? nativeJson({ success: false }, 207) : undefined);
  app.props.session.locationRevision = "root-A";
  await startMove(app); await tick();
  app.props.session = { ...app.props.session, locationRevision: "root-B" }; app.render();
  clickAction(app, "Undo"); await tick();
  assert.equal(app.calls.filter((call) => call.args.url?.endsWith("/move")).length, 0);
  assert.match(app.props.notice, /previous Location root or session/);
  app.props.session = { ...app.props.session, locationRevision: "root-A" }; app.render();
  clickAction(app, "Undo"); await tick();
  assert.match(app.props.notice, /Undo was not confirmed/);
  assert.equal(nodes(app.render(), (node) => node.type === "button" && text(node) === "Undo")[0].props.disabled, false);
});

test("production lost move response remains unconfirmed without retry or speculative undo", async () => {
  const app = desktop((_command, args) => args.url?.includes("/search?") ? nativeJson({ files: mutationFiles }) : args.url?.endsWith("/paste") ? Promise.reject(new Error("response lost")) : undefined);
  await startMove(app); await tick();
  assert.equal(app.calls.filter((call) => call.args.url?.endsWith("/paste")).length, 1);
  assert.match(app.props.notice, /0\/2 moves confirmed; 0 failed; 2 unconfirmed/);
  assert.equal(nodes(app.render(), (node) => node.type === "button" && text(node) === "Undo")[0].props.disabled, true);
});

test("production delete does not infer missing per-item outcomes from a successful summary", async () => {
  const files = mutationFiles.map((item) => ({ ...item, path: `a/${item.name}` }));
  const app = desktop((_command, args) => args.url?.includes("/search?") ? nativeJson({ files }) : args.url?.endsWith("/delete") ? nativeJson({ success: true, deletedCount: 2, results: [{ path: "a/same", success: true }] }, 207) : undefined);
  app.search("selection"); await tick(); clickAction(app, "Select all"); clickAction(app, "Delete"); await tick();
  assert.match(app.props.notice, /1\/2 deletions confirmed; 0 failed; 1 unconfirmed/);
});
