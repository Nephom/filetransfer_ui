const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createRequire, wrap } = require('node:module');
const { runInThisContext } = require('node:vm');
const { EventEmitter } = require('node:events');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// Load source with local dependencies. Never import real config, accounts, or log sinks.
function loadFixtureModule(relativePath, overrides) {
  const filename = require.resolve(relativePath);
  const localRequire = createRequire(filename);
  const fixtureModule = { exports: {} };
  const fixtureRequire = (name) => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name);
  runInThisContext(wrap(readFileSync(filename, 'utf8')), { filename })(
    fixtureModule.exports, fixtureRequire, fixtureModule, filename, path.dirname(filename)
  );
  return fixtureModule.exports;
}

function createFixture() {
  const settings = { 'auth.username': 'fixture-admin', 'auth.password': 'fixture-admin-password' };
  const config = { get: (key) => settings[key] };
  const logger = { systemLogger: { logSystem() {} } };
  const forbiddenIO = async () => { throw new Error('Fixture must not access account storage'); };
  const manager = loadFixtureModule('./user-manager', {
    '../config': config,
    '../utils/logger': logger,
    fs: { promises: { readFile: forbiddenIO, writeFile: forbiddenIO } }
  });
  manager.initialized = true;
  manager.saltRounds = 4;
  const snapshots = [];
  manager.saveUsers = async () => snapshots.push(structuredClone([...manager.users.values()]));
  const regular = {
    id: 7, username: 'fixture-user', password: bcrypt.hashSync('fixture-password', 4),
    email: 'fixture@example.test', role: 'user', active: true,
    permissions: ['read'], roleId: 'reader', locationPermissions: { team: ['read'] },
    created: 'fixture-created', lastLogin: null
  };
  manager.users.set(regular.username, regular);
  const auth = loadFixtureModule('../middleware/auth', {
    '../config': config,
    '../auth/user-manager': manager
  });
  const secret = 'fixture-only-jwt-signing-key';
  auth.setJwtSecret(secret);
  const sign = (claims) => jwt.sign(claims, secret, { expiresIn: '1h' });
  return { manager, snapshots, regular, auth, sign, secret, settings };
}

async function invoke(middleware, headers = {}, extra = {}) {
  const req = { headers, ...extra };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  let passed = false;
  await middleware(req, res, () => { passed = true; });
  return { req, res, passed };
}

test('updates only typed editable fields, retains immutable metadata, and clears Permission Roles', async () => {
  const { manager, regular, snapshots } = createFixture();
  const updates = {
    id: regular.id, username: regular.username, email: 'edited@example.test',
    password: 'new-fixture-password', role: 'superuser', active: false,
    permissions: ['copy', 'copy'], locationPermissions: { team: ['list', 'write'] }, roleId: null
  };
  const before = structuredClone(updates);
  const result = await manager.updateUser(regular.username, updates);
  assert.deepEqual(updates, before);
  assert.equal(result.id, regular.id);
  assert.equal(result.username, regular.username);
  assert.equal(result.created, regular.created);
  assert.equal(result.lastLogin, null);
  assert.equal(result.email, updates.email);
  assert.equal(result.role, 'superuser');
  assert.equal(result.active, false);
  assert.equal(result.roleId, null);
  assert.deepEqual(result.permissions, ['copy', 'read', 'write', 'delete']);
  assert.deepEqual(result.locationPermissions, updates.locationPermissions);
  assert.ok(result.updated);
  assert.equal(Object.hasOwn(result, 'password'), false);
  assert.equal(await bcrypt.compare(updates.password, manager.users.get(regular.username).password), true);
  updates.locationPermissions.team.push('delete');
  assert.deepEqual(manager.users.get(regular.username).locationPermissions.team, ['list', 'write']);
  assert.equal(snapshots.length, 1);
  assert.equal((await manager.updateUser(regular.username, { roleId: '' })).roleId, '');
  assert.deepEqual((await manager.updateUser(regular.username, { permissions: [], locationPermissions: {} })).permissions, []);
});

