const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { createRequire, wrap } = require('node:module');
const { runInThisContext } = require('node:vm');
const jwt = require('jsonwebtoken');
const express = require('express');
const UploadAPI = require('./upload');
const { TransferManager } = require('../transfer');
const LocationManager = require('../location/location-manager');
const { withOperationLocks } = require('../file-system/operation-locks');

const tmp = path.join(require('node:os').tmpdir(), 'opencode');
const boundary = 'upload-test-boundary';
const auth = { authorization: 'Bearer alice', 'x-location-id': 'default' };
const pause = () => new Promise(resolve => setImmediate(resolve));
const until = async condition => {
  const end = Date.now() + 5000;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error('Test condition timed out');
    await pause();
  }
};
const gate = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};
function multipart(parts, complete = true) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename !== undefined ? `; filename="${part.filename}"` : ''}\r\n\r\n`));
    chunks.push(Buffer.from(part.value || ''));
    chunks.push(Buffer.from('\r\n'));
  }
  if (complete) chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}
const file = (name = 'a.txt', value = 'abcd', field = 'files') => ({ name: field, filename: name, value });

async function fixture(t, options = {}) {
  await fs.promises.mkdir(tmp, { recursive: true });
  const base = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(tmp, 'upload-test-')));
  const root = path.join(base, 'storage');
  await fs.promises.mkdir(root);
  const manager = new TransferManager();
  const permissions = { allowed: true, hook: null, async assertCurrent(user, id, capability) {
    if (this.hook) await this.hook(user, id, capability);
    if (!this.allowed) throw Object.assign(new Error('secret permission detail'), { statusCode: 403 });
  } };
  const config = { maxFileSize: 1024, enableFileUploadSecurity: false };
  let authCalls = 0;
  const api = new UploadAPI({
    transferManager: manager, tempDir: path.join(base, 'staging'), logger: { logSystem() {} },
    getConfig: key => key === 'fileSystem.maxFileSize' ? config.maxFileSize :
      key === 'security.enableFileUploadSecurity' ? config.enableFileUploadSecurity : undefined,
    authenticate(req, res, next) {
      authCalls++;
      const username = req.headers.authorization?.replace('Bearer ', '') || req.headers.cookie?.replace('session=', '');
      if (!['alice', 'bob'].includes(username)) return res.status(401).json({ error: 'Unauthorized' });
      req.user = { id: `id-${username}`, username };
      next();
    },
    ...options
  });
  const locations = new LocationManager({ fileSystem: { locations: [
    { id: 'default', displayName: 'Test', rootPath: root },
    { id: 'other', displayName: 'Other', rootPath: root }
  ] } });
  api.setLocationManager(locations, null, permissions);
  const app = express();
  app.use('/api', api.getRouter());
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const open = (url, headers = auth, method = 'POST') => {
    let request;
    const response = new Promise((resolve, reject) => {
      request = http.request({ host: '127.0.0.1', port: server.address().port, path: `/api${url}`, method, headers }, res => {
        const chunks = [];
        res.on('data', data => chunks.push(data));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let body;
          try { body = JSON.parse(raw); } catch { body = raw; }
          resolve({ status: res.statusCode, body, headers: res.headers });
        });
        res.on('error', reject);
      });
      request.on('error', reject);
    });
    return { request, response };
  };
  const send = async (url, body = '', headers = auth, method = 'POST') => {
    const exchange = open(url, headers, method);
    exchange.request.end(body);
    return exchange.response;
  };
  const upload = (parts, headers = auth, endpoint = '/upload/multiple', complete = true) => send(endpoint, multipart(parts, complete), {
    ...headers, 'content-type': `multipart/form-data; boundary=${boundary}`
  });
  const reserve = (body = { path: '' }, headers = auth) => send('/upload/batches', JSON.stringify(body), { ...headers, 'content-type': 'application/json' });
  const poll = (id, batch = true, headers = auth) => send(`/progress/${batch ? 'batch/' : ''}${id}`, '', headers, 'GET');
  const settled = async id => {
    await until(() => ['completed', 'failed', 'partial_fail', 'cancelled'].includes(manager.getBatch(id)?.status));
    return manager.serializeBatch(id);
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const batch of manager.getAllBatches()) await manager.cancelBatch(batch.batchId);
    await fs.promises.rm(base, { recursive: true, force: true });
  });
  return { base, root, manager, api, config, permissions, locations, open, send, upload, reserve, poll, settled, authCalls: () => authCalls };
}

test('constructor/import do not initialize filesystem, accounts, logs, or live configuration', async t => {
  const f = await fixture(t);
  assert.equal(fs.existsSync(f.api.tempDir), false);
  for (const modulePath of ['../config', '../auth/user-manager', '../utils/logger', '../file-system/base']) {
    assert.equal(require.cache[require.resolve(modulePath)], undefined, modulePath);
  }
});

test('every upload endpoint authenticates before parsing or storage; body-only credentials fail', async t => {
  const f = await fixture(t);
  for (const endpoint of ['/upload', '/upload/multiple', '/upload/single', '/upload/progress', '/upload/single-progress']) {
    const result = await f.upload([{ name: 'token', value: 'alice' }, file()], {}, endpoint);
    assert.equal(result.status, 401, endpoint);
    assert.equal(fs.existsSync(f.api.tempDir), false);
  }
  assert.equal(f.authCalls(), 5);
});

test('cookie and Bearer routes retain legacy filenames and synchronous responses', async t => {
  const f = await fixture(t);
  for (const endpoint of ['/upload/single', '/upload/progress']) {
    const result = await f.upload([file('100%中文.txt', 'abc', 'file')], { cookie: 'session=alice' }, endpoint);
    assert.equal(result.status, 200);
    assert.equal(result.body.file.name, '100%中文.txt');
    assert.equal((await f.poll(result.body.transferId, false)).body.transferredSize, 3);
  }
  assert.equal(await fs.promises.readFile(path.join(f.root, '100%中文_(1).txt'), 'utf8'), 'abc');
});

test('runtime per-file limits accept exact boundary/zero files and reject above it without aggregate reduction', async t => {
  const f = await fixture(t);
  f.config.maxFileSize = 4;
  const accepted = await f.upload([file('a.txt', '1234'), file('b.txt', '5678'), file('zero', '')]);
  assert.equal(accepted.status, 202);
  const batch = await f.settled(accepted.body.batchId);
  assert.equal(batch.totalSize, 8);
  assert.equal(batch.transferredSize, 8);
  assert.equal(batch.totalSizeKnown, true);
  assert.equal(batch.successCount, 3);
  f.config.maxFileSize = 3;
  assert.equal((await f.upload([file('oversize', '1234')])).status, 413);
  assert.equal(fs.existsSync(path.join(f.root, 'oversize')), false);
  assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
});

test('metadata after file is honored; single-progress uses payload bytes, not multipart Content-Length', async t => {
  const f = await fixture(t);
  const body = multipart([file('original.txt', '123', 'file'), { name: 'path', value: 'nested' }, { name: 'fileName', value: 'final.txt' }]);
  const result = await f.send('/upload/single-progress', body, { ...auth,
    'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length });
  assert.equal(result.status, 202);
  await until(() => f.manager.getTransfer(result.body.transferId)?.status === 'completed');
  const progress = (await f.poll(result.body.transferId, false)).body;
  assert.equal(progress.totalSize, 3);
  assert.equal(progress.transferredSize, 3);
  assert.equal(progress.file.path, 'nested/final.txt');
});

test('rejected metadata, mismatched inventory, excess files, and malformed multipart clean every staged file', async t => {
  const f = await fixture(t);
  const cases = [
    [[file(), { name: 'token', value: 'credential' }], '/upload/multiple', true, 400],
    [[file(), { name: 'path', value: '../outside' }], '/upload/multiple', true, 400],
    [[file(), { name: 'filePaths[]', value: 'one' }, { name: 'filePaths[]', value: 'two' }], '/upload/multiple', true, 400],
    [[file(), { name: 'path', value: 'x'.repeat(16385) }], '/upload/multiple', true, 413],
    [[file(), { name: 'path', value: '' }, { name: 'path', value: '' }], '/upload/multiple', true, 400],
    [[file('a', 'abc', 'file'), file('b', 'xyz', 'file')], '/upload/single-progress', true, 413],
    [[file()], '/upload/multiple', false, 400],
    [[file('a', 'abc', 'file')], '/upload/single-progress', false, 400]
  ];
  for (const [parts, endpoint, complete, status] of cases) {
    const result = await f.upload(parts, auth, endpoint, complete);
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
    assert.deepEqual(await fs.promises.readdir(f.root), []);
  }
});

test('multipart counts are bounded without reducing supported 1000-file batch size', async t => {
  const f = await fixture(t);
  const result = await f.upload(Array.from({ length: 1001 }, (_, i) => file(`${i}`, '')));
  assert.equal(result.status, 413);
  assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
  const hold = gate();
  let locked = false;
  const lock = withOperationLocks([f.root], async () => { locked = true; await hold.promise; });
  await until(() => locked);
  const accepted = await f.upload(Array.from({ length: 1000 }, (_, i) => file(`${i}`, '')));
  assert.equal(accepted.status, 202);
  assert.equal((await f.poll(accepted.body.batchId)).body.pendingCount, 1000);
  const cancelled = await f.send(`/progress/batch/${accepted.body.batchId}/cancel`);
  assert.equal(cancelled.body.cancelledCount, 1000);
  hold.release();
  await lock;
  assert.equal((await f.upload([{ name: 'directoryPaths[]', value: 'empty' }])).body.folders, 1);
});

test('permission/path rejection is awaited, cleans staging, and never exposes internal errors', async t => {
  const f = await fixture(t);
  f.permissions.allowed = false;
  const denied = await f.upload([file()]);
  assert.equal(denied.status, 403);
  assert.equal(JSON.stringify(denied.body).includes('secret'), false);
  assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
  f.permissions.allowed = true;
  const outside = path.join(f.base, 'outside');
  await fs.promises.mkdir(outside);
  await fs.promises.writeFile(path.join(outside, 'sentinel'), 'keep');
  await fs.promises.symlink(outside, path.join(f.root, 'linked'));
  const linked = await f.upload([file(), { name: 'filePaths[]', value: 'linked/sentinel' }]);
  assert.notEqual(linked.status, 202);
  assert.equal(await fs.promises.readFile(path.join(outside, 'sentinel'), 'utf8'), 'keep');
  assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
});

test('exclusive same-name uploads preserve every output and established tar.gz collision convention', async t => {
  const f = await fixture(t);
  const hold = gate();
  let locked = false;
  const lock = withOperationLocks([f.root], async () => { locked = true; await hold.promise; });
  await until(() => locked);
  const results = await Promise.all(['first', 'second', 'third'].map(value => f.upload([file('archive.tar.gz', value)])));
  for (const result of results) assert.equal(result.status, 202);
  for (const result of results) assert.equal((await f.poll(result.body.batchId)).body.pendingCount, 1);
  hold.release();
  await lock;
  await Promise.all(results.map(result => f.settled(result.body.batchId)));
  const names = await fs.promises.readdir(f.root);
  assert.deepEqual(names.sort(), ['archive.tar.gz', 'archive_(1).tar.gz', 'archive_(2).tar.gz']);
  const contents = await Promise.all(names.map(name => fs.promises.readFile(path.join(f.root, name), 'utf8')));
  assert.deepEqual(contents.sort(), ['first', 'second', 'third']);
});

test('wx collision retry never unlinks a competing output; failures remove only their owned partial output', async t => {
  const f = await fixture(t);
  const realOpen = fs.promises.open.bind(fs.promises);
  let collision = false;
  f.api.fs = { ...fs, promises: { ...fs.promises, async open(name, flags, mode) {
    assert.equal(flags, 'wx');
    if (!collision) { collision = true; await fs.promises.writeFile(name, 'competitor'); }
    return realOpen(name, flags, mode);
  } }, createReadStream() {
    const stream = new PassThrough();
    queueMicrotask(() => { stream.write('partial'); stream.destroy(new Error('private fs path')); });
    return stream;
  } };
  const response = await f.upload([file()]);
  const result = await f.settled(response.body.batchId);
  assert.equal(result.status, 'failed');
  assert.equal(await fs.promises.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'competitor');
  assert.deepEqual(await fs.promises.readdir(f.root), ['a.txt']);
  assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
  assert.equal(JSON.stringify(result).includes('private fs path'), false);
});

test('reservations bind owner, Location, target, and single claim; lost acceptance is reconciled without duplicate dispatch', async t => {
  const f = await fixture(t);
  const reservation = await f.reserve({ path: 'folder', clientAttemptId: 'attempt-1' });
  assert.equal(reservation.status, 201);
  assert.deepEqual(Object.keys(reservation.body).sort(), ['batchId', 'expiresAt', 'locationId', 'status']);
  const id = reservation.body.batchId;
  assert.equal((await f.reserve({ path: 'folder', clientAttemptId: 'attempt-1' })).body.batchId, id);
  assert.equal((await f.poll(id, true, { ...auth, authorization: 'Bearer bob' })).status, 404);
  assert.equal((await f.poll(id, true, { ...auth, 'x-location-id': 'other' })).status, 403);
  const response = await f.upload([file()], { ...auth, 'x-upload-batch-id': id });
  assert.equal(response.status, 202);
  assert.equal(response.body.batchId, id);
  assert.equal((await f.settled(id)).status, 'completed');
  assert.equal((await f.upload([file()], { ...auth, 'x-upload-batch-id': id })).status, 409);
  assert.equal((await f.reserve({ path: 'folder', clientAttemptId: 'attempt-1' })).status, 409);
  assert.deepEqual(await fs.promises.readdir(path.join(f.root, 'folder')), ['a.txt']);
});

test('reservation mismatch and Location revision change fail closed', async t => {
  const f = await fixture(t);
  const { batchId } = (await f.reserve()).body;
  const mismatch = await f.upload([file(), { name: 'path', value: 'elsewhere' }], { ...auth, 'x-upload-batch-id': batchId });
  assert.equal(mismatch.status, 409);
  assert.equal((await f.poll(batchId)).body.status, 'failed');
  const next = (await f.reserve()).body.batchId;
  const originalRevision = f.locations.getRevision.bind(f.locations);
  f.locations.getRevision = id => `${originalRevision(id)}changed`;
  assert.equal((await f.poll(next)).status, 409);
  assert.deepEqual(await fs.promises.readdir(f.root), []);
});

test('reserved receiving totals are unknown; cancellation interrupts parser and waits for owned cleanup', async t => {
  const f = await fixture(t);
  const id = (await f.reserve()).body.batchId;
  const exchange = f.open('/upload/multiple', { ...auth, 'x-upload-batch-id': id,
    'content-type': `multipart/form-data; boundary=${boundary}` });
  exchange.request.write(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="active.txt"\r\n\r\nabc`);
  await until(() => f.manager.getBatch(id).files.length === 1);
  const progress = (await f.poll(id)).body;
  assert.equal(progress.phase, 'receiving');
  assert.equal(progress.totalSize, 0);
  assert.equal(progress.totalSizeKnown, false);
  const results = await Promise.all([f.send(`/progress/batch/${id}/cancel`), f.send(`/progress/batch/${id}/cancel`)]);
  exchange.request.end();
  await exchange.response;
  for (const result of results) assert.equal(result.body.status, 'cancelled');
  assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
  assert.deepEqual(await fs.promises.readdir(f.root), []);
});

