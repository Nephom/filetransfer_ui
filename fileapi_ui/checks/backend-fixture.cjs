// Test-only child for native and desktop HTTP contract tests.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const bcrypt = require('bcrypt');

async function main() {
  const approved = await fs.realpath(path.join(os.tmpdir(), 'opencode'));
  const base = await fs.realpath(process.argv[2]);
  assert.equal(path.dirname(base), approved);
  assert.match(path.basename(base), /^native-backend-[0-9a-f-]{36}$/);
  assert.deepEqual(await fs.readdir(base), [], 'The test must supply a new empty owned directory');
  const root = path.join(base, 'storage');
  const staging = path.join(base, 'staging');
  await fs.mkdir(root);
  await fs.mkdir(staging);

  const backend = path.resolve(__dirname, '../../src/backend');
  const mock = (name, exports) => {
    const id = require.resolve(path.join(backend, name));
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  const forbiddenCalls = [];
  const forbidden = name => () => {
    forbiddenCalls.push(name);
    throw new Error(`Native fixture forbids production service: ${name}`);
  };
  const secret = randomBytes(32).toString('hex');
  const passwordHash = await bcrypt.hash('native-fixture-password', 4);
  const config = {
    auth: { username: 'fixture-admin', password: passwordHash, passwordHashed: true },
    security: { jwtSecret: secret, enableRateLimit: false, enableSecurityHeaders: true,
      enableInputValidation: false, enableFileUploadSecurity: false, enableRequestLogging: false, enableCSP: false },
    fileSystem: { storagePath: root, maxFileSize: 1024 * 1024, locations: [
      { id: 'default', displayName: 'Native Fixture', rootPath: root, storageType: 'local' }
    ] },
    shareLinks: { defaultExpiration: 3600, maxExpiration: 86400 }
  };
  const accounts = new Map([
    ['fixture-admin', { id: 0, username: 'fixture-admin', role: 'admin', active: true }],
    ['fixture-user', { id: 7, username: 'fixture-user', role: 'user', active: true,
      locationPermissions: { default: ['all'] } }]
  ]);
  const logger = new Proxy({}, { get: () => () => {} });
  // Install all persistent-service replacements before importing server.js or
  // any module that could capture its singletons. No .env/config loader runs.
  mock('config', {
    getConfig: () => config,
    get: key => key.split('.').reduce((value, part) => value?.[part], config),
    load: forbidden('config.load'), initialize: forbidden('config.initialize'),
    set: forbidden('config.set'), save: forbidden('config.save')
  });
  mock('auth/user-manager', {
    initialize: forbidden('users.initialize'),
    async getUser(username) { return accounts.get(username) || null; },
    async authenticateUser(username, password) {
      const user = accounts.get(username);
      return user?.active && await bcrypt.compare(password, passwordHash) ? { ...user } : null;
    }
  });
  mock('utils/logger', { systemLogger: logger, createLogger: () => logger,
    redactLogData: value => value, redactUrl: value => value });
  for (const name of ['database/db', 'utils/pid-manager', 'auth/share-manager',
    'auth/bulk-user-job', 'ssl/certificate-manager', 'ssl/san-manager']) {
    mock(name, new Proxy({}, { get: (_, method) => forbidden(`${name}.${String(method)}`) }));
  }
  mock('../../scripts/build-browser', {
    publicDirectory: path.join(base, 'public'), checkBrowserBuild: forbidden('browser.build')
  });
  const ActualRoleManager = require(path.join(backend, 'auth/role-manager'));
  mock('auth/role-manager', class extends ActualRoleManager {
    constructor() { super(); this.rolesFilePath = path.join(base, 'roles.json'); }
    async initialize() { forbidden('roles.initialize')(); }
  });
  const { LocalFileSystem } = require(path.join(backend, 'file-system/base'));
  mock('file-system', { EnhancedMemoryFileSystem: class extends LocalFileSystem {
    constructor(storagePath) {
      assert.equal(storagePath, root);
      super({ storagePath });
      this.cache = Object.fromEntries(['enterDirectory', 'leaveDirectory', 'refreshDirectory', 'refreshCache', 'buildGlobalIndex']
        .map(name => [name, async () => {}]));
    }
    async initialize() {}
    async close() {}
  } });
  if (process.argv.includes('--desktop-mutations')) {
    const ActualFileSystem = require(path.join(backend, 'file-system/enhanced-memory'));
    mock('file-system', { EnhancedMemoryFileSystem: class extends ActualFileSystem {
      constructor(storagePath, options) {
        assert.equal(storagePath, root);
        super(storagePath, options);
        // Exercise production directory scans, indexing, locks and cache
        // invalidation. Only Redis transport/storage is replaced in this child.
        const records = new Map();
        this.cache.redisClient = {
          isReady: true,
          async *scanIterator({ MATCH }) {
            assert.ok(MATCH.endsWith('*'));
            yield [...records.keys()].filter(key => key.startsWith(MATCH.slice(0, -1)));
          },
          async set(key, value) { records.set(key, value); },
          async get(key) { return records.get(key) ?? null; },
          async hSet(key, value) { records.set(key, value); },
          async del(keys) { for (const key of [].concat(keys)) records.delete(key); },
          async quit() { this.isReady = false; }
        };
      }
    } });
  }
  const ActualUploadAPI = require(path.join(backend, 'api/upload'));
  let uploadApi;
  mock('api/upload', class extends ActualUploadAPI {
    constructor() { super({ tempDir: staging }); uploadApi = this; }
  });

  const app = require(path.join(backend, 'server'));
  const { setJwtSecret, requireAdmin } = require(path.join(backend, 'middleware/auth'));
  const { withOperationLocks } = require(path.join(backend, 'file-system/operation-locks'));
  setJwtSecret(secret);
  await app.locals.configureLocationRuntime();
  await app.locals.refreshSecurity();
  assert.deepEqual(forbiddenCalls, []);

  let held;
  const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  app.post('/__test/expired-token', requireAdmin, (_req, res) => {
    // Exercise actual authentication without changing a real clock or key.
    const jwt = require('jsonwebtoken');
    res.json({ token: jwt.sign({ id: 0, username: 'fixture-admin', role: 'admin' }, secret, { expiresIn: -1 }) });
  });
  app.post('/__test/hold', requireAdmin, route(async (_req, res) => {
    assert.equal(held, undefined, 'only one publication hold');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let acquired;
    const ready = new Promise(resolve => { acquired = resolve; });
    const job = withOperationLocks([root], async () => { acquired(); await gate; });
    held = { release, job };
    await Promise.race([ready, job.then(() => { throw new Error('Hold ended before acquisition'); })]);
    res.json({ held: true });
  }));
  app.post('/__test/release', requireAdmin, route(async (_req, res) => {
    assert.ok(held, 'a publication hold must exist');
    held.release();
    await held.job;
    held = undefined;
    await uploadApi.waitForIdle();
    res.json({ released: true });
  }));
  const inspect = async directory => {
    const result = { files: 0, bytes: 0 };
    for (const name of await fs.readdir(directory)) {
      const item = path.join(directory, name);
      const stat = await fs.lstat(item);
      assert.equal(stat.isSymbolicLink(), false, 'fixture must not traverse links');
      if (stat.isDirectory()) {
        const nested = await inspect(item);
        result.files += nested.files;
        result.bytes += nested.bytes;
      } else {
        assert.ok(stat.isFile());
        result.files++;
        result.bytes += stat.size;
      }
    }
    return result;
  };
  app.get('/__test/inspect', requireAdmin, route(async (_req, res) => {
    await uploadApi.waitForIdle();
    assert.deepEqual(forbiddenCalls, []);
    res.json({ storage: await inspect(root), staging: await inspect(staging), forbiddenCalls });
  }));
  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ fixtureError: error.message });
  });

  const server = http.createServer(app);
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  // Rust owns kill/wait and deletion, including startup failures and test panic.
  // This watchdog also bounds a child orphaned by an abruptly terminated test.
  setTimeout(() => { console.error('Native backend fixture exceeded 60 seconds'); process.exit(1); }, 60000).unref();
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
}

main().catch(error => { console.error(error); process.exit(1); });