test('invalid updates cannot mutate records, caller data, or storage', async () => {
  const { manager, regular, snapshots } = createFixture();
  const invalid = [
    null, [], 'invalid', { username: 'fixture-admin' }, { id: 0 }, { id: '7' },
    { isConfigUser: true }, { created: 'forged' }, { lastLogin: 'forged' },
    { role: 'admin' }, { role: null }, { role: {} }, { active: 'false' }, { active: 0 },
    { email: null }, { email: [] }, { password: '' }, { password: null }, { password: 123456 },
    { permissions: 'all' }, { permissions: [true] }, { locationPermissions: null },
    { locationPermissions: [] }, { locationPermissions: { team: 'all' } },
    { locationPermissions: { team: [1] } }, { roleId: 7 }, { roleId: {} },
    { password: 'valid-new-password', active: 'false' },
    JSON.parse('{"__proto__":{"role":"admin"}}')
  ];
  const original = structuredClone(regular);
  for (const updates of invalid) {
    const before = structuredClone(updates);
    await assert.rejects(manager.updateUser(regular.username, updates));
    assert.deepEqual(updates, before);
    assert.deepEqual(manager.users.get(regular.username), original);
  }
  assert.equal(snapshots.length, 0);
});

test('blocks the staff update, impersonation login, and administrator middleware chain', async () => {
  const { manager, regular, auth, sign, snapshots } = createFixture();
  const staff = { ...regular, id: 8, username: 'fixture-staff', role: 'superuser' };
  manager.users.set(staff.username, staff);
  const staffHeaders = { authorization: `Bearer ${sign({ id: staff.id, username: staff.username, role: staff.role })}` };
  assert.equal((await invoke(auth.requireStaffRole, staffHeaders)).passed, true);
  await assert.rejects(manager.updateUser(regular.username, { username: 'fixture-admin', id: 0 }), /immutable/);
  assert.equal((await invoke(auth.requireAdmin, staffHeaders)).res.statusCode, 403);

  // Represent a previously corrupted in-memory record without repairing or saving it.
  manager.users.set(regular.username, { ...regular, username: 'fixture-admin' });
  assert.equal(await manager.authenticateUser(regular.username, 'fixture-password'), null);
  assert.equal(snapshots.length, 0);
  const forged = sign({ id: regular.id, username: 'fixture-admin', role: 'admin' });
  assert.equal((await invoke(auth.requireAdmin, { authorization: `Bearer ${forged}` })).res.statusCode, 401);
  assert.equal(await manager.authenticateUser('fixture-admin', 'fixture-password'), null);
});

test('login rejects invalid stored identities and retains valid regular/config logins', async () => {
  const { manager, regular, snapshots } = createFixture();
  for (const fields of [{ id: 0 }, { id: null }, { username: 'another-user' }, { role: 'admin' }, { active: false }, { active: 'false' }]) {
    manager.users.set(regular.username, { ...regular, ...fields });
    assert.equal(await manager.authenticateUser(regular.username, 'fixture-password'), null);
  }
  assert.equal(snapshots.length, 0);
  manager.users.set(regular.username, regular);
  assert.equal((await manager.authenticateUser(regular.username, 'fixture-password')).id, regular.id);
  assert.equal(snapshots.length, 1);
  const admin = await manager.authenticateUser('fixture-admin', 'fixture-admin-password');
  assert.equal(admin.id, 0);
  assert.equal(admin.role, 'admin');
  assert.equal(snapshots.length, 1);
});