test('batch cancellation stops queued lock work and pending children before any output', async t => {
  const f = await fixture(t);
  const hold = gate();
  let locked = false;
  const lock = withOperationLocks([f.root], async () => { locked = true; await hold.promise; });
  await until(() => locked);
  const result = await f.upload([file('a', '12'), file('b', '123456')]);
  const id = result.body.batchId;
  const progress = (await f.poll(id)).body;
  assert.equal(progress.pendingCount, 2);
  assert.equal(progress.totalSize, 8);
  const cancelled = await f.send(`/progress/batch/${id}/cancel`);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.cancelledCount, 2);
  assert.equal(cancelled.body.pendingCount, 0);
  assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
  hold.release();
  await lock;
  assert.deepEqual(await fs.promises.readdir(f.root), []);
});

test('active publication cancellation destroys streams, retains committed files, and settles pending work', async t => {
  const f = await fixture(t);
  let active;
  let reads = 0;
  f.api.fs = { ...fs, createReadStream(name) {
    if (++reads === 1) return fs.createReadStream(name);
    active = new PassThrough();
    active.write('ab');
    return active;
  } };
  const response = await f.upload([file('committed'), file('active'), file('pending')]);
  const id = response.body.batchId;
  await until(() => active);
  const result = await f.send(`/progress/batch/${id}/cancel`);
  assert.equal(result.body.status, 'cancelled');
  assert.equal(result.body.successCount, 1);
  assert.equal(result.body.cancelledCount, 2);
  assert.equal(active.destroyed, true);
  assert.deepEqual(await fs.promises.readdir(f.root), ['committed']);
  assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
});

