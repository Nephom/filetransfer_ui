const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const approvedTemp = path.join(os.tmpdir(), 'opencode');
const { LocalFileSystem } = require('./file-system/base');
const { withOperationLocks } = require('./file-system/operation-locks');
const { transferManager } = require('./transfer');
const ActualUploadAPI = require('./api/upload');
const { publicDirectory, checkBrowserBuild } = require('../../scripts/build-browser');

test('P36 actual server HTTP fixtures', { timeout: 60000 }, async t => {
  await fs.mkdir(approvedTemp, { recursive: true });
  const base = await fs.realpath(await fs.mkdtemp(path.join(approvedTemp, 'server-p36-')));
  const secret = randomBytes(32).toString('hex');
  const password = 'fixture-password-only';
  const passwordHash = await bcrypt.hash(password, 4);
  const originalCache = new Map(Object.entries(require.cache));
  const signals = ['uncaughtException', 'unhandledRejection', 'SIGINT', 'SIGTERM'];
  const originalListeners = new Map(signals.map(name => [name, process.listeners(name)]));
  const originalEnv = { ENCRYPTION_KEY: process.env.ENCRYPTION_KEY, ROLES_FILE_PATH: process.env.ROLES_FILE_PATH };
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.ROLES_FILE_PATH = path.join(base, 'roles.json');
  let config;
  let accounts;
  let saves = 0;
  let saveHook;
  let buildCheck = checkBrowserBuild;
  let app;
  let server;
  let uploadApi;
  const forbiddenCalls = [];
  const instances = [];
  const cacheEvents = [];
  const forbidden = name => () => {
    forbiddenCalls.push(name);
    throw new Error(`Fixture forbids production service: ${name}`);
  };
  const mock = (name, exports) => {
    const id = require.resolve(name);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  const configManager = {
    getConfig: () => config,
    get: key => key.split('.').reduce((value, part) => value?.[part], config),
    set(key, value) {
      const parts = key.split('.');
      const name = parts.pop();
      const section = parts.reduce((object, part) => object[part] ||= {}, config);
      section[name] = value;
    },
    async save() { saves++; await saveHook?.(); },
    // Stop accidental startup before its process.exit path; assertions below fail
    // the import regression while retaining normal fixture cleanup and TAP output.
    load() { forbiddenCalls.push('config.load'); return new Promise(() => {}); },
    initialize: forbidden('config.initialize')
  };
  const users = {
    initialize: forbidden('userManager.initialize'),
    async getUser(username) { return accounts.get(username) || null; },
    async authenticateUser(username, candidate) {
      const user = accounts.get(username);
      return user?.active && await bcrypt.compare(candidate, passwordHash) ? { ...user } : null;
    },
    async getAllUsers() { return [...accounts.values()]; },
    async getUserStats() { return { total: accounts.size }; }
  };
  // Only caching is fake. Mutations retain the real safety checks and shared locks.
  class FixtureFileSystem extends LocalFileSystem {
    constructor(root, { locationId }) {
      super({ storagePath: root });
      assert.ok(root.startsWith(base + path.sep), 'storage must stay in disposable fixtures');
      this.locationId = locationId;
      this.initializations = 0;
      this.closes = 0;
      this.cache = Object.fromEntries(['enterDirectory', 'leaveDirectory', 'refreshDirectory', 'refreshCache', 'buildGlobalIndex']
        .map(operation => [operation, async target => { cacheEvents.push({ instance: this, operation, target }); }]));
      this.cache.getIndexStatus = async () => ({ isIndexing: false });
      instances.push(this);
    }
    async initialize() { this.initializations++; await new Promise(resolve => setImmediate(resolve)); }
    async close() { this.closes++; }
    async getCacheInfo() { return { fixtureCache: this.locationId, storagePath: this.storagePath }; }
    async delete(target) {
      if (path.basename(target) === 'io-failure.txt') {
        throw Object.assign(new Error(`EACCES: denied ${target}`), { code: 'EACCES' });
      }
      return super.delete(target);
    }
    async searchFiles(query) {
      const files = [];
      const visit = async directory => {
        for (const file of await this.list(directory)) {
          if (file.name.includes(query)) files.push({ ...file, path: path.relative(this.storagePath, file.path) });
          if (file.isDirectory) await visit(file.path);
        }
      };
      await visit(this.storagePath);
      return { files };
    }
  }
  class FixtureUploadAPI extends ActualUploadAPI {
    constructor() {
      super({ tempDir: path.join(base, 'staging') });
      uploadApi = this;
    }
  }
  const logger = new Proxy({}, { get: () => () => {} });
  mock('./config', configManager);
  mock('./auth/user-manager', users);
  mock('./utils/logger', { systemLogger: logger, createLogger: () => logger, redactLogData: value => value, redactUrl: value => value });
  mock('./file-system', { EnhancedMemoryFileSystem: FixtureFileSystem });
  mock('./api/upload', FixtureUploadAPI);
  mock('../../scripts/build-browser', { publicDirectory, checkBrowserBuild: (...args) => buildCheck(...args) });
  const database = { initialize: forbidden('database.initialize'), close: forbidden('database.close') };
  const pidManager = { acquireLock: forbidden('pid.acquireLock'), releaseLock: forbidden('pid.releaseLock') };
  mock('./database/db', database);
  mock('./utils/pid-manager', pidManager);
  for (const name of ['./auth/share-manager', './auth/bulk-user-job',
    './ssl/certificate-manager', './ssl/san-manager']) {
    mock(name, new Proxy({}, { get: (_, method) => forbidden(`${name}.${String(method)}`) }));
  }

  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    for (const batch of transferManager.getAllBatches()) await transferManager.cancelBatch(batch.batchId);
    await uploadApi?.waitForIdle();
    for (const instance of instances) if (!instance.closes) await instance.close();
    for (const [name, listeners] of originalListeners) {
      for (const listener of process.listeners(name)) if (!listeners.includes(listener)) process.removeListener(name, listener);
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const key of Object.keys(require.cache)) if (!originalCache.has(key)) delete require.cache[key];
    for (const [key, value] of originalCache) require.cache[key] = value;
    await fs.rm(base, { recursive: true, force: true });
    assert.deepEqual(forbiddenCalls, [], 'no startup, config, database, credentials, or persistent singleton calls');
  });

  const fixture = async () => {
    const directory = await fs.mkdtemp(path.join(base, 'case-'));
    const root = path.join(directory, 'storage');
    const other = path.join(directory, 'other');
    await fs.mkdir(root);
    await fs.mkdir(other);
    config = {
      auth: { username: 'fixture-admin', password: passwordHash, passwordHashed: true },
      server: { host: '127.0.0.1', port: 12345 },
      security: { jwtSecret: secret, enableRateLimit: false, enableSecurityHeaders: true,
        enableInputValidation: false, enableFileUploadSecurity: false, enableRequestLogging: false, enableCSP: false },
      fileSystem: { storagePath: root, maxFileSize: 1024 * 1024, locations: [
        { id: 'default', displayName: 'Fixture', rootPath: root },
        { id: 'alias', displayName: 'Alias', rootPath: root },
        { id: 'other', displayName: 'Other', rootPath: other }
      ] },
      shareLinks: { defaultExpiration: 3600, maxExpiration: 86400 }
    };
    accounts = new Map([
      ['fixture-admin', { id: 0, username: 'fixture-admin', role: 'admin', active: true }],
      ['fixture-user', { id: 7, username: 'fixture-user', role: 'user', active: true }],
      ['fixture-staff', { id: 8, username: 'fixture-staff', role: 'superuser', active: true }]
    ].map(([name, user]) => [name, { ...user, locationPermissions: { default: ['all'], alias: ['all'], other: ['all'] } }]));
    saves = 0;
    saveHook = null;
    if (app) {
      await app.locals.configureLocationRuntime();
      await app.locals.refreshSecurity();
    }
    return { root, other, directory };
  };
  await fixture();
  app = require('./server');
  const auth = require('./middleware/auth');
  auth.setJwtSecret(secret);
  const token = (username, overrides = {}) => jwt.sign({ ...accounts.get(username), ...overrides }, secret, { expiresIn: '5m' });
  const send = async (url, { username = 'fixture-admin', method = 'GET', body, headers = {} } = {}) => {
    const outgoing = { ...(username ? { authorization: `Bearer ${token(username)}` } : {}), ...headers };
    let data = body;
    if (body !== undefined && !Buffer.isBuffer(body)) {
      data = JSON.stringify(body);
      outgoing['content-type'] = 'application/json';
    }
    if (data !== undefined) outgoing['content-length'] = Buffer.byteLength(data);
    return new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers: outgoing }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const bytes = Buffer.concat(chunks);
          let result = bytes.toString();
          try { result = JSON.parse(result); } catch {}
          resolve({ status: response.statusCode, headers: response.headers, body: result, bytes });
        });
      });
      request.setTimeout(5000, () => request.destroy(new Error(`HTTP fixture timed out: ${url}`)));
      request.on('error', reject);
      request.end(data);
    });
  };
  const status = (response, expected) => assert.equal(response.status, expected, JSON.stringify(response.body));
  const safe = response => {
    const text = JSON.stringify(response.body);
    for (const value of [base, secret, passwordHash]) assert.equal(text.includes(value), false, 'response must not expose private data');
  };
  const multipart = (filename, contents) => Buffer.from(
    `--p36-boundary\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${contents}\r\n--p36-boundary--\r\n`);
  const upload = (id, filename, contents, username = 'fixture-user') => send('/api/upload/multiple', {
    username, method: 'POST', body: multipart(filename, contents),
    headers: { 'content-type': 'multipart/form-data; boundary=p36-boundary', 'x-upload-batch-id': id, 'x-location-id': 'default' }
  });
  const reserve = (username = 'fixture-user') => send('/api/upload/batches', { username, method: 'POST', body: { path: '' } });
  const gate = () => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  };
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Fixture condition timed out');
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  await t.test('E02 import has no startup effects; listener forwards HTTP/HTTPS host and rejects bind errors', async () => {
    assert.deepEqual(forbiddenCalls, []);
    for (const [name, listeners] of originalListeners) assert.deepEqual(process.listeners(name), listeners, name);
    for (const name of ['configureLocationRuntime', 'refreshSecurity', 'listenOnHost']) assert.equal(typeof app.locals[name], 'function', name);
    for (const [port, host] of [[12345, '127.0.0.1'], [12443, '::1']]) {
      const listener = new EventEmitter();
      let args;
      listener.listen = (...received) => { args = received; queueMicrotask(() => received[2]()); return listener; };
      await app.locals.listenOnHost(listener, port, host);
      assert.deepEqual(args.slice(0, 2), [port, host]);
      assert.equal(listener.listenerCount('error'), 0);
    }
    const failure = Object.assign(new Error('fixture bind failure'), { code: 'EADDRINUSE' });
    const listener = new EventEmitter();
    listener.listen = () => { queueMicrotask(() => listener.emit('error', failure)); return listener; };
    await assert.rejects(app.locals.listenOnHost(listener, 12345, '127.0.0.1'), error => error === failure);
    assert.equal(listener.listenerCount('error'), 0);
    const throwing = new EventEmitter();
    throwing.listen = () => { throw failure; };
    await assert.rejects(app.locals.listenOnHost(throwing, 12345, '127.0.0.1'), error => error === failure);
  });
  // Missing parent hooks are a real integration blocker, not skipped coverage.
  assert.equal(typeof app.locals.configureLocationRuntime, 'function', 'parent must expose runtime hook');
  assert.equal(typeof app.locals.refreshSecurity, 'function', 'parent must expose security hook');
  server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });

  await t.test('E05 complete private shells do not require runtime or configuration initialization', async () => {
    assert.equal(instances.length, 0);
    for (const name of ['admin', 'super']) {
      const response = await send(`/${name}`, { username: null });
      status(response, 200);
      assert.deepEqual(response.bytes, await fs.readFile(path.join(__dirname, '../frontend/private', `${name}.html`)));
      assert.match(response.headers['cache-control'], /no-store/);
      assert.equal(response.headers['x-frame-options'], 'DENY');
      status(await send(`/${name}.html`, { username: null }), 404);
    }
    status(await send('/api/locations'), 503);
    assert.equal(instances.length, 0);
    assert.deepEqual(forbiddenCalls, []);
  });
  await app.locals.configureLocationRuntime();
  await app.locals.refreshSecurity();

  await t.test('E01/E05 login cookies verify numeric admin 0/user 7 and enforce current staff/admin roles', async () => {
    await fixture();
    for (const [username, id] of [['fixture-admin', 0], ['fixture-user', 7], ['fixture-staff', 8]]) {
      const login = await send('/auth/login', { username: null, method: 'POST', body: { username, password } });
      status(login, 200);
      assert.equal(login.body.user.id, id);
      const cookie = login.headers['set-cookie'][0];
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
      assert.equal(login.body.token, undefined);
      const verified = await send('/auth/verify', { username: null, method: 'POST', headers: { cookie: cookie.split(';')[0] } });
      status(verified, 200);
      assert.equal(verified.body.user.id, id);
      safe(verified);
      status(await send('/api/locations', { username: null, headers: { cookie: cookie.split(';')[0] } }), 200);
    }
    status(await send('/auth/login', { username: null, method: 'POST', body: { username: 'fixture-user', password: 'incorrect-fixture-password' } }), 401);
    status(await send('/api/locations', { username: null }), 401);
    for (const username of ['fixture-user', 'fixture-staff']) {
      status(await send('/api/settings', { username, method: 'PUT', body: { enableCSP: true } }), 403);
      status(await send('/api/admin/config', { username }), 403);
    }
    status(await send('/api/admin/users', { username: 'fixture-user' }), 403);
    status(await send('/api/admin/users', { username: 'fixture-staff' }), 200);
    status(await send('/api/admin/config'), 200);
    const stale = token('fixture-staff');
    accounts.get('fixture-staff').role = 'user';
    status(await send('/api/admin/users', { headers: { authorization: `Bearer ${stale}` } }), 403);
    status(await send('/api/admin/config', { headers: { authorization: `Bearer ${token('fixture-user', { role: 'admin' })}` } }), 403);
    status(await send('/auth/verify', { method: 'POST', headers: { authorization: `Bearer ${token('fixture-admin', { id: '0' })}` } }), 401);
    assert.equal(saves, 0);
  });

  await t.test('E01 settings reject invalid booleans without mutation and refresh security before routes', async () => {
    const f = await fixture();
    const before = structuredClone(config);
    for (const value of ['true', 1, null]) {
      status(await send('/api/settings', { method: 'PUT', body: { enableCSP: true, enableSecurityHeaders: value } }), 400);
      assert.deepEqual(config, before);
    }
    status(await send('/api/admin/config', { method: 'PUT', body: { server: { port: 22222 }, security: { enableCSP: 'false' } } }), 400);
    assert.deepEqual(config, before);
    assert.equal(saves, 0);
    const saved = await send('/api/settings', { method: 'PUT', body: { enableCSP: true, enableInputValidation: true } });
    status(saved, 200);
    assert.equal(saves, 1);
    assert.equal(config.security.enableSecurityHeaders, true, 'omitted flags must remain unchanged');
    const response = await send('/api/locations');
    status(response, 200);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.ok(response.headers['content-security-policy']);
    status(await send('/api/files', { method: 'POST', body: { path: 'blocked.txt', content: '<script>fixture</script>' } }), 400);
    await assert.rejects(fs.stat(path.join(f.root, 'blocked.txt')), { code: 'ENOENT' });
  });

  await t.test('E02 admin Location updates close old caches and reject stale revisions immediately', async () => {
    const f = await fixture();
    status(await send('/api/files'), 200);
    const previous = instances.findLast(instance => instance.storagePath === f.root);
    const initial = await send('/api/locations');
    safe(initial);
    const revision = initial.body.locations.find(location => location.id === 'default').revision;
    const reservation = await reserve();
    status(reservation, 201);
    const locations = config.fileSystem.locations.map(location => location.id === 'default' ? { ...location, rootPath: f.other } : location);
    const updated = await send('/api/admin/config', { method: 'PUT', body: { locations } });
    status(updated, 200);
    assert.ok(updated.body.updatedFields.includes('fileSystem.locations'));
    assert.equal(previous.closes, 1);
    status(await send('/api/files', { headers: { 'x-location-revision': revision } }), 409);
    status(await send(`/api/progress/batch/${reservation.body.batchId}`, { username: 'fixture-user' }), 409);
    const fresh = await send('/api/locations');
    assert.notEqual(fresh.body.locations.find(location => location.id === 'default').revision, revision);
    status(await send('/api/files', { method: 'POST', body: { path: 'new-root.txt', content: 'new root' } }), 200);
    assert.equal(await fs.readFile(path.join(f.other, 'new-root.txt'), 'utf8'), 'new root');
    await assert.rejects(fs.stat(path.join(f.root, 'new-root.txt')), { code: 'ENOENT' });
    const snapshot = structuredClone(config);
    status(await send('/api/admin/config', { method: 'PUT', body: { locations: [] } }), 400);
    assert.deepEqual(config, snapshot);
  });

  await t.test('E01 concurrent settings/config saves serialize and cannot retain another failed write', async () => {
    for (const firstEndpoint of ['/api/settings', '/api/admin/config']) {
      await fixture();
      const before = structuredClone(config);
      const started = gate();
      const hold = gate();
      const snapshots = [];
      let active = 0;
      let maxActive = 0;
      saveHook = async () => {
        maxActive = Math.max(maxActive, ++active);
        snapshots.push(structuredClone(config));
        try {
          if (snapshots.length === 1) {
            started.release();
            await hold.promise;
            throw new Error('fixture save failed');
          }
        } finally { active--; }
      };
      const first = send(firstEndpoint, { method: 'PUT', body: firstEndpoint === '/api/settings'
        ? { enableCSP: true } : { security: { enableCSP: true }, server: { port: 22222 } } });
      let second;
      let received = false;
      const observeSecond = req => { if (req.headers['x-p36-save'] === 'second') received = true; };
      try {
        await started.promise;
        server.on('request', observeSecond);
        second = send(firstEndpoint === '/api/settings' ? '/api/admin/config' : '/api/settings', {
          method: 'PUT', headers: { 'x-p36-save': 'second' }, body: firstEndpoint === '/api/settings'
            ? { security: { enableInputValidation: true } } : { enableInputValidation: true }
        });
        await until(() => received);
        // Drain auth microtasks after the second write has reached the server.
        status(await send('/api/settings'), 200);
        assert.equal(saves, 1, 'second writer must wait for the first save');
        assert.equal(config.security.enableInputValidation, false);
      } finally {
        server.removeListener('request', observeSecond);
        hold.release();
        await Promise.allSettled([first, second]);
        saveHook = null;
      }
      const failed = await first;
      status(failed, 500);
      safe(failed);
      const saved = await second;
      status(saved, 200);
      safe(saved);
      assert.equal(maxActive, 1);
      assert.equal(saves, 2);
      assert.equal(snapshots[0].security.enableCSP, true);
      assert.equal(snapshots[1].security.enableCSP, false, 'rolled-back flag must not leak into second save');
      assert.equal(snapshots[1].server.port, before.server.port);
      before.security.enableInputValidation = true;
      assert.deepEqual(config, before);
    }
  });

  await t.test('E01 config save failure restores Location/settings without closing or refreshing runtime', async () => {
    const f = await fixture();
    status(await send('/api/files'), 200);
    const live = instances.findLast(instance => instance.storagePath === f.root);
    const before = structuredClone(config);
    const locations = config.fileSystem.locations.map(location => ({ ...location, rootPath: f.other }));
    saveHook = async () => { throw new Error('fixture persistence unavailable'); };
    try {
      const failed = await send('/api/admin/config', { method: 'PUT', body: {
        locations, server: { port: 22222 }, security: { enableSecurityHeaders: false, enableCSP: true }
      } });
      status(failed, 500);
      assert.deepEqual(config, before);
      assert.equal(live.closes, 0);
      const response = await send('/api/files');
      status(response, 200);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['content-security-policy'], undefined);
      status(await send('/api/files', { method: 'POST', body: { path: 'original.txt', content: 'original root' } }), 200);
      assert.equal(await fs.readFile(path.join(f.root, 'original.txt'), 'utf8'), 'original root');
      assert.deepEqual(await fs.readdir(f.other), []);
    } finally { saveHook = null; }
    status(await send('/api/settings', { method: 'PUT', body: { enableCSP: true } }), 200);
    assert.ok((await send('/api/locations')).headers['content-security-policy']);
  });

  await t.test('E01 file limiter applies at request 51 and disabling the flag restores access', async () => {
    await fixture();
    const { fileLimiter } = require('./middleware/security');
    await fileLimiter.resetKey('127.0.0.1');
    try {
      status(await send('/api/settings', { method: 'PUT', body: { enableRateLimit: true } }), 200);
      for (let i = 0; i < 50; i++) status(await send('/api/files/cache-stats'), 200);
      const rejected = await send('/api/files');
      status(rejected, 429);
      assert.match(rejected.body.error, /Too many file operations/);
      status(await send('/api/locations'), 200);
      status(await send('/api/settings', { method: 'PUT', body: { enableRateLimit: false } }), 200);
      status(await send('/api/files'), 200);
    } finally {
      await fileLimiter.resetKey('127.0.0.1');
      await fixture();
    }
  });

  await t.test('E03 malformed names return 400 without hanging or mutating files', async malformed => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, 'keep.txt'), 'keep');
    for (const [endpoint, method, body] of [
      ['/api/files/create', 'POST', { fileName: 7 }],
      ['/api/files/create', 'POST', { fileName: 'x', currentPath: {} }],
      ['/api/folders', 'POST', { folderName: 7 }],
      ['/api/files/rename', 'PUT', { oldPath: 7, newName: 'new.txt' }],
      ['/api/files/delete', 'DELETE', { items: [null] }]
    ]) {
      await malformed.test(`${endpoint} ${JSON.stringify(body)}`, async scenario => {
        // Observe rejected route promises without letting Express 4's missing
        // async error handling abort unrelated tests. No response is fabricated:
        // a rejection destroys the request and fails with the original error.
        const handler = app._router.stack.find(layer => layer.route?.path === endpoint
          && layer.route.methods[method.toLowerCase()]).route.stack.at(-1);
        const original = handler.handle;
        let rejected;
        scenario.mock.method(handler, 'handle', (req, res, next) => Promise.resolve(original(req, res, next)).catch(error => {
          rejected = error;
          res.destroy();
        }));
        const response = await send(endpoint, { method, body }).catch(error => { throw rejected || error; });
        status(response, 400);
        assert.deepEqual(await fs.readdir(f.root), ['keep.txt']);
        assert.equal(await fs.readFile(path.join(f.root, 'keep.txt'), 'utf8'), 'keep');
      });
    }
  });

  await t.test('E02/E04 cross-Location revisions apply only to their associated source and target IDs', async () => {
    const f = await fixture();
    const listed = await send('/api/locations');
    status(listed, 200);
    const revisions = Object.fromEntries(listed.body.locations.map(location => [location.id, location.revision]));
    assert.notEqual(revisions.default, revisions.other);
    for (const operation of ['copy', 'move']) {
      const sourcePath = `${operation}.txt`;
      await fs.writeFile(path.join(f.root, sourcePath), operation);
      const body = { sourcePath, destinationPath: sourcePath, sourceLocationId: 'default', targetLocationId: 'other' };
      const headers = { 'x-location-id': 'default', 'x-location-revision': revisions.default };
      for (const stale of [{ sourceLocationRevision: 'stale' }, { targetLocationRevision: 'stale' }]) {
        status(await send(`/api/files/${operation}`, { method: 'POST', headers, body: { ...body, ...stale } }), 409);
        assert.equal(await fs.readFile(path.join(f.root, sourcePath), 'utf8'), operation);
        await assert.rejects(fs.stat(path.join(f.other, sourcePath)), { code: 'ENOENT' });
      }
      status(await send(`/api/files/${operation}`, { method: 'POST', headers, body: {
        ...body, sourceLocationRevision: revisions.default, targetLocationRevision: revisions.other
      } }), 200);
      assert.equal(await fs.readFile(path.join(f.other, sourcePath), 'utf8'), operation);
      if (operation === 'copy') assert.equal(await fs.readFile(path.join(f.root, sourcePath), 'utf8'), operation);
      else await assert.rejects(fs.stat(path.join(f.root, sourcePath)), { code: 'ENOENT' });
    }
    status(await send('/api/files/copy', { method: 'POST',
      headers: { 'x-location-id': 'other', 'x-location-revision': revisions.other }, body: {
        sourceLocationId: 'default', targetLocationId: 'other', sourcePath: 'copy.txt', destinationPath: 'target-header.txt'
      }
    }), 200);
    assert.equal(await fs.readFile(path.join(f.other, 'target-header.txt'), 'utf8'), 'copy');
  });

  await t.test('E03 search duplicate basenames use full paths; legacy rename/delete and partial failure remain truthful', async () => {
    const f = await fixture();
    for (const directory of ['a', 'b']) {
      await fs.mkdir(path.join(f.root, directory));
      await fs.writeFile(path.join(f.root, directory, 'same.txt'), directory);
    }
    const found = await send('/api/files/search?query=same');
    status(found, 200);
    assert.deepEqual(found.body.files.map(file => file.path).sort(), ['a/same.txt', 'b/same.txt']);
    const renamed = await send('/api/files/rename', { method: 'PUT', body: { oldName: 'same.txt', oldPath: 'b/same.txt', currentPath: 'a', newName: 'changed.txt' } });
    status(renamed, 200);
    assert.equal(renamed.body.path, 'b/changed.txt');
    assert.equal(await fs.readFile(path.join(f.root, 'a/same.txt'), 'utf8'), 'a');
    assert.equal(await fs.readFile(path.join(f.root, 'b/changed.txt'), 'utf8'), 'b');
    status(await send('/api/files/rename', { method: 'PUT', body: { oldName: 'changed.txt', currentPath: 'b', newName: 'same.txt' } }), 200);
    status(await send('/api/files/rename', { method: 'PUT', body: { oldPath: 'b/same.txt', newName: '../escape.txt' } }), 400);
    const deleted = await send('/api/files/delete', { method: 'DELETE', body: { currentPath: 'a', items: [{ name: 'same.txt', path: 'b/same.txt' }] } });
    status(deleted, 200);
    assert.equal(deleted.body.deletedCount, 1);
    assert.equal(await fs.readFile(path.join(f.root, 'a/same.txt'), 'utf8'), 'a');
    await assert.rejects(fs.stat(path.join(f.root, 'b/same.txt')), { code: 'ENOENT' });
    await fs.writeFile(path.join(f.root, 'a/io-failure.txt'), 'retained');
    const partial = await send('/api/files/delete', { method: 'DELETE', body: { currentPath: 'a', items: [{ name: 'same.txt' }, { name: 'io-failure.txt' }] } });
    status(partial, 207);
    assert.equal(partial.body.success, false);
    assert.equal(partial.body.deletedCount, 1);
    assert.deepEqual(partial.body.results.map(item => [item.path, item.success]), [['a/same.txt', true], ['a/io-failure.txt', false]]);
    safe(partial);
    assert.equal(await fs.readFile(path.join(f.root, 'a/io-failure.txt'), 'utf8'), 'retained');
    await assert.rejects(fs.stat(path.join(f.root, 'a/same.txt')), { code: 'ENOENT' });
  });

  await t.test('E04 cross-Location same-object move and cut never delete the only file', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, 'only.txt'), 'sole copy');
    for (const [endpoint, body] of [
      ['/api/files/move', { sourcePath: 'only.txt', destinationPath: 'only.txt', sourceLocationId: 'default', targetLocationId: 'alias' }],
      ['/api/files/paste', { items: [{ name: 'only.txt', path: 'only.txt' }], operation: 'cut', targetPath: '', sourceLocationId: 'default', targetLocationId: 'alias' }]
    ]) {
      const response = await send(endpoint, { method: 'POST', body });
      assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(response.body));
      assert.equal(await fs.readFile(path.join(f.root, 'only.txt'), 'utf8'), 'sole copy');
      safe(response);
    }
    status(await send('/api/files/move', { method: 'POST', body: { sourcePath: 'only.txt', destinationPath: 'moved.txt', sourceLocationId: 'default', targetLocationId: 'other' } }), 200);
    assert.equal(await fs.readFile(path.join(f.other, 'moved.txt'), 'utf8'), 'sole copy');
    await assert.rejects(fs.stat(path.join(f.root, 'only.txt')), { code: 'ENOENT' });
  });

  await t.test('E04 subtree copy is rejected before creating a recursive destination', async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.root, 'tree'));
    await fs.writeFile(path.join(f.root, 'tree/leaf.txt'), 'leaf');
    const response = await send('/api/files/copy', { method: 'POST', body: { sourcePath: 'tree', destinationPath: 'tree/nested', sourceLocationId: 'default', targetLocationId: 'alias' } });
    assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(response.body));
    assert.deepEqual(await fs.readdir(path.join(f.root, 'tree')), ['leaf.txt']);
    safe(response);
  });

  await t.test('E04 archive/flatten/download reject nested symlinks without disclosing outside data', async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.root, 'tree'));
    await fs.writeFile(path.join(f.other, 'sentinel.txt'), 'outside-fixture-sentinel');
    await fs.symlink(f.other, path.join(f.root, 'tree/linked'));
    for (const endpoint of ['/api/archive', '/api/files/flatten']) {
      const response = await send(endpoint, { method: 'POST', body: { items: [{ name: 'tree' }], currentPath: '' } });
      assert.ok(response.status >= 400 && response.status < 500, `${endpoint}: ${response.status}`);
      assert.equal(JSON.stringify(response.body).includes('outside-fixture-sentinel'), false);
      safe(response);
    }
    const download = await send('/api/files/download/tree/linked/sentinel.txt');
    assert.ok(download.status >= 400 && download.status < 500);
    safe(download);
    assert.equal(await fs.readFile(path.join(f.other, 'sentinel.txt'), 'utf8'), 'outside-fixture-sentinel');
  });

  await t.test('E04 authorized archive/flatten/download use real bytes and current read permission', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, 'data.txt'), 'payload');
    const body = { items: [{ name: 'data.txt', path: 'data.txt' }] };
    const download = await send('/api/files/download/data.txt', { username: 'fixture-user' });
    status(download, 200);
    assert.equal(download.bytes.toString(), 'payload');
    const flattened = await send('/api/files/flatten', { username: 'fixture-user', method: 'POST', body });
    status(flattened, 200);
    assert.equal(flattened.body.totalFiles, 1);
    assert.equal(flattened.body.totalBytes, Buffer.byteLength('payload'));
    assert.equal(flattened.body.files[0].remotePath, 'data.txt');
    const archive = await send('/api/archive', { username: 'fixture-user', method: 'POST', body });
    status(archive, 200);
    assert.equal(archive.bytes.subarray(0, 4).toString('hex'), '504b0304');
    accounts.get('fixture-user').locationPermissions.default = ['list'];
    for (const endpoint of ['/api/archive', '/api/files/flatten']) status(await send(endpoint, { username: 'fixture-user', method: 'POST', body }), 403);
    status(await send('/api/files/download/data.txt', { username: 'fixture-user' }), 403);
  });

  await t.test('E04 concurrent listing initializes once and keeps cache refresh scoped per Location', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, 'a.txt'), 'a');
    await fs.writeFile(path.join(f.other, 'b.txt'), 'b');
    const results = await Promise.all(Array.from({ length: 4 }, () => send('/api/files?locationId=default')));
    for (const response of results) { status(response, 200); assert.equal(response.body.files[0].path, 'a.txt'); }
    const primary = instances.filter(instance => instance.storagePath === f.root && instance.locationId === 'default');
    assert.equal(primary.length, 1);
    assert.equal(primary[0].initializations, 1);
    const other = await send('/api/files?locationId=other');
    status(other, 200);
    assert.equal(other.body.files[0].path, 'b.txt');
    const stats = await send('/api/files/cache-stats?locationId=other', { username: 'fixture-user' });
    status(stats, 200);
    assert.equal(stats.body.fixtureCache, 'other');
    assert.equal(stats.body.locationId, 'other');
    assert.equal(Object.hasOwn(stats.body, 'storagePath'), false);
    safe(stats);
    const start = cacheEvents.length;
    status(await send('/api/files/refresh-cache?locationId=other', { username: 'fixture-user', method: 'POST', body: {} }), 200);
    const events = cacheEvents.slice(start).filter(event => event.operation === 'refreshCache');
    assert.equal(events.length, 1);
    assert.equal(events[0].instance.locationId, 'other');
    const live = instances.filter(instance => !instance.closes);
    await app.locals.configureLocationRuntime();
    for (const instance of live) assert.equal(instance.closes, 1);
  });

  await t.test('E05 numeric owners reserve and upload real multipart; progress returns measured bytes only to owner', async () => {
    const f = await fixture();
    for (const username of ['fixture-admin', 'fixture-user']) {
      const reserved = await reserve(username);
      status(reserved, 201);
      const id = reserved.body.batchId;
      assert.equal(transferManager.getBatch(id).owner.id, accounts.get(username).id);
      const filename = `${username}.txt`;
      const accepted = await upload(id, filename, 'fixture payload', username);
      status(accepted, 202);
      assert.equal(accepted.body.batchId, id);
      await uploadApi.waitForIdle();
      const progress = await send(`/api/progress/batch/${id}`, { username });
      status(progress, 200);
      assert.equal(progress.body.status, 'completed');
      assert.equal(progress.body.totalSize, Buffer.byteLength('fixture payload'));
      assert.equal(progress.body.transferredSize, Buffer.byteLength('fixture payload'));
      assert.equal(progress.body.totalSizeKnown, true);
      assert.equal(progress.body.progress, 100);
      assert.equal(progress.body.successCount, 1);
      assert.equal(progress.headers['cache-control'], 'no-store');
      safe(progress);
      const transferId = transferManager.getBatch(id).files[0];
      const single = await send(`/api/progress/${transferId}`, { username });
      status(single, 200);
      safe(single);
      assert.equal(single.body.file.path, filename);
      for (const endpoint of [`/api/progress/batch/${id}`, `/api/progress/${transferId}`]) {
        status(await send(endpoint, { username: 'fixture-staff' }), 404);
        status(await send(`${endpoint}/cancel`, { username: 'fixture-staff', method: 'POST' }), 404);
      }
      assert.equal(await fs.readFile(path.join(f.root, filename), 'utf8'), 'fixture payload');
    }
  });

  await t.test('E05 shared-lock queued upload honors revocation and owner cancellation without publishing', async () => {
    const f = await fixture();
    const reserved = await reserve();
    status(reserved, 201);
    const id = reserved.body.batchId;
    let release;
    let acquired;
    const ready = new Promise(resolve => { acquired = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const lock = withOperationLocks([f.root], async () => { acquired(); await held; });
    await ready;
    try {
      status(await upload(id, 'cancelled.txt', '1234567'), 202);
      const pending = await send(`/api/progress/batch/${id}`, { username: 'fixture-user' });
      status(pending, 200);
      assert.equal(pending.body.pendingCount, 1);
      assert.equal(pending.body.totalSize, 7);
      const stale = token('fixture-user');
      accounts.get('fixture-user').locationPermissions.default = ['list'];
      status(await send(`/api/progress/batch/${id}`, { headers: { authorization: `Bearer ${stale}` } }), 403);
      status(await send(`/api/progress/batch/${id}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${stale}` } }), 403);
      accounts.get('fixture-user').locationPermissions.default = ['all'];
      const cancelled = await send(`/api/progress/batch/${id}/cancel`, { username: 'fixture-user', method: 'POST' });
      status(cancelled, 200);
      assert.equal(cancelled.body.status, 'cancelled');
      assert.equal(cancelled.body.cancelledCount, 1);
      safe(cancelled);
    } finally { release(); await lock; }
    await uploadApi.waitForIdle();
    assert.deepEqual(await fs.readdir(f.root), []);
    assert.deepEqual(await fs.readdir(uploadApi.tempDir), []);
  });

  await t.test('E05 security precedes static responses; generated public assets exclude private pages', async subtest => {
    await fixture();
    for (const endpoint of ['/admin.html', '/super.html', '/private/admin.html', '/private/super.html', '/config.ini', '/users.json']) {
      const response = await send(endpoint, { username: null });
      status(response, 404);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
    for (const endpoint of ['/admin', '/super']) {
      const response = await send(endpoint, { username: null });
      status(response, 200);
      assert.match(response.headers['cache-control'], /no-store/);
      assert.equal(response.headers['x-frame-options'], 'DENY');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
    await subtest.test('available generated browser build is served byte-for-byte', async assetTest => {
      try { await fs.access(path.join(publicDirectory, 'manifest.json')); }
      catch (error) { if (error.code === 'ENOENT') return assetTest.skip('Generated browser build unavailable; no asset-serving claim'); throw error; }
      const manifest = checkBrowserBuild();
      for (const name of ['index.html', 'share.html', manifest.entry]) {
        const response = await send(`/${name}`, { username: null });
        status(response, 200);
        assert.deepEqual(response.bytes, await fs.readFile(path.join(publicDirectory, name)));
        assert.equal(response.headers['x-content-type-options'], 'nosniff');
        assert.match(response.headers['cache-control'], name.endsWith('.js') ? /immutable/ : /no-store/);
      }
    });
  });

  await t.test('E02/E04 restart validates build, drains uploads and caches, then waits for spawn before exit', async restart => {
    for (const outcome of ['missing-build', 'spawn-error', 'spawn-success']) {
      await restart.test(outcome, async scenario => {
        // Restart intentionally leaves its app draining. Import a fresh real app
        // for each outcome rather than resetting private implementation state.
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        delete require.cache[require.resolve('./server')];
        app = require('./server');
        const f = await fixture();
        server = http.createServer(app);
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const events = [];
        const exits = [];
        const spawnCalls = [];
        const child = new EventEmitter();
        child.unref = () => events.push('unref');
        let timer;
        let running;
        let lock;
        const hold = gate();
        const databaseClosing = gate();
        const databaseHold = gate();
        const originalTimeout = global.setTimeout;
        scenario.mock.method(global, 'setTimeout', (callback, delay, ...args) => {
          if (delay !== 500) return originalTimeout(callback, delay, ...args);
          assert.equal(timer, undefined, 'one restart timer');
          timer = callback;
          events.push('timer');
          return { unref() {} };
        });
        scenario.mock.method(pidManager, 'acquireLock', async (...args) => {
          assert.deepEqual(args, ['fixture-admin', 'web']);
          events.push('acquire');
          return { success: true };
        });
        scenario.mock.method(pidManager, 'releaseLock', async () => { events.push('release'); });
        scenario.mock.method(database, 'close', async () => {
          events.push('database.close');
          databaseClosing.release();
          await databaseHold.promise;
          events.push('database.closed');
        });
        scenario.mock.method(childProcess, 'spawn', (...args) => { spawnCalls.push(args); events.push('spawn'); return child; });
        scenario.mock.method(process, 'exit', code => { exits.push(code); events.push('exit'); });
        scenario.mock.method(console, 'error', () => { events.push('reported-error'); });
        try {
          if (outcome === 'missing-build') {
            buildCheck = () => checkBrowserBuild(path.join(base, 'missing-public-build'));
            status(await send('/api/admin/service/restart', { method: 'POST' }), 500);
            assert.equal(timer, undefined);
            assert.equal(events.includes('acquire'), false);
            assert.equal(events.includes('database.close'), false);
            assert.deepEqual(spawnCalls, []);
            assert.deepEqual(exits, []);
            status(await send('/api/files'), 200);
            await app.locals.configureLocationRuntime();
            return;
          }
          checkBrowserBuild();
          for (const id of ['default', 'other', 'alias']) status(await send(`/api/files?locationId=${id}`), 200);
          const live = instances.filter(instance => instance.storagePath.startsWith(f.directory + path.sep) && !instance.closes);
          assert.equal(live.length, 3);
          for (const instance of live) {
            const close = instance.close.bind(instance);
            scenario.mock.method(instance, 'close', async () => { events.push(`close:${instance.locationId}`); await close(); });
          }
          const reserved = await reserve();
          status(reserved, 201);
          const acquired = gate();
          lock = withOperationLocks([f.root], async () => { acquired.release(); await hold.promise; });
          await acquired.promise;
          status(await upload(reserved.body.batchId, 'before-restart.txt', 'drained payload'), 202);
          const idle = uploadApi.waitForIdle.bind(uploadApi);
          const draining = gate();
          scenario.mock.method(uploadApi, 'waitForIdle', async () => {
            events.push('drain');
            draining.release();
            await idle();
            events.push('drained');
          });
          const response = await send('/api/admin/service/restart', { method: 'POST' });
          status(response, 200);
          assert.equal(response.body.success, true);
          assert.equal(typeof timer, 'function');
          assert.deepEqual(events, ['acquire', 'timer']);
          running = timer();
          await draining.promise;
          assert.deepEqual(spawnCalls, []);
          for (const instance of live) assert.equal(instance.closes, 0);
          assert.equal(events.includes('database.close'), false);
          status(await send('/api/files'), 503, 'new storage work must stop during restart');
          hold.release();
          await lock;
          await until(() => events.includes('database.close') || events.includes('release'));
          assert.equal(events.includes('database.close'), true);
          await databaseClosing.promise;
          assert.deepEqual(spawnCalls, [], 'spawn must wait for database.close to finish');
          for (const instance of live) assert.equal(instance.closes, 1);
          databaseHold.release();
          await until(() => spawnCalls.length > 0 || events.includes('release'));
          assert.equal(spawnCalls.length, 1, 'restart must reach spawn after draining, without an undefined filesystem reference');
          assert.equal(await fs.readFile(path.join(f.root, 'before-restart.txt'), 'utf8'), 'drained payload');
          for (const instance of live) assert.equal(instance.closes, 1);
          const [executable, args, options] = spawnCalls[0];
          assert.equal(executable, process.argv[0]);
          assert.deepEqual(args, process.argv.slice(1));
          assert.equal(options.detached, true);
          assert.equal(options.cwd, process.cwd());
          assert.equal(events.indexOf('drained') < events.indexOf('database.close'), true);
          for (const instance of live) assert.ok(events.indexOf(`close:${instance.locationId}`) < events.indexOf('database.close'));
          assert.ok(events.indexOf('database.closed') < events.indexOf('spawn'));
          assert.deepEqual(exits, [], 'calling spawn alone is not a successful restart');
          assert.equal(events.includes('unref'), false);
          if (outcome === 'spawn-error') {
            child.emit('error', new Error('fixture spawn failure'));
            await running;
            assert.deepEqual(exits, []);
            assert.equal(events.includes('unref'), false);
            assert.equal(events.filter(event => event === 'release').length, 1);
          } else {
            child.emit('spawn');
            await running;
            assert.deepEqual(exits, [0]);
            assert.ok(events.indexOf('unref') < events.indexOf('exit'));
            assert.equal(events.includes('release'), false);
          }
        } finally {
          hold.release();
          databaseHold.release();
          if (child.listenerCount('error')) child.emit('error', new Error('fixture cleanup'));
          await lock;
          await running;
          buildCheck = checkBrowserBuild;
        }
      });
    }
  });
});