test('administrator resolution requires the configured username and numeric zero, not a role or config claim', async () => {
  const { auth, regular, settings } = createFixture();
  for (const identity of [
    null, {}, { username: 'fixture-admin' }, { username: 'fixture-admin', id: regular.id, isConfigUser: true },
    { username: 'fixture-admin', id: '0', role: 'admin' }, { username: regular.username, id: 0, role: 'admin' }
  ]) {
    assert.equal((await auth.resolveCurrentAccount(identity)).exists, false);
  }
  const current = await auth.resolveCurrentAccount({ username: 'fixture-admin', id: 0 });
  assert.equal(current.role, 'admin');
  assert.equal(current.user.isConfigUser, true);
  settings['auth.username'] = 'renamed-config-admin';
  assert.equal((await auth.resolveCurrentAccount({ username: 'fixture-admin', id: 0 })).exists, false);
});

test('cookie takes precedence; only real Bearer headers are accepted and body credentials are ignored', async () => {
  const { auth, regular, sign } = createFixture();
  const token = sign({ id: regular.id, username: regular.username });
  const admin = sign({ id: 0, username: 'fixture-admin' });
  for (const authorization of [`Bearer ${token}`, `bearer ${token}`]) {
    assert.equal((await invoke(auth.authenticate, { authorization })).passed, true);
  }
  const cookie = `filetransfer_session=${encodeURIComponent(token)}`;
  const result = await invoke(auth.authenticate, { cookie, authorization: `Bearer ${admin}` });
  assert.equal(result.req.user.username, regular.username);
  assert.equal((await invoke(auth.requireAdmin, { cookie, authorization: `Bearer ${admin}` })).res.statusCode, 403);
  assert.equal((await invoke(auth.requireAdmin, { cookie: `filetransfer_session=${admin}` })).passed, true);
  for (const authorization of [token, `Basic ${token}`, `BearerX ${token}`, `Bearer ${token} extra`, 'Bearer ']) {
    assert.equal((await invoke(auth.authenticate, { authorization })).res.statusCode, 401);
  }
  assert.equal((await invoke(auth.authenticate, {}, { body: { token } })).res.statusCode, 401);
  assert.equal((await invoke(auth.authenticate, { cookie: 'filetransfer_session=invalid', authorization: `Bearer ${token}` })).res.statusCode, 401);
});

test('every authenticator uses live role, active state, permissions, and identity', async () => {
  const { auth, regular, manager, sign, secret } = createFixture();
  const instance = new auth.AuthMiddleware({ verifyToken: (token) => jwt.verify(token, secret) });
  const middlewares = [auth.authenticate, instance.authenticate.bind(instance), auth.requireStaffRole, auth.requireAdmin];
  const token = sign({ id: regular.id, username: regular.username, role: 'admin', permissions: ['all'], roleId: 'stale', isConfigUser: true });
  const headers = { authorization: `Bearer ${token}` };
  for (const middleware of middlewares.slice(0, 2)) {
    const result = await invoke(middleware, headers);
    assert.equal(result.passed, true);
    assert.equal(result.req.user.role, 'user');
    assert.equal(result.req.user.isConfigUser, false);
    assert.deepEqual(result.req.user.permissions, ['read']);
    assert.equal(result.req.user.roleId, 'reader');
  }
  assert.equal((await invoke(auth.requireStaffRole, headers)).res.statusCode, 403);
  manager.users.set(regular.username, { ...regular, role: 'superuser' });
  assert.equal((await invoke(auth.requireStaffRole, headers)).passed, true);
  assert.equal((await invoke(auth.requireAdmin, headers)).res.statusCode, 403);
  manager.users.set(regular.username, regular);
  assert.equal((await invoke(instance.authorize(['admin']), {}, { user: { ...regular, role: 'admin' } })).res.statusCode, 403);

  for (const record of [
    { ...regular, active: false }, { ...regular, active: 'false' }, { ...regular, active: null },
    { ...regular, id: 99 }, { ...regular, username: 'renamed' },
    { ...regular, role: 'admin' }, null
  ]) {
    if (record) manager.users.set(regular.username, record);
    else manager.users.delete(regular.username);
    for (const middleware of middlewares) {
      const result = await invoke(middleware, headers);
      assert.equal(result.res.statusCode, 401);
      assert.equal(result.passed, false);
    }
  }
});

