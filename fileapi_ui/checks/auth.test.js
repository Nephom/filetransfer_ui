import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript, hookDriver, deferred, nativeJson } from "./test-utils.js";

function harness(handler = () => undefined) {
  const driver = hookDriver();
  const calls = [], secrets = new Map(), storage = new Map();
  let nextSession = 0;
  const jsx = (type, props) => ({ type, props });
  const invoke = async (command, args) => {
    calls.push({ command, args });
    const result = handler(command, args);
    if (result !== undefined) return result;
    if (command === "create_api_session") return `opaque-${++nextSession}`;
    if (command === "clear_api_session") return null;
    if (command === "rest_load_secret") return secrets.get(`${args.entryId}:${args.kind}`) ?? null;
    if (command === "rest_save_secret") { secrets.set(`${args.entryId}:${args.kind}`, args.value); return null; }
    if (command === "rest_forget_secret") { secrets.delete(`${args.entryId}:${args.kind}`); return null; }
    if (command === "api_request" && args.url.endsWith("/auth/login")) return nativeJson({ success: true, user: { id: 0, username: "admin", role: "admin" } });
    if (command === "api_request" && args.url.endsWith("/auth/logout")) return nativeJson({ success: true });
    throw new Error(`Unexpected native command: ${command}`);
  };
  const { App } = loadTypeScript("main.tsx", {
    importMeta: { env: {} },
    mocks: {
      react: driver.react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-dom/client": { createRoot: () => ({ render() {} }) },
      "react-dom": { createPortal: jsx },
      "@tauri-apps/api/core": { invoke },
      "@tauri-apps/api/event": { listen: async () => () => {} },
      "@tauri-apps/api/path": { resolveResource: async () => "fake-icon" },
      "@tauri-apps/plugin-clipboard-manager": { readText: () => { throw new Error("Unexpected clipboard access"); } },
    },
    globals: {
      document: { getElementById: () => ({}) },
      localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
      window: { innerWidth: 1280, innerHeight: 800 },
    },
  });
  const render = () => driver.render(App).props;
  const configure = (patch = {}) => { render().setSession((current) => ({ ...current, host: "server.test", username: "admin", ...patch })); render(); };
  const login = async () => { render().setPassword("test-password"); return render().onSubmit({ preventDefault() {} }); };
  return { render, configure, login, calls, secrets, storage, driver };
}

test("Location login accepts cookie admin id 0 and uses an opaque native session", async () => {
  const app = harness(); app.configure(); await app.login();
  assert.equal(app.render().session.userId, 0);
  assert.equal(app.render().session.token, "cookie");
  assert.equal(app.calls.find((call) => call.command === "api_request").args.sessionId, "opaque-1");
  assert.doesNotMatch(app.storage.get("nfterm-session"), /opaque-|test-password|cookie/);
});

test("Bearer login is preserved; malformed successful responses cannot authenticate", async () => {
  for (const data of [{ user: { id: 0, username: "admin" }, token: "bearer" }, {}, { user: { username: "admin" } }, { success: false, user: { id: 0, username: "admin" } }]) {
    const app = harness((command, args) => command === "api_request" ? nativeJson(data) : undefined);
    app.configure(); await app.login();
    assert.equal(Boolean(app.render().session.token), data.token === "bearer");
    if (!data.token) assert.ok(app.calls.some((call) => call.command === "clear_api_session"));
  }
});

test("logout clears the native session despite network failure and rejects a late refresh", async () => {
  const refresh = deferred(); let logins = 0;
  const app = harness((command, args) => {
    if (command === "api_request" && args.url.endsWith("/auth/login") && ++logins > 1) return refresh.promise;
    if (command === "api_request" && args.url.endsWith("/auth/logout")) return Promise.reject(new Error("offline"));
  });
  app.configure({ saveUserInformation: true }); await app.login();
  const refreshing = app.render().refreshSessionToken();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await assert.rejects(app.render().logoutSession(), /offline/);
  refresh.resolve(nativeJson({ user: { id: 0, username: "admin" } }));
  assert.equal(await refreshing, null);
  assert.equal(app.render().session.token, "");
  assert.ok(app.calls.some((call) => call.command === "clear_api_session" && call.args.sessionId === "opaque-1"));
});

test("credentials are bound to server/account and invalidation blocks old-password refresh", async () => {
  const app = harness(); app.configure({ saveUserInformation: true }); await app.login();
  assert.ok([...app.secrets.keys()].every((key) => key.includes("server.test:9443:admin")));
  await app.render().invalidateCredentials();
  const before = app.calls.length;
  assert.equal(await app.render().refreshSessionToken(), null);
  assert.equal(app.calls.length, before);
  assert.equal(app.secrets.size, 0);
  await app.render().logoutSession();
  app.configure({ host: "other.test", username: "other" });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(app.render().password, "");
});

test("changing the login target invalidates a pending sign-in and clears its handle", async () => {
  const pending = deferred();
  const app = harness((command) => command === "api_request" ? pending.promise : undefined);
  app.configure(); const login = app.login();
  await Promise.resolve(); await Promise.resolve();
  app.configure({ host: "other.test" });
  pending.resolve(nativeJson({ user: { id: 0, username: "admin" } }));
  await login;
  assert.equal(app.render().session.token, "");
  assert.ok(app.calls.some((call) => call.command === "clear_api_session"));
});

test("saved credentials from another origin or account are never loaded into the login draft", async () => {
  const app = harness(); app.configure({ saveUserInformation: true }); await app.login();
  await app.render().logoutSession();
  assert.equal(app.secrets.size, 2);
  app.configure({ host: "other.test" });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(app.render().password, "");
  app.configure({ host: "server.test", username: "different" });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(app.render().password, "");
});

test("logout while credential lookup is pending cannot start a refresh login", async () => {
  const lookup = deferred(); let delay = false;
  const app = harness((command) => delay && command === "rest_load_secret" ? lookup.promise : undefined);
  app.configure({ saveUserInformation: true }); await app.login();
  delay = true;
  const refreshing = app.render().refreshSessionToken();
  await app.render().logoutSession();
  lookup.resolve("test-password"); assert.equal(await refreshing, null);
  assert.equal(app.calls.filter((call) => call.args?.url?.endsWith("/auth/login")).length, 1);
});