test('individual pending cancellation removes its staged file and allows siblings to complete', async t => {
  const f = await fixture(t);
  let active;
  f.api.fs = { ...fs, createReadStream() { active = new PassThrough(); return active; } };
  const result = await f.upload([file('first'), file('second')]);
  const id = result.body.batchId;
  await until(() => active);
  const second = f.manager.getBatch(id).files[1];
  const cancellation = f.send(`/progress/${second}/cancel`);
  const cancelled = await cancellation;
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(f.manager.getTransfer(f.manager.getBatch(id).files[0]).status, 'processing');
  active.end('abcd');
  const batch = await f.settled(id);
  assert.equal(batch.successCount, 1);
  assert.equal(batch.cancelledCount, 1);
  assert.deepEqual(await fs.promises.readdir(f.root), ['first']);
});

test('authorization revocation before publication removes owned output; cache failure after commit is only a warning', async t => {
  const f = await fixture(t);
  const original = f.api._recheck.bind(f.api);
  let checks = 0;
  f.api._recheck = async (...args) => {
    if (++checks === 4) f.permissions.allowed = false;
    return original(...args);
  };
  const denied = await f.upload([file()]);
  assert.equal((await f.settled(denied.body.batchId)).failedCount, 1);
  assert.deepEqual(await fs.promises.readdir(f.root), []);
  f.permissions.allowed = true;
  f.api._recheck = original;
  f.api.setCache({ async refreshDirectory() { throw new Error('cache unavailable'); } });
  const accepted = await f.upload([file()]);
  assert.equal((await f.settled(accepted.body.batchId)).successCount, 1);
  assert.equal(await fs.promises.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'abcd');
});