test('regular token IDs use exact equality and invalid signatures never reach downstream work', async () => {
  const { auth, regular, sign, secret } = createFixture();
  const tokens = [
    sign({ username: regular.username }),
    sign({ username: regular.username, id: String(regular.id) }),
    sign({ username: 'missing-user', id: regular.id }),
    jwt.sign({ username: regular.username, id: regular.id }, 'different-fixture-secret'),
    jwt.sign({ username: regular.username, id: regular.id }, secret, { expiresIn: -1 })
  ];
  for (const token of tokens) {
    const result = await invoke(auth.authenticate, { authorization: `Bearer ${token}` });
    assert.equal(result.res.statusCode, 401);
    assert.equal(result.passed, false);
  }
});

test('security handler sets preserve flags, omit unsafe-eval, and redact before logging', async () => {
  const logs = [];
  const events = [];
  const redactUrl = (url) => url.replace(/\/share\/[^/?]+/g, '/share/[REDACTED]').replace(/password=[^&]*/g, 'password=[REDACTED]');
  const security = loadFixtureModule('../middleware/security', {
    '../utils/logger': {
      systemLogger: { logSystem: (...args) => logs.push(args) },
      redactUrl, redactLogData: (data) => structuredClone(data)
    },
    '../security/security': class { logSecurityEvent(...args) { events.push(args); } },
    helmet: (options) => Object.assign((req, res, next) => next(), { options }),
    'express-rate-limit': () => (req, res, next) => next()
  });
  const values = {};
  const config = { get: (key) => values[key] };
  const disabled = security.initializeSecurity(config);
  assert.equal(disabled.securityHeaders.options.contentSecurityPolicy, false);
  assert.equal((await invoke(disabled.validateInput, {}, { body: { value: '<script' } })).passed, true);
  await invoke(disabled.requestLogger);
  assert.equal(logs.length, 0);
  Object.assign(values, {
    'security.enableSecurityHeaders': true, 'security.enableCSP': true,
    'security.enableRequestLogging': true, 'security.enableInputValidation': true
  });
  const enabled = security.initializeSecurity(config);
  const directives = enabled.securityHeaders.options.contentSecurityPolicy.directives;
  assert.equal(directives.scriptSrc.includes("'unsafe-eval'"), false);
  assert.equal(directives.scriptSrc.includes("'unsafe-inline'"), true);
  assert.equal(directives.styleSrc.includes("'unsafe-inline'"), true);
  for (const value of ['report..txt', 'folder/name..txt', 'folder.../file.txt']) {
    assert.equal((await invoke(enabled.validateInput, {}, { body: { filename: value } })).passed, true);
  }
  for (const value of ['../secret', 'folder/../secret', '..\\secret', '<script secret-password']) {
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const result = await invoke(enabled.validateInput, {}, { body: { password: value }, path: '/api/share/private-token', ip: 'fixture-ip' });
      assert.equal(result.res.statusCode, 400);
    }
  }
  const req = {
    method: 'POST', originalUrl: '/api/share/private-token?password=secret-password', ip: 'fixture-ip'
  };
  const res = new EventEmitter();
  res.statusCode = 401;
  enabled.requestLogger(req, res, () => {});
  res.emit('finish');
  assert.equal(logs.length, 2);
  const output = JSON.stringify({ logs, events });
  assert.doesNotMatch(output, /private-token|secret-password|suspiciousValue/);
  assert.match(output, /REDACTED/);
  assert.equal(req.originalUrl, '/api/share/private-token?password=secret-password');
  values['security.enableInputValidation'] = false;
  assert.equal((await invoke(security.initializeSecurity(config).validateInput, {}, { body: { value: '<script' } })).passed, true);
});
