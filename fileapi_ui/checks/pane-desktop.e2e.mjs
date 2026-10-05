// Visual/behavioural smoke test of the real Pane desktop. It serves the
// production build (dist/), replaces the Tauri bridge with an in-page mock and
// drives the real UI in Chromium. Run `npm run build` first.
//
//   node checks/pane-desktop.e2e.mjs [screenshot-dir]
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const dist = process.env.PANE_DIST || fileURLToPath(new URL("../dist", import.meta.url));
assert.ok(existsSync(join(dist, "index.html")), "run `npm run build` first");
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const server = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(dist, path === "/" ? "index.html" : path);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
  response.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
  response.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// In-page Tauri mock: answers just enough commands for login, Location listing and the LOCAL pane.
const bridge = () => {
  const json = (data, status = 200) => ({ status, body: Array.from(new TextEncoder().encode(JSON.stringify(data))) });
  const files = [
    { name: "Documents", path: "Documents", isDirectory: true, size: 0, modified: 1_700_000_000_000 },
    { name: "notes.txt", path: "notes.txt", isDirectory: false, size: 1234, modified: 1_700_000_000_000 },
    { name: "archive.zip", path: "archive.zip", isDirectory: false, size: 99999, modified: 1_700_000_000_000 },
  ];
  window.__calls = [];
  const handler = (cmd, args) => {
    window.__calls.push(cmd);
    switch (cmd) {
      case "create_api_session": return "opaque-1";
      case "clear_api_session": return null;
      case "api_request": {
        const url = new URL(args.url);
        if (url.pathname === "/auth/login") return json({ success: true, user: { id: 0, username: "admin", role: "admin" } });
        if (url.pathname === "/api/locations") return json({ locations: [
          { id: "default", displayName: "Default Location", status: "online", capabilities: ["read", "upload", "mkdir", "move", "rename", "delete", "share"], revision: "r1" },
          { id: "offline-box", displayName: "Offline Box", status: "offline", capabilities: [], revision: "r2" },
        ] });
        if (url.pathname.startsWith("/api/files") || url.pathname === "/api/folders") return json({ success: true, files: files.map((f) => ({ ...f })), currentPath: "" });
        return json({ success: true });
      }
      case "local_list_directory": return { path: args.path || "", files };
      case "ssh_connect": return `ssh-session-${args.profile.id}`;
      case "ssh_list_directory": {
        // Each SSH entry has its own tree so the windows can be told apart.
        const own = args.profile.id === "ssh-1" ? "alpha-only.txt" : "beta-only.txt";
        return { path: args.path || "/", files: [
          { name: "srv", path: "/srv", isDirectory: true, size: 0, modified: 1_700_000_000_000 },
          { name: own, path: `/${own}`, isDirectory: false, size: 10, modified: 1_700_000_000_000 },
        ] };
      }
      case "local_list_directories": return { path: args.path || "", directories: [{ name: "Documents", path: "Documents" }] };
      case "list_local_roots": return [];
      case "local_home_path": return "/home/test";
      case "is_elevated": return false;
      case "read_operation_logs": return [];
      case "rest_load_secret": case "proxmox_load_secret": return null;
      default: return null;
    }
  };
  let callbackId = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: () => callbackId++,
    unregisterCallback() {},
    convertFileSrc: (path) => path,
    invoke: async (cmd, args) => {
      if (cmd.startsWith("plugin:event|")) return callbackId++;
      if (cmd.startsWith("plugin:window|") || cmd.startsWith("plugin:webview|")) return cmd.endsWith("get_all_windows") || cmd.endsWith("get_all_webviews") ? [] : null;
      return handler(cmd, args || {});
    },
  };
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 760 } });
await context.addInitScript(bridge);
await context.addInitScript(() => {
  // Show the Functions menu entries for REST and VNC too.
  localStorage.setItem("nfterm-settings", JSON.stringify({ restApiModeEnabled: true, proxmoxVncModeEnabled: true }));
  // Two saved SSH entries for the SFTP window checks.
  localStorage.setItem("fileapi-session-registry", JSON.stringify([{
    id: "ws-1", name: "Lab", restApiEntries: [], proxmoxVncEntries: [],
    sshEntries: [
      { id: "ssh-1", name: "Alpha", host: "alpha.test", port: 22, username: "root", privateKeyPath: "" },
      { id: "ssh-2", name: "Beta", host: "beta.test", port: 22, username: "root", privateKeyPath: "" },
    ],
  }]));
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const shot = async (name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
const rect = (selector) => page.locator(selector).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; });

try {
  await page.goto(origin);
  await page.locator(".login-field-server input").fill("files.test");
  await page.locator(".login-field-username input").fill("admin");
  await page.locator(".login-field-password input").fill("secret");
  await page.locator("button.login-submit-button").click();
  await page.locator(".pane-desktop").waitFor({ timeout: 15000 }).catch(async (error) => {
    await shot("00-login-failed");
    console.error("page errors:", errors, "\nlogin text:", await page.locator("body").innerText());
    throw error;
  });
  await shot("01-desktop");

  // Dock: the strip is fully transparent (no bar, no top line, no divider); the launchers and
  // tabs float on their own shadowed surfaces; windows get a right/bottom drop shadow.
  const style = (selector, props) => page.locator(selector).first().evaluate((el, names) => {
    const css = getComputedStyle(el);
    return Object.fromEntries(names.map((name) => [name, css.getPropertyValue(name)]));
  }, props);
  const offsets = (shadow) => [...shadow.matchAll(/(-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]), blur: Number(match[3]) }));
  const dock = await style(".pane-dock", ["border-top-width", "background-color", "background-image", "backdrop-filter"]);
  assert.equal(dock["border-top-width"], "0px", "no line above Functions / Terminal");
  assert.equal(dock["background-color"], "rgba(0, 0, 0, 0)", "the dock strip has no background colour");
  assert.equal(dock["background-image"], "none", "the dock strip has no background gradient");
  assert.ok(["none", ""].includes(dock["backdrop-filter"]), "the dock strip has no blur");
  assert.equal((await style(".pane-taskbar", ["border-left-width"]))["border-left-width"], "0px", "no divider between launchers and tabs");
  const launcherShadow = offsets((await style(".pane-dock-icon", ["box-shadow"]))["box-shadow"]);
  assert.ok(launcherShadow.some((s) => s.x > 0 && s.y > 0 && s.blur > 0), "launchers float on a shadow");
  const tabShadow = offsets((await style(".pane-task", ["box-shadow"]))["box-shadow"]);
  assert.ok(tabShadow.some((s) => s.x > 0 && s.y > 0 && s.blur > 0), "taskbar tabs float on a shadow");
  const windowShadow = offsets((await style(".pane-window-local", ["box-shadow"]))["box-shadow"]);
  assert.ok(windowShadow.some((s) => s.x > 0 && s.y > 0 && s.blur > 0), "windows have a right/bottom drop shadow");
  // The empty dock strip lets clicks through to the window behind it.
  assert.equal((await style(".pane-dock", ["pointer-events"]))["pointer-events"], "none");
  assert.equal((await style(".pane-dock-launchers", ["pointer-events"]))["pointer-events"], "auto");

  // First launch: Local + Remote side by side, both inside the window layer.
  const layer = await rect(".pane-window-layer");
  const local = await rect(".pane-window-local");
  const remote = await rect(".pane-window-remote");
  assert.ok(local.w > 200 && remote.w > 200, "Local and Remote windows are visible");
  assert.ok(local.r <= remote.x + 1, "Local sits left of Remote");
  for (const win of [local, remote]) assert.ok(win.x >= layer.x - 1 && win.r <= layer.r + 1 && win.b <= layer.b + 1, "window stays inside the layer");
  assert.ok((await page.locator(".pane-window-local .local-pane").count()) === 1, "Local window shows the LOCAL pane");
  assert.ok((await page.locator(".pane-window-local .file-grid, .pane-window-local .local-file, .pane-window-local .file-row, .pane-window-local .file-tile").count()) > 0, "Local files are listed");
  assert.equal(await page.locator(".pane-task").count(), 2, "taskbar lists both windows");

  // Functions flyout animates in, Location opens the connection list.
  await page.locator(".pane-functions-button").click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".pane-flyout.is-open .pane-flyout-button").count(), 3, "Location, VNC and RestAPI are offered");
  await shot("02-functions");
  await page.locator(".pane-flyout-button", { hasText: "Location" }).click();
  await page.locator(".pane-location-menu").waitFor();
  const offline = page.locator(".pane-location-menu .pane-menu-item", { hasText: "Offline Box" });
  assert.equal(await offline.isDisabled(), true, "offline Location cannot be chosen");
  await shot("03-location-menu");
  await page.locator(".pane-location-menu .pane-menu-item", { hasText: "Default Location" }).click();
  assert.equal(await page.locator(".pane-flyout.is-open").count(), 0, "menu closes after choosing");

  // Window management: drag, resize, minimize/restore through the taskbar, maximize.
  const layerNow = await rect(".pane-window-layer");
  const before = await rect(".pane-window-local");
  const bar = await rect(".pane-window-local .pane-window-titlebar");
  await page.mouse.move(bar.x + 120, bar.y + bar.h / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + 220, bar.y + 80, { steps: 6 });
  await page.mouse.up();
  const moved = await rect(".pane-window-local");
  // The window is almost as tall as the layer, so the vertical move is clamped to the layer edge.
  assert.ok(Math.abs(moved.x - before.x - 100) <= 2 && moved.y >= before.y && moved.b <= layerNow.b + 1, `dragging the titlebar moves the window inside the layer (${JSON.stringify({ before, bar, moved, layerNow })})`);

  const grip = await rect(".pane-window-local .pane-win-grip-se");
  await page.mouse.move(grip.x + 4, grip.y + 4);
  await page.mouse.down();
  await page.mouse.move(grip.x - 100, grip.y - 60, { steps: 6 });
  await page.mouse.up();
  const resized = await rect(".pane-window-local");
  assert.ok(Math.abs(resized.w - (moved.w - 104)) <= 3 && Math.abs(resized.h - (moved.h - 64)) <= 3, `resizing from the corner changes the size (${moved.w}x${moved.h} -> ${resized.w}x${resized.h})`);
  await shot("04-moved-resized");

  await page.locator(".pane-task", { hasText: "Local" }).locator(".pane-task-main").click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".pane-window-local.is-hidden").count(), 1, "clicking the active tab minimizes the window");
  await page.locator(".pane-task", { hasText: "Local" }).locator(".pane-task-main").click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".pane-window-local.is-hidden").count(), 0, "clicking again restores it");
  await page.locator(".pane-window-remote .pane-window-titlebar").dblclick({ position: { x: 150, y: 10 } });
  const maximized = await rect(".pane-window-remote");
  assert.ok(Math.abs(maximized.w - layer.w) <= 2 && Math.abs(maximized.h - layer.h) <= 2, "double-click maximizes to the full layer");
  await shot("05-maximized");
  await page.locator(".pane-window-remote .pane-window-control", { has: page.locator("svg") }).nth(1).click();

  // Terminal window: opens from the dock, hides with its tab and keeps its box when minimized.
  await page.locator(".pane-dock-launchers > .pane-dock-button", { hasText: "Terminal" }).click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".pane-window-terminal:not(.is-hidden)").count(), 1, "Terminal window opens");
  const terminalBefore = await rect(".pane-window-terminal");
  await page.locator(".pane-window-terminal .pane-window-control").first().click();
  const terminalHidden = await rect(".pane-window-terminal");
  assert.deepEqual(terminalHidden, terminalBefore, "a minimized terminal keeps its layout box (xterm is not resized to 0)");
  await page.locator(".pane-task", { hasText: "Terminal" }).locator(".pane-task-main").click();
  await shot("06-terminal");

  // REST and VNC open from Functions and stay out of the way of the dock.
  for (const [label, cls] of [["RestAPI", "rest"], ["VNC", "vnc"]]) {
    await page.locator(".pane-functions-button").click();
    await page.waitForTimeout(450);
    await page.locator(".pane-flyout-button", { hasText: label }).click();
    await page.locator(`.pane-window-${cls}:not(.is-hidden)`).waitFor();
    const win = await rect(`.pane-window-${cls}`);
    const dock = await rect(".pane-dock");
    const layerNow = await rect(".pane-window-layer");
    // The launchers float over the bottom edge of the window area by a small, fixed amount;
    // a window never leaves the window area, so it never reaches below that overlap.
    assert.ok(win.b <= layerNow.b + 1, `${label} window stays inside the window area`);
    assert.ok(layerNow.b - dock.y <= 16, `${label}: the floating dock overlaps the window area by at most 16px`);
  }
  await shot("07-rest-vnc");

  // Right-click inside a window opens the Location context menu without a native menu.
  await page.locator(".pane-window-local .pane-window-titlebar").click({ position: { x: 200, y: 10 } });
  await page.locator(".pane-window-local .local-file, .pane-window-local .file-tile, .pane-window-local .file-row").first().click({ button: "right" });
  assert.equal(await page.locator(".context-menu").count(), 1, "right-click opens the context menu");
  await page.keyboard.press("Escape");

  // SFTP windows: an SSH entry must be connected in the Terminal first; then each entry gets its own window.
  await page.locator(".pane-functions-button").click();
  await page.waitForTimeout(450);
  await page.locator(".pane-flyout-button", { hasText: "Location" }).click();
  const alphaBefore = page.locator(".pane-location-menu .pane-menu-item", { hasText: "Alpha" });
  assert.equal(await alphaBefore.isDisabled(), true, "an SSH entry that is not connected cannot be opened as SFTP");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const terminalTab = page.locator(".pane-task", { hasText: "Terminal" }).locator(".pane-task-main");
  await terminalTab.click();
  await page.waitForTimeout(250);
  if (await page.locator(".pane-window-terminal.is-hidden").count()) { await terminalTab.click(); await page.waitForTimeout(250); }
  await page.locator(".pane-window-terminal:not(.is-hidden)").waitFor();
  // The Workspaces quick list is open by default; connect both saved entries from it.
  await page.locator(".pane-window-terminal .ssh-quick-list").waitFor();
  for (const name of ["Alpha", "Beta"]) {
    await page.locator(".ssh-quick-list-entry", { hasText: name }).click();
    await page.waitForTimeout(300);
  }
  const openSftp = async (name) => {
    await page.locator(".pane-functions-button").click();
    await page.waitForTimeout(450);
    await page.locator(".pane-flyout-button", { hasText: "Location" }).click();
    const item = page.locator(".pane-location-menu .pane-menu-item", { hasText: name });
    await page.waitForFunction((label) => [...document.querySelectorAll(".pane-location-menu .pane-menu-item")].some((el) => el.textContent.includes(label) && !el.disabled), name, { timeout: 8000 });
    await item.click();
  };
  await openSftp("Alpha");
  await page.locator(".pane-window-sftp").first().waitFor();
  await openSftp("Beta");
  await page.waitForFunction(() => document.querySelectorAll(".pane-window-sftp").length === 2);
  assert.equal(await page.locator(".pane-window-sftp").count(), 2, "two SSH entries open two SFTP windows");
  assert.equal(await page.locator(".pane-task", { hasText: "SFTP" }).count(), 2, "each SFTP window has its own taskbar tab");
  await page.locator('.pane-window-sftp[data-window-id="sftp:ssh-1"] .file-row[data-path="/alpha-only.txt"]').waitFor();
  await page.locator('.pane-window-sftp[data-window-id="sftp:ssh-2"] .file-row[data-path="/beta-only.txt"]').waitFor();
  assert.equal(await page.locator('.pane-window-sftp[data-window-id="sftp:ssh-1"] .file-row[data-path="/beta-only.txt"]').count(), 0, "each window lists only its own entry");
  await shot("08-two-sftp-windows");

  // Choosing an entry that already has a window raises it instead of opening a third one.
  await openSftp("Alpha");
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".pane-window-sftp").count(), 2, "re-opening an entry does not duplicate its window");

  // Closing one SFTP window disconnects only that entry and removes only its tab.
  const disconnectsBefore = await page.evaluate(() => window.__calls.filter((cmd) => cmd === "ssh_sftp_disconnect").length);
  await page.locator(".pane-task", { hasText: "Beta" }).locator(".pane-task-close").click();
  await page.waitForFunction(() => document.querySelectorAll(".pane-window-sftp").length === 1);
  assert.equal(await page.locator(".pane-task", { hasText: "SFTP · Beta" }).count(), 0, "closing removes that SFTP tab");
  assert.equal(await page.locator(".pane-task", { hasText: "SFTP · Alpha" }).count(), 1, "the other SFTP window stays");
  assert.equal(await page.evaluate(() => window.__calls.filter((cmd) => cmd === "ssh_sftp_disconnect").length), disconnectsBefore + 1, "the closed window released its SFTP connection");

  // Closing a window removes its tab.
  await page.locator(".pane-task", { hasText: "VNC" }).locator(".pane-task-close").click();
  assert.equal(await page.locator(".pane-task", { hasText: "VNC" }).count(), 0, "closing removes the taskbar tab");

  // Settings -> Window shadows switches the window shadows off, but never the dock / tab shadows.
  await page.locator('button[aria-label="Settings"]').click();
  await page.locator(".settings-panel-card", { hasText: "Color theme" }).click();
  await page.locator(".settings-check", { hasText: "Window shadows" }).locator("input").uncheck();
  assert.equal(await page.locator(".explorer.pane-shadow-off").count(), 1, "the shadow switch is applied to the desktop");
  assert.equal((await style(".pane-window-local", ["box-shadow"]))["box-shadow"], "none", "window shadow is gone when switched off");
  assert.ok(offsets((await style(".pane-dock-icon", ["box-shadow"]))["box-shadow"]).some((s) => s.blur > 0), "launchers keep their 3D shadow");
  assert.ok(offsets((await style(".pane-task", ["box-shadow"]))["box-shadow"]).some((s) => s.blur > 0), "tabs keep their 3D shadow");
  await shot("09-shadows-off");
  await page.locator(".settings-check", { hasText: "Window shadows" }).locator("input").check();
  assert.equal(await page.locator(".explorer.pane-shadow-off").count(), 0, "switching back on restores the shadows");

  // Every Settings panel shows exactly its own sections (Interface features keeps the REST API / VNC switches).
  const visibleHeadings = () => page.locator(".settings-modal .settings-section h3:visible").allTextContents();
  await page.locator(".settings-subpanel-back").first().click();
  const panels = [
    ["Color theme", ["Color theme", "Desktop wallpaper"]],
    ["Interface features", ["Interface features"]],
    ["Risk confirmations", ["Risk confirmations"]],
    ["Sharing", ["Sharing"]],
    ["History and operation log", ["History and operation log"]],
  ];
  for (const [card, headings] of panels) {
    await page.locator(".settings-panel-card", { hasText: card }).first().click();
    assert.deepEqual(await visibleHeadings(), headings, `${card} panel shows its own sections`);
    if (card === "Interface features") {
      assert.equal(await page.locator(".settings-check", { hasText: "Enable REST API mode" }).count(), 1, "REST API switch is in Interface features");
      assert.equal(await page.locator(".settings-check", { hasText: "Enable Proxmox VNC mode" }).count(), 1, "VNC switch is in Interface features");
    }
    await page.locator(".settings-subpanel-back").first().click();
  }
  await page.keyboard.press("Escape");
  await page.locator(".modal-cover, .floating-dialog-layer").first().waitFor({ state: "detached", timeout: 3000 }).catch(() => undefined);

  const ignorable = /Failed to load resource|ResizeObserver|favicon/;
  const real = errors.filter((message) => !ignorable.test(message));
  assert.deepEqual(real, [], `no page errors: ${real.join(" | ")}`);
  console.log("PASS: Pane desktop smoke test");
} finally {
  await browser.close();
  server.close();
}