test('directory-only compatibility and outer directory failure settle all registered children', async t => {
  const f = await fixture(t);
  const folders = await f.upload([{ name: 'directoryPaths[]', value: 'a/b' }]);
  assert.equal(folders.status, 200);
  assert.equal(folders.body.folders, 1);
  assert.equal((await f.poll(folders.body.batchId)).body.totalSizeKnown, true);
  await fs.promises.writeFile(path.join(f.root, 'not-directory'), 'sentinel');
  const invalid = await f.upload([file(), { name: 'directoryPaths[]', value: 'not-directory' }]);
  assert.equal(invalid.status, 400);
  f.api.fs = { ...fs, promises: { ...fs.promises, async mkdir(name, options) {
    if (name === path.join(f.root, 'new-directory')) throw Object.assign(new Error('Injected mkdir failure'), { code: 'ENOSPC' });
    return fs.promises.mkdir(name, options);
  } } };
  const result = await f.upload([file(), file('b'), { name: 'directoryPaths[]', value: 'new-directory' }]);
  assert.equal(result.status, 202);
  const batch = await f.settled(result.body.batchId);
  assert.equal(batch.pendingCount, 0);
  assert.equal(batch.failedCount, 2);
  assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
});

test('periodic cleanup excludes active staging and expires abandoned reservation records', async t => {
  const f = await fixture(t);
  let active;
  f.api.fs = { ...fs, createReadStream() { active = new PassThrough(); return active; } };
  const response = await f.upload([file()]);
  await until(() => active);
  const stages = await fs.promises.readdir(f.api.tempDir);
  assert.equal(stages.length, 1);
  await fs.promises.utimes(path.join(f.api.tempDir, stages[0]), 0, 0);
  const cleanup = await f.api.cleanupTempUploads(0);
  assert.equal(cleanup.deleted, 0);
  await f.send(`/progress/batch/${response.body.batchId}/cancel`);
  const id = (await f.reserve()).body.batchId;
  f.manager.getBatch(id).expiresAt = 0;
  await f.api.cleanupTempUploads(0);
  assert.equal(f.manager.getBatch(id).status, 'expired');
});

