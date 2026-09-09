const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');
const { LocationManager, LocationPermissionManager } = require('../location');
const { ShareManager } = require('../auth/share-manager');
const { createShareRouter } = require('./share');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'share-test-'));
  const raw = new sqlite3.Database(':memory:');
  const db = {
    run: (sql, params = []) => new Promise((resolve, reject) => raw.run(sql, params, function(error) {
      if (error) reject(error); else resolve({ changes: this.changes });
    })),
    get: (sql, params = []) => new Promise((resolve, reject) => raw.get(sql, params, (error, row) => error ? reject(error) : resolve(row))),
    all: (sql, params = []) => new Promise((resolve, reject) => raw.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)))
  };
  t.after(async () => {
    await new Promise((resolve, reject) => raw.close(error => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  await db.run(`CREATE TABLE share_links (
    id INTEGER PRIMARY KEY, shareToken TEXT UNIQUE, userId TEXT, locationId TEXT,
    filePath TEXT, fileName TEXT, createdAt INTEGER, expiresAt INTEGER,
    maxDownloads INTEGER, downloadCount INTEGER, password TEXT, isActive INTEGER, lastDownloadAt INTEGER
  )`);
  await fs.writeFile(path.join(root, 'file.txt'), '0123456789');
  const logs = [];
  const logger = { logSystem: (...args) => logs.push(args), logDownload: (...args) => logs.push(args.slice(0, 3)) };
  const configManager = {
    get: () => ({ enabled: true, defaultExpiration: 3600, maxExpiration: 7200, maxDownloadsDefault: 9, allowPasswordProtection: true }),
    getConfig: () => ({ fileSystem: { storagePath: root } })
  };
  const manager = new ShareManager({ db, configManager, logger });
  return { root, db, logs, logger, configManager, manager };
}

async function serve(t, f, before = () => {}, dependencies = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { before(req, res); next(); });
  const authenticate = (req, res, next) => { req.user = { id: 'owner', username: 'owner' }; next(); };
  const router = createShareRouter({ shareManager: f.manager, configManager: f.configManager, logger: f.logger,
    auth: { authenticate, requireAdmin: authenticate }, userManager: { getAllUsers: async () => [] },
    locationPermissionManager: { locationManager: new LocationManager(f.configManager.getConfig()), assertCurrent: async () => {} },
    ...dependencies
  });
  app.use('/api', router);
  app.use((error, req, res, next) => res.status(400).json({ success: false, message: 'Invalid request' }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return Object.assign((url, init) => fetch(`http://127.0.0.1:${server.address().port}/api${url}`, init), { router });
}

const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const create = (f, options = {}) => f.manager.createShareLink('owner', 'file.txt', 'file.txt', options);

async function revisionFixture(t) {
  const f = await fixture(t);
  const configs = {};
  const permissions = {};
  for (const name of ['A', 'B']) {
    const rootPath = path.join(f.root, name);
    await fs.mkdir(rootPath);
    await fs.writeFile(path.join(rootPath, 'report.txt'), `root ${name}`);
    configs[name] = { fileSystem: { locations: [{ id: 'reports', displayName: 'Reports', rootPath }] } };
    permissions[name] = new LocationPermissionManager(new LocationManager(configs[name]));
    permissions[name].setUserResolver(async username => ({ id: 'owner', username, active: true, role: 'user',
      locationPermissions: { reports: ['share'] } }));
  }
  let config = configs.A;
  f.configManager.getConfig = () => config;
  return { ...f, configs, permissions, setConfig: name => { config = configs[name]; } };
}

test('share creation rejects an old root revision before file access; current and legacy headers work', async t => {
  const f = await revisionFixture(t);
  const oldRevision = f.permissions.A.locationManager.getRevision('reports');
  const currentRevision = f.permissions.B.locationManager.getRevision('reports');
  await f.manager.createShareLink('owner', 'report.txt', 'report.txt', { locationId: 'reports' });
  const original = await f.db.all('SELECT * FROM share_links');
  f.setConfig('B');
  let pathChecks = 0;
  class CheckedManager extends LocationManager {
    async resolveCheckedPath(...args) { pathChecks++; return super.resolveCheckedPath(...args); }
  }
  const permissionCheck = t.mock.method(f.permissions.B, 'assertCurrent');
  const request = await serve(t, f, undefined, { LocationManager: CheckedManager, locationPermissionManager: f.permissions.B });
  const stale = post({ locationId: 'reports', filePath: 'report.txt' });
  stale.headers['X-Location-Revision'] = oldRevision;
  const rejected = await request('/files/share', stale);
  assert.equal(rejected.status, 409);
  assert.equal(pathChecks, 0);
  assert.equal(permissionCheck.mock.callCount(), 0);
  assert.deepEqual(await f.db.all('SELECT * FROM share_links'), original);
  assert.doesNotMatch(await rejected.text(), new RegExp(`${f.root}|${oldRevision}|${currentRevision}`));
  for (const revision of [undefined, currentRevision]) {
    const body = post({ locationId: 'reports', filePath: 'report.txt' });
    if (revision !== undefined) body.headers['X-Location-Revision'] = revision;
    const response = await request('/files/share', body);
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(await (await request(`/share/${data.shareToken}/download`)).text(), 'root B');
  }
  const records = await f.db.all('SELECT * FROM share_links ORDER BY id');
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], original[0]);
});

test('share creation rejects mismatched permission/config snapshots without resolving accounts', async t => {
  const f = await revisionFixture(t);
  f.setConfig('B');
  const accountCheck = t.mock.method(f.permissions.A, 'userResolver');
  const request = await serve(t, f, undefined, { locationPermissionManager: f.permissions.A });
  for (const revision of [undefined, f.permissions.B.locationManager.getRevision('reports')]) {
    const body = post({ locationId: 'reports', filePath: 'report.txt' });
    if (revision !== undefined) body.headers['X-Location-Revision'] = revision;
    assert.equal((await request('/files/share', body)).status, 409);
  }
  assert.equal(accountCheck.mock.callCount(), 0);
  assert.deepEqual(await f.db.all('SELECT * FROM share_links'), []);
});

for (const phase of ['permission', 'path', 'hash', 'permission-manager-swap', 'permission-root-swap']) {
  test(`share creation fails closed when configuration or permission context changes during ${phase}`, async t => {
    const f = await revisionFixture(t);
    const revision = f.permissions.A.locationManager.getRevision('reports');
    let swap;
    if (phase === 'permission' || phase.startsWith('permission-')) {
      const original = f.permissions.A.userResolver;
      t.mock.method(f.permissions.A, 'userResolver', async (...args) => {
        const account = await original(...args);
        swap();
        return account;
      });
    }
    class CheckedManager extends LocationManager {
      async resolveCheckedPath(...args) {
        const result = await super.resolveCheckedPath(...args);
        if (phase === 'path') swap();
        return result;
      }
    }
    if (phase === 'hash') {
      const original = bcrypt.hash;
      t.mock.method(bcrypt, 'hash', async (...args) => {
        const result = await original(...args);
        swap();
        return result;
      });
    }
    const request = await serve(t, f, undefined, { LocationManager: CheckedManager, locationPermissionManager: f.permissions.A });
    let swaps = 0;
    swap = () => {
      swaps++;
      if (phase === 'permission-manager-swap') {
        request.router.setLocationPermissionManager(f.permissions.B);
      } else if (phase === 'permission-root-swap') {
        f.permissions.A.locationManager = f.permissions.B.locationManager;
      } else {
        f.setConfig('B');
        request.router.setLocationPermissionManager(f.permissions.B);
      }
    };
    const insert = t.mock.method(f.db, 'run');
    const body = post({ locationId: 'reports', filePath: 'report.txt', ...(phase === 'hash' ? { password: 'fixture-password-only' } : {}) });
    body.headers['X-Location-Revision'] = revision;
    assert.equal((await request('/files/share', body)).status, 409);
    assert.equal(swaps, 1);
    assert.equal(insert.mock.callCount(), 0);
    assert.deepEqual(await f.db.all('SELECT * FROM share_links'), []);
  });
}

test('SQLite conditional admission admits exactly the cap under concurrent attempts', async t => {
  const f = await fixture(t);
  const link = await create(f, { maxDownloads: 3 });
  const admitted = await Promise.all(Array.from({ length: 40 }, () => f.manager.admitDownload(link.shareToken)));
  assert.equal(admitted.filter(Boolean).length, 3);
  assert.equal((await f.manager.getShareLinkInfo(link.shareToken)).downloadCount, 3);
});

test('admission uses current active state, expiry, and count after validation', async t => {
  const f = await fixture(t);
  for (const sql of ['isActive = 0', 'expiresAt = 1', 'maxDownloads = 1, downloadCount = 1']) {
    const link = await create(f);
    assert.ok(await f.manager.validateShareToken(link.shareToken));
    await f.db.run(`UPDATE share_links SET ${sql} WHERE shareToken = ?`, [link.shareToken]);
    assert.equal(await f.manager.admitDownload(link.shareToken), false);
  }
});

test('explicit zero options override defaults and password metadata never includes hashes', async t => {
  const f = await fixture(t);
  const plain = await create(f, { expiresIn: 0, maxDownloads: 0 });
  const protectedLink = await create(f, { password: 'fixture-password-only' });
  assert.equal(plain.expiresAt, null);
  assert.equal(plain.maxDownloads, 0);
  assert.equal(plain.hasPassword, false);
  assert.equal(protectedLink.hasPassword, true);
  assert.equal(protectedLink.directDownloadMethod, 'POST');
  assert.equal(protectedLink.supportsDirectDownload, false);
  assert.ok((await Promise.all(Array.from({ length: 15 }, () => f.manager.admitDownload(plain.shareToken)))).every(Boolean));
  const info = await f.manager.getShareLinkInfo(protectedLink.shareToken);
  const mine = await f.manager.getUserShareLinks('owner');
  const all = await f.manager.getAllShareLinks();
  for (const record of [info, ...mine, ...all]) {
    assert.equal(record.hasPassword, record.shareToken === protectedLink.shareToken);
    assert.equal(Object.hasOwn(record, 'password'), false);
  }
  assert.doesNotMatch(JSON.stringify(f.logs), new RegExp(`${plain.shareToken}|${protectedLink.shareToken}|fixture-password-only`));
  for (const options of [{ expiresIn: -1 }, { maxDownloads: 0.5 }, { password: {} }]) {
    await assert.rejects(create(f, options), /Invalid share options/);
  }
});

test('HTTP passwordless GET, protected POST, query rejection, HEAD, and Range counts', async t => {
  const f = await fixture(t);
  const request = await serve(t, f);
  const plain = await create(f, { maxDownloads: 2 });
  const protectedLink = await create(f, { password: 'fixture-password-only' });
  const url = `/share/${plain.shareToken}/download`;
  const protectedUrl = `/share/${protectedLink.shareToken}/download`;
  assert.equal((await request(url, { method: 'HEAD' })).status, 200);
  assert.equal((await f.manager.getShareLinkInfo(plain.shareToken)).downloadCount, 0);
  const range = await request(url, { headers: { Range: 'bytes=2-4' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-length'), '3');
  assert.equal(range.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(range.headers.get('cache-control'), 'no-store');
  assert.equal(await range.text(), '234');
  assert.equal(await (await request(url)).text(), '0123456789');
  assert.equal((await request(url)).status, 410);
  assert.equal((await request(protectedUrl)).status, 401);
  assert.equal((await request(protectedUrl, { method: 'HEAD' })).status, 401);
  for (const query of ['password=fixture-password-only', '%70assword=', 'password[x]=fixture-password-only']) {
    const response = await request(`${protectedUrl}?${query}`, post({ password: 'fixture-password-only' }));
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /fixture-password-only/);
  }
  assert.equal((await request(protectedUrl, post({ password: 'wrong' }))).status, 401);
  assert.equal((await request(protectedUrl, post({ password: {} }))).status, 400);
  assert.equal((await f.manager.getShareLinkInfo(protectedLink.shareToken)).downloadCount, 0);
  assert.equal(await (await request(protectedUrl, post({ password: 'fixture-password-only' }))).text(), '0123456789');
  assert.equal((await f.manager.getShareLinkInfo(protectedLink.shareToken)).downloadCount, 1);
  const info = await (await request(`/share/${protectedLink.shareToken}/info`)).json();
  assert.equal(info.data.hasPassword, true);
  assert.equal(info.data.supportsDirectDownload, false);
  assert.equal(JSON.stringify(info).includes('password-only'), false);
});

test('HTTP races never deliver more bodies than admissions and expired/revoked links fail', async t => {
  const f = await fixture(t);
  const request = await serve(t, f);
  const link = await create(f, { maxDownloads: 2 });
  const responses = await Promise.all(Array.from({ length: 15 }, () => request(`/share/${link.shareToken}/download`)));
  assert.equal(responses.filter(response => response.status === 200).length, 2);
  await Promise.all(responses.map(response => response.arrayBuffer()));
  for (const sql of ['isActive = 0', 'expiresAt = 1']) {
    const stale = await create(f);
    await f.db.run(`UPDATE share_links SET ${sql} WHERE shareToken = ?`, [stale.shareToken]);
    assert.ok([404, 410].includes((await request(`/share/${stale.shareToken}/download`)).status));
    assert.equal((await f.manager.getShareLinkInfo(stale.shareToken)).downloadCount, 0);
  }
});

test('creation and stored tokens reject linked targets, directories, and missing files before admission', async t => {
  const f = await fixture(t);
  const request = await serve(t, f);
  await fs.mkdir(path.join(f.root, 'dir'));
  await fs.symlink(path.join(f.root, 'file.txt'), path.join(f.root, 'linked'));
  await fs.symlink(path.join(f.root, 'dir'), path.join(f.root, 'parent'));
  await fs.writeFile(path.join(f.root, 'dir', 'child'), 'inside');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'share-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'sentinel'), 'outside');
  await fs.symlink(path.join(outside, 'sentinel'), path.join(f.root, 'external'));
  await fs.symlink(path.join(outside, 'absent'), path.join(f.root, 'dangling'));
  for (const filePath of ['linked', 'parent/child', 'external', 'dangling', 'missing', 'dir']) {
    const response = await request('/files/share', post({ filePath }));
    assert.notEqual(response.status, 200, filePath);
    const stored = await f.manager.createShareLink('owner', filePath, 'file.txt');
    const download = await request(`/share/${stored.shareToken}/download`);
    assert.notEqual(download.status, 200, filePath);
    assert.doesNotMatch(await download.text(), new RegExp(`${f.root}|${outside}|${stored.shareToken}`));
    assert.equal((await f.manager.getShareLinkInfo(stored.shareToken)).downloadCount, 0);
  }
  assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'outside');
  const created = await (await request('/files/share', post({ filePath: 'file.txt', expiresIn: 0, maxDownloads: 0, password: 'fixture-password-only' }))).json();
  assert.equal(created.data.hasPassword, true);
  assert.equal(created.data.expiresAt, null);
  assert.equal(created.data.maxDownloads, 0);
});

test('stream failure consumes its admission, sends safe errors, and never logs success', async t => {
  const f = await fixture(t);
  const request = await serve(t, f, (req, res) => {
    res.download = (file, name, options, callback) => callback(new Error('synthetic stream failure'));
  });
  const link = await create(f, { maxDownloads: 1 });
  const response = await request(`/share/${link.shareToken}/download`);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('content-disposition'), null);
  assert.doesNotMatch(await response.text(), /synthetic|file\.txt/);
  assert.equal((await f.manager.getShareLinkInfo(link.shareToken)).downloadCount, 1);
  assert.ok(f.logs.some(entry => entry[1] === 'share-link' && entry[2] === false));
  assert.ok(!f.logs.some(entry => entry[1] === 'share-link' && entry[2] === true));
});

for (const panel of ['admin', 'super']) {
  test(`${panel} actual page DOM keeps hostile user/role/Location/SAN data inert and binds exact targets`, { skip: !process.env.SHARE_BROWSER_TESTS }, async t => {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const html = await fs.readFile(path.join(__dirname, `../../frontend/private/${panel}.html`), 'utf8');
    const payload = `u'\"/><img src=x onerror="window.__xss=1">/雪`;
    const role = { id: payload, name: payload, description: payload, assignedUserCount: 1, locationPermissions: {} };
    const user = { id: 'fixture', username: payload, email: payload, role: 'user', roleId: payload, permissions: [] };
    const users = [user, { username: 'config-admin', role: 'admin', isConfigUser: true }, { username: 'staff', role: 'superuser' }];
    const requests = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push({ path: url.pathname, method: request.method(), headers: request.headers(), body: request.postData() });
      if (url.pathname === `/${panel}`) return route.fulfill({ contentType: 'text/html', body: html });
      let data = { success: true, message: 'fixture response' };
      if (url.pathname === '/auth/verify') data = { user: { role: panel === 'admin' ? 'admin' : 'superuser' } };
      if (url.pathname === '/api/admin/users') data = { users };
      if (url.pathname.startsWith('/api/admin/users/')) data = { user };
      if (url.pathname === '/api/admin/roles') data = { roles: [role], locations: [{ id: payload, displayName: payload }], capabilities: ['read', payload] };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.goto(`http://fixture.test/${panel}`);
    await page.waitForFunction(() => currentUserRole !== null);
    await page.evaluate(async () => { await loadRoles({ silent: true }); await loadUsers(); openModal('userManagementModal'); });
    const row = page.locator('#usersList tbody tr').first();
    assert.equal(await row.locator('td').nth(1).textContent(), payload);
    assert.equal(await row.locator('td').nth(2).textContent(), payload);
    assert.equal(await page.locator('#usersList img').count(), 0);
    assert.equal(await page.locator('#usersList [onclick], #usersList [onchange]').count(), 0);
    await row.locator('input[type=checkbox]').check();
    assert.equal(await page.evaluate(value => selectedUsernames.has(value), payload), true);
    await row.getByRole('button', { name: 'Edit', exact: false }).click();
    await page.waitForFunction(() => document.getElementById('editUsernameDisplay').value !== '');
    assert.equal(await page.locator('#editUsernameDisplay').inputValue(), payload);
    await page.evaluate(() => closeEditUser());
    await row.getByRole('button', { name: 'Delete', exact: false }).click();
    await page.waitForFunction(() => true);
    assert.equal(await page.locator('#usersList tbody tr').nth(1).locator('button, input').count(), 0);
    if (panel === 'super') {
      assert.equal(await page.locator('#usersList tbody tr').nth(2).locator('button, input').count(), 0);
      assert.equal(await page.locator('#editUserSystemRole').count(), 0);
    }
    await page.evaluate(() => { closeModal('userManagementModal'); displayRoles(rolesCache); openModal('roleManagementModal'); });
    assert.equal(await page.locator('#rolesList tbody tr td').first().textContent(), payload);
    assert.equal(await page.locator('#rolesList img, #rolesList [onclick]').count(), 0);
    await page.locator('#rolesList').getByRole('button', { name: 'Edit', exact: false }).click();
    assert.equal(await page.locator('#roleName').inputValue(), payload);
    const cells = page.locator('#roleMatrixContainer input');
    assert.equal(await cells.count(), 2);
    assert.equal(await cells.first().getAttribute('data-location'), payload);
    assert.equal(await cells.nth(1).getAttribute('data-capability'), payload);
    await cells.nth(1).check();
    assert.deepEqual(await page.evaluate(() => collectRoleMatrix()), { [payload]: [payload] });
    assert.equal(await page.locator('#roleMatrixContainer img').count(), 0);
    if (panel === 'admin') {
      await page.evaluate(value => {
        closeModal('roleManagementModal');
        openModal('sslManagementModal');
        document.getElementById('sslActions').style.display = 'block';
        displaySANs({ ips: ['192.0.2.5', value], autoDetected: ['192.0.2.5'], hostnames: [value] });
      }, payload);
      assert.equal(await page.locator('#ipList button').count(), 1);
      assert.equal(await page.locator('#hostnameList img, #hostnameList [onclick]').count(), 0);
      assert.equal(await page.locator('#hostnameList span').first().textContent(), payload);
      await page.locator('#hostnameList button').click();
    }
    await page.waitForTimeout(50);
    const encoded = encodeURIComponent(payload);
    assert.ok(requests.some(request => request.method === 'GET' && decodeURIComponent(request.path) === `/api/admin/users/${payload}`));
    assert.ok(requests.some(request => request.method === 'DELETE' && decodeURIComponent(request.path) === `/api/admin/users/${payload}`));
    assert.ok(requests.some(request => request.path.replace(/%27/gi, "'") === `/api/admin/users/${encoded}`));
    if (panel === 'admin') assert.ok(requests.some(request => request.method === 'DELETE' && decodeURIComponent(request.path) === `/api/admin/ssl/sans/${payload}`));
    assert.ok(requests.filter(request => request.path.startsWith('/api/') || request.path === '/auth/verify').every(request => !request.headers.authorization));
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.deepEqual(errors, []);
  });
}

test('public share page posts password once, sends no referrer, and clears settled resources', { skip: !process.env.SHARE_BROWSER_TESTS }, async t => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const html = await fs.readFile(path.join(__dirname, '../../frontend/public/share.html'), 'utf8');
  const requests = [];
  let finishDownload;
  let protectedLink = true;
  await page.addInitScript(() => {
    window.__revoked = [];
    const original = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { window.__revoked.push(url); original(url); };
  });
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ url: request.url(), method: request.method(), headers: request.headers(), body: request.postData() });
    if (url.pathname === '/share.html') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname.endsWith('/info')) return route.fulfill({ json: { success: true, data: { fileName: 'fixture.txt', hasPassword: protectedLink, isActive: 1 } } });
    if (url.pathname.endsWith('/download')) {
      await new Promise(resolve => { finishDownload = resolve; });
      return route.fulfill({ contentType: 'application/octet-stream', body: 'fixture body' });
    }
    return route.abort();
  });
  await page.goto('http://fixture.test/share.html?token=fixture-share-token');
  await page.waitForFunction(() => !document.getElementById('downloadBtn').disabled);
  assert.equal(await page.locator('#passwordSection').isVisible(), true);
  await page.locator('#passwordInput').fill('fixture-password-only');
  await page.evaluate(() => { handleDownload(); handleDownload(); document.getElementById('passwordInput').dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter' })); });
  await page.waitForTimeout(50);
  assert.equal(requests.filter(request => request.url.endsWith('/download')).length, 1);
  const request = requests.find(request => request.url.endsWith('/download'));
  assert.equal(request.method, 'POST');
  assert.deepEqual(JSON.parse(request.body), { password: 'fixture-password-only' });
  assert.ok(!request.headers.referer);
  assert.ok(requests.every(request => !request.url.includes('fixture-password-only')));
  const downloaded = page.waitForEvent('download');
  finishDownload();
  await downloaded;
  await page.waitForFunction(() => !downloadPending);
  assert.equal(await page.locator('#passwordInput').inputValue(), '');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.evaluate(() => downloadUrls.size), 0);
  assert.equal(await page.evaluate(() => window.__revoked.length), 1);
  protectedLink = false;
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('downloadBtn').disabled);
  await page.locator('#downloadBtn').click();
  await page.waitForTimeout(50);
  assert.equal(requests.filter(request => request.url.endsWith('/download')).at(-1).method, 'GET');
  finishDownload();
});