test('transport abort cleans receiving reservation without publishing files', async t => {
  const f = await fixture(t);
  const id = (await f.reserve()).body.batchId;
  const exchange = f.open('/upload/multiple', { ...auth, 'x-upload-batch-id': id,
    'content-type': `multipart/form-data; boundary=${boundary}` });
  exchange.response.catch(() => {});
  exchange.request.write(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="active.txt"\r\n\r\nabc`);
  await until(() => f.manager.getBatch(id).files.length === 1);
  exchange.request.destroy();
  assert.equal((await f.settled(id)).status, 'failed');
  assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
  assert.deepEqual(await fs.promises.readdir(f.root), []);
});

test('single-transfer active cancellation interrupts the real publication stream', async t => {
  const f = await fixture(t);
  let active;
  f.api.fs = { ...fs, createReadStream() { active = new PassThrough(); active.write('a'); return active; } };
  const response = await f.upload([file('a', 'abcd', 'file')], auth, '/upload/single-progress');
  await until(() => active);
  const cancelled = await f.send(`/progress/${response.body.transferId}/cancel`);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(active.destroyed, true);
  assert.deepEqual(await fs.promises.readdir(f.root), []);
});

test('completion wins cancellation during post-commit cache refresh', async t => {
  const f = await fixture(t);
  const hold = gate();
  let refreshing = false;
  f.api.setCache({ async refreshDirectory() { refreshing = true; await hold.promise; } });
  const response = await f.upload([file()]);
  const id = response.body.batchId;
  await until(() => refreshing);
  const cancel = f.send(`/progress/batch/${id}/cancel`);
  await until(() => f.manager.getBatch(id).status === 'cancelling');
  hold.release();
  const result = await cancel;
  assert.equal(result.body.status, 'completed');
  assert.equal(result.body.successCount, 1);
  assert.equal(result.body.cancelledCount, 0);
});

test('cleanup I/O failure never confirms cancellation and abandoned staging can be swept later', async t => {
  const f = await fixture(t);
  let active;
  let rejectCleanup = true;
  f.api.fs = { ...fs, createReadStream() { active = new PassThrough(); return active; }, promises: {
    ...fs.promises, async rm(name, options) {
      if (rejectCleanup && name.startsWith(f.api.tempDir)) throw Object.assign(new Error('private cleanup failure'), { code: 'EACCES' });
      return fs.promises.rm(name, options);
    }
  } };
  const response = await f.upload([file()]);
  await until(() => active);
  const result = await f.send(`/progress/batch/${response.body.batchId}/cancel`);
  assert.equal(result.body.status, 'failed');
  assert.equal(JSON.stringify(result.body).includes('private'), false);
  rejectCleanup = false;
  const stages = await fs.promises.readdir(f.api.tempDir);
  for (const stage of stages) await fs.promises.utimes(path.join(f.api.tempDir, stage), 0, 0);
  assert.equal((await f.api.cleanupTempUploads(0)).deleted, stages.length);
  assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
});

test('post-commit progress/cancel access still checks current owner and Location permission', async t => {
  const f = await fixture(t);
  const response = await f.upload([file()]);
  const id = response.body.batchId;
  const completed = await f.settled(id);
  f.permissions.allowed = false;
  assert.equal((await f.poll(id)).status, 403);
  assert.equal((await f.send(`/progress/batch/${id}/cancel`)).status, 403);
  f.permissions.allowed = true;
  assert.equal((await f.send(`/progress/${completed.files[0].id}/cancel`, '', { ...auth, authorization: 'Bearer bob' })).status, 404);
});

test('short source streams fail instead of reporting a complete file or padding counters', async t => {
  const f = await fixture(t);
  f.api.fs = { ...fs, createReadStream() { const stream = new PassThrough(); stream.end('a'); return stream; } };
  const response = await f.upload([file('a', 'abcd')]);
  const batch = await f.settled(response.body.batchId);
  assert.equal(batch.failedCount, 1);
  assert.equal(batch.committedSize, 0);
  assert.deepEqual(await fs.promises.readdir(f.root), []);
});

test('failed partial-output deletion cannot be reported as confirmed batch cancellation', async t => {
  const f = await fixture(t);
  let active;
  f.api.fs = { ...fs, createReadStream() { active = new PassThrough(); active.write('a'); return active; }, promises: {
    ...fs.promises, async unlink(name) {
      if (name.startsWith(f.root)) throw Object.assign(new Error('unlink denied'), { code: 'EACCES' });
      return fs.promises.unlink(name);
    }
  } };
  const response = await f.upload([file()]);
  await until(() => active);
  const result = await f.send(`/progress/batch/${response.body.batchId}/cancel`);
  assert.equal(result.body.status, 'failed');
  assert.equal(result.body.failedCount, 1);
  assert.equal(result.body.cancelledCount, 0);
  assert.equal(result.body.committedSize, 0);
});

test('real JWT/current-account middleware supports numeric admin 0 and regular IDs with exact ownership', async t => {
  // Execute the real middleware and resolver, substituting only their account/config data sources.
  const filename = require.resolve('../middleware/auth');
  const localRequire = createRequire(filename);
  const regular = { id: 7, username: 'numeric-user', role: 'user', active: true };
  const overrides = {
    '../config': { get: key => key === 'auth.username' ? 'numeric-admin' : undefined },
    '../auth/user-manager': { async getUser(username) { return username === regular.username ? { ...regular } : null; } }
  };
  const module = { exports: {} };
  runInThisContext(wrap(fs.readFileSync(filename, 'utf8')), { filename })(module.exports,
    name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name), module, filename, path.dirname(filename));
  const actualAuth = module.exports;
  const secret = 'isolated-upload-integration-jwt-secret';
  actualAuth.setJwtSecret(secret);
  const sign = claims => jwt.sign(claims, secret, { expiresIn: '1h' });
  const f = await fixture(t, { authenticate: actualAuth.authenticate });
  let numericBatch;
  for (const account of [{ id: 0, username: 'numeric-admin' }, { id: 7, username: regular.username }]) {
    const current = await actualAuth.resolveCurrentAccount(account);
    assert.equal(current.user.id, account.id);
    const headers = { 'x-location-id': 'default', ...(account.id === 0
      ? { cookie: `filetransfer_session=${sign(account)}` } : { authorization: `Bearer ${sign(account)}` }) };
    const reserved = await f.reserve({ path: '', clientAttemptId: `numeric-${account.id}` }, headers);
    assert.equal(reserved.status, 201);
    const id = reserved.body.batchId;
    assert.deepEqual(f.manager.getBatch(id).owner, account);
    const upload = await f.upload([file(`numeric-${account.id}.txt`)], { ...headers, 'x-upload-batch-id': id });
    assert.equal(upload.status, 202);
    const result = await f.settled(id);
    assert.equal(result.status, 'completed');
    assert.deepEqual(f.manager.getTransfer(result.files[0].id).owner, account);
    assert.equal((await f.poll(id, true, headers)).status, 200);
    assert.equal((await f.send(`/progress/batch/${id}/cancel`, '', headers)).body.status, 'completed');
    const single = await f.upload([file('single.txt', 'abc', 'file')], headers, '/upload/single');
    assert.equal(single.status, 200);
    if (account.id === 7) numericBatch = id;
  }
  const wrongType = { ...auth, authorization: `Bearer ${sign({ id: '7', username: regular.username })}` };
  assert.equal((await f.poll(numericBatch, true, wrongType)).status, 401);
  // Even if a new current account has the same textual ID, it does not own the numeric record.
  regular.id = '7';
  assert.equal((await f.poll(numericBatch, true, wrongType)).status, 404);
  assert.equal((await f.send(`/progress/batch/${numericBatch}/cancel`, '', wrongType)).status, 404);
  assert.equal(require.cache[require.resolve('../config')], undefined);
  assert.equal(require.cache[require.resolve('../auth/user-manager')], undefined);
});

test('owner validation rejects invalid IDs without coercing valid string or numeric identities', async t => {
  const f = await fixture(t);
  for (const id of [0, 7, '0', '7', 'opaque-id']) assert.equal(f.api._owner({ user: { id, username: 'user' } }).id, id);
  for (const id of [undefined, null, '', false, {}, [], NaN, Infinity, -1, 1.5]) {
    assert.throws(() => f.api._owner({ user: { id, username: 'user' } }), { statusCode: 401 });
  }
});

test('revision mismatch rejects reservations and every upload route before multipart reception', async t => {
  const f = await fixture(t);
  const revision = f.locations.getRevision('default');
  const stale = { ...auth, 'x-location-revision': `${revision}-old` };
  assert.equal((await f.reserve({ path: '' }, stale)).status, 409);
  const reserved = (await f.reserve({ path: '' }, { ...auth, 'x-location-revision': revision })).body;
  let parsed = 0;
  const parse = f.api._parse.bind(f.api);
  f.api._parse = (...args) => { parsed++; return parse(...args); };
  for (const endpoint of ['/upload', '/upload/multiple', '/upload/single', '/upload/progress', '/upload/single-progress']) {
    assert.equal((await f.upload([file()], stale, endpoint)).status, 409);
  }
  assert.equal((await f.upload([file()], { ...stale, 'x-upload-batch-id': reserved.batchId })).status, 409);
  assert.equal(parsed, 0);
  assert.equal(fs.existsSync(f.api.tempDir), false);
  assert.equal(f.manager.getBatch(reserved.batchId).status, 'reserved');
  const accepted = await f.upload([file(), { name: 'path', value: 'nested' }], { ...auth, 'x-location-revision': revision });
  assert.equal(accepted.status, 202);
  assert.equal((await f.settled(accepted.body.batchId)).status, 'completed');
  assert.equal(await fs.promises.readFile(path.join(f.root, 'nested/a.txt'), 'utf8'), 'abcd');
});

test('waitForIdle covers reception, publication, cache refresh, and cleanup without cancelling', async t => {
  const f = await fixture(t);
  const id = (await f.reserve()).body.batchId;
  const cacheGate = gate();
  let refreshing = false;
  f.api.setCache({ async refreshDirectory() { refreshing = true; await cacheGate.promise; } });
  const exchange = f.open('/upload/multiple', { ...auth, 'x-upload-batch-id': id,
    'content-type': `multipart/form-data; boundary=${boundary}` });
  exchange.request.write(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="idle.txt"\r\n\r\nabc`);
  await until(() => f.manager.getBatch(id).files.length === 1);
  let idle = false;
  const drained = f.api.waitForIdle().then(() => { idle = true; });
  await pause();
  assert.equal(idle, false);
  assert.equal(f.manager.getBatch(id).status, 'uploading');
  exchange.request.end(`\r\n--${boundary}--\r\n`);
  assert.equal((await exchange.response).status, 202);
  await until(() => refreshing);
  assert.equal(idle, false);
  cacheGate.release();
  await drained;
  assert.equal(f.manager.getBatch(id).status, 'completed');
  assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
  await f.api.waitForIdle();
});

test('waitForIdle also settles unreserved parser failures without waiting for unused reservations', async t => {
  const f = await fixture(t);
  await f.reserve();
  const exchange = f.open('/upload/multiple', { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` });
  exchange.request.write(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="idle.txt"\r\n\r\nabc`);
  await until(() => fs.existsSync(f.api.tempDir));
  let idle = false;
  const drained = f.api.waitForIdle().then(() => { idle = true; });
  await pause();
  assert.equal(idle, false);
  exchange.request.end();
  assert.equal((await exchange.response).status, 400);
  await drained;
  assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
});

test('manager swap during path resolution rejects a mixed-root context before parsing', async t => {
  const f = await fixture(t);
  const hold = gate();
  let resolving = false;
  const resolve = f.locations.resolveCheckedPath.bind(f.locations);
  f.locations.resolveCheckedPath = async (...args) => {
    resolving = true;
    await hold.promise;
    return resolve(...args);
  };
  const uploading = f.upload([file()], { ...auth, 'x-location-revision': f.locations.getRevision('default') });
  await until(() => resolving);
  const replacement = new LocationManager({ fileSystem: { storagePath: f.root } });
  f.api.setLocationManager(replacement, null, f.permissions);
  hold.release();
  assert.equal((await uploading).status, 409);
  await f.api.waitForIdle();
  assert.equal(fs.existsSync(f.api.tempDir), false);
});

test('root replacement during active publication cannot publish into either the stale or new root', async t => {
  const f = await fixture(t);
  let active;
  f.api.fs = { ...fs, createReadStream() { active = new PassThrough(); return active; } };
  const response = await f.upload([file()]);
  await until(() => active);
  const root = path.join(f.base, 'replacement');
  await fs.promises.mkdir(root);
  f.api.setLocationManager(new LocationManager({ fileSystem: { storagePath: root } }), null, f.permissions);
  active.end('abcd');
  await f.api.waitForIdle();
  assert.equal(f.manager.getBatch(response.body.batchId).status, 'failed');
  assert.deepEqual(await fs.promises.readdir(f.root), []);
  assert.deepEqual(await fs.promises.readdir(root), []);
  assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
});

test('parent root-lock barrier waits for old cache refresh before caches can close', async t => {
  const f = await fixture(t);
  const hold = gate();
  let refreshing = false;
  let closed = false;
  f.api.setCache({ async refreshDirectory() {
    refreshing = true;
    await hold.promise;
    assert.equal(closed, false);
  } });
  const response = await f.upload([file()]);
  await until(() => refreshing);
  f.api.setLocationManager(new LocationManager({ fileSystem: { storagePath: f.root } }), null, f.permissions);
  const barrier = withOperationLocks([f.root], async () => { closed = true; });
  await pause();
  assert.equal(closed, false);
  hold.release();
  await barrier;
  await f.api.waitForIdle();
  assert.equal(f.manager.getBatch(response.body.batchId).status, 'completed');
});

test('a cache resolver spanning a runtime swap cannot refresh the new cache with an old absolute path', async t => {
  const f = await fixture(t);
  const hold = gate();
  let resolving = false;
  let refreshes = 0;
  const cache = { async refreshDirectory() { refreshes++; } };
  f.api.setLocationManager(f.locations, async () => { resolving = true; await hold.promise; return cache; }, f.permissions);
  const response = await f.upload([file()]);
  await until(() => resolving);
  f.api.setLocationManager(new LocationManager({ fileSystem: { storagePath: f.root } }), async () => cache, f.permissions);
  hold.release();
  await f.api.waitForIdle();
  assert.equal(refreshes, 0);
  assert.equal(f.manager.getBatch(response.body.batchId).status, 'completed');
});

test('runtime file security enforces the existing extension policy on original and destination names with owned cleanup', async t => {
  const f = await fixture(t);
  const disabled = await f.upload([file('allowed-when-disabled.exe')]);
  assert.equal((await f.settled(disabled.body.batchId)).status, 'completed');
  f.config.enableFileUploadSecurity = true;
  for (const extension of ['exe', 'bat', 'cmd', 'com', 'pif', 'scr', 'vbs', 'js', 'jar', 'php', 'asp', 'aspx', 'jsp', 'sh', 'ps1', 'py', 'rb']) {
    const result = await f.upload([file(`blocked.${extension.toUpperCase()}`)]);
    assert.equal(result.status, 400, extension);
    assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
  }
  assert.equal((await f.upload([file('safe.txt'), { name: 'filePaths[]', value: 'unsafe.js' }])).status, 400);
  assert.equal((await f.upload([file('unsafe.exe'), { name: 'filePaths[]', value: 'safe.txt' }])).status, 400);
  for (const [original, override] of [['unsafe.exe', 'safe.txt'], ['safe.txt', 'unsafe.exe']]) {
    assert.equal((await f.upload([file(original, 'abc', 'file'), { name: 'fileName', value: override }], auth, '/upload/single')).status, 400);
  }
  const id = (await f.reserve()).body.batchId;
  assert.equal((await f.upload([file('safe.txt'), file('blocked.exe')], { ...auth, 'x-upload-batch-id': id })).status, 400);
  assert.equal(f.manager.getBatch(id).status, 'failed');
  assert.deepEqual(await fs.promises.readdir(f.root), ['allowed-when-disabled.exe']);
  assert.deepEqual(await fs.promises.readdir(f.api.tempDir), []);
});

test('enabled extension security accepts real streamed files above 100 MiB under the configured limit', async t => {
  const f = await fixture(t);
  f.config.enableFileUploadSecurity = true;
  f.config.maxFileSize = 100 * 1024 * 1024 + 1;
  const exchange = f.open('/upload/multiple', { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` });
  exchange.request.write(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="large.bin"\r\n\r\n`);
  const chunk = Buffer.alloc(1024 * 1024, 65);
  for (let i = 0; i < 100; i++) {
    if (!exchange.request.write(chunk)) await once(exchange.request, 'drain');
  }
  exchange.request.end(`B\r\n--${boundary}--\r\n`);
  const response = await exchange.response;
  assert.equal(response.status, 202);
  await f.api.waitForIdle();
  const batch = f.manager.serializeBatch(response.body.batchId);
  assert.equal(batch.status, 'completed');
  assert.equal(batch.transferredSize, f.config.maxFileSize);
  assert.equal((await fs.promises.stat(path.join(f.root, 'large.bin'))).size, f.config.maxFileSize);
});
