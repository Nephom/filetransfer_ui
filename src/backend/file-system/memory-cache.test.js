const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const Cache = require('./memory-cache');
const EnhancedMemoryFileSystem = require('./enhanced-memory');
const { withOperationLocks } = require('./operation-locks');

const temporaryParent = path.join(require('node:os').tmpdir(), 'opencode');
class FakeRedis {
  constructor(database) { this.database = database; this.isReady = true; this.isOpen = true; this.calls = []; }
  on() {}
  async connect() { this.isReady = this.isOpen = true; }
  async quit() { this.calls.push('quit'); this.isReady = this.isOpen = false; }
  check(key) { assert.equal(this.isReady, true, 'Redis used after close'); this.calls.push(key); }
  async get(key) { this.check(key); return this.database.get(key) ?? null; }
  async set(key, value) { this.check(key); this.database.set(key, value); }
  async hSet(key, value) { this.check(key); this.database.set(key, { ...value }); }
  async hGetAll(key) { this.check(key); return this.database.get(key) || {}; }
  async del(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) { this.check(key); this.database.delete(key); } }
  async *scanIterator({ MATCH }) {
    assert.match(MATCH, /^fs:v2:[a-f0-9]{64}:(?:[a-z]+:)?\*$/);
    for (const key of [...this.database.keys()]) if (key.startsWith(MATCH.slice(0, -1))) yield key;
  }
  async flushDb() { assert.fail('FLUSHDB must never be called'); }
  async flushAll() { assert.fail('FLUSHALL must never be called'); }
  async dbSize() { assert.fail('Database-wide statistics must not be used'); }
}
async function fixture(t) {
  await fs.mkdir(temporaryParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(await fs.realpath(temporaryParent), 'filesystem-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function makeCache(t, root, locationId, database) {
  const cache = new Cache(root, { locationId, redisClient: new FakeRedis(database) });
  cache.loadIgnoreList = async () => [];
  t.after(() => cache.close());
  return cache;
}
function barrier() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Read blocked behind paused index')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

test('all cache key families isolate Locations, roots, search and statistics', async t => {
  const parent = await fixture(t);
  const roots = [path.join(parent, 'a'), path.join(parent, 'b')];
  for (const root of roots) { await fs.mkdir(root); await fs.mkdir(path.join(root, 'nested')); }
  await fs.writeFile(path.join(roots[0], 'same.txt'), 'A');
  await fs.writeFile(path.join(roots[1], 'same.txt'), 'BBBB');
  await fs.writeFile(path.join(roots[0], 'nested', 'star[*]?.txt'), 'literal');
  const database = new Map([['index:legacy:same.txt', 'legacy'], ['dir:legacy', 'legacy-dir'], ['password-reset:sentinel', 'secret']]);
  const a = makeCache(t, roots[0], 'a', database);
  const b = makeCache(t, roots[1], 'b', database);
  await Promise.all([a.initialize(), b.initialize()]);
  await Promise.all([a.buildGlobalIndex(), b.buildGlobalIndex()]);
  assert.notEqual(a.namespace, b.namespace);
  assert.equal((await a.searchFiles('same')).files[0].size, 1);
  assert.equal((await b.searchFiles('same')).files[0].size, 4);
  assert.equal((await a.searchFiles('[*]?')).files.length, 1);
  assert.equal((await a.searchFiles('*')).files.length, 1);
  assert.equal((await a.searchFiles('meta')).files.length, 0);
  for (const cache of [a, b]) {
    for (const family of ['dir:', 'entry:', 'mtime:', 'meta:']) assert.ok([...database.keys()].some(key => key.startsWith(cache.namespace + family)), family);
    assert.equal((await cache.getStats()).redisDbSize, [...database.keys()].filter(key => key.startsWith(cache.namespace)).length);
  }
  const sameRoot = makeCache(t, roots[0], 'other-location', database);
  await sameRoot.initialize();
  await sameRoot.buildGlobalIndex();
  assert.notEqual(a.namespace, sameRoot.namespace);
  const otherBefore = [...database].filter(([key]) => !key.startsWith(a.namespace));
  await a.clearCache();
  assert.equal([...database.keys()].some(key => key.startsWith(a.namespace)), false);
  assert.deepEqual([...database].filter(([key]) => !key.startsWith(a.namespace)), otherBefore);
  await a.refreshCache();
  await a.buildGlobalIndex(true);
  assert.deepEqual([...database].filter(([key]) => !key.startsWith(a.namespace)), otherBefore);
  await a.invalidateDirectory(roots[0], { recursive: true });
  assert.deepEqual([...database].filter(([key]) => !key.startsWith(a.namespace)), otherBefore);
  assert.equal(database.get('password-reset:sentinel'), 'secret');
});

test('cold root changes preserve old namespaces and stale results are checked against disk', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const parent = await fixture(t);
  const root = path.join(parent, 'root');
  await fs.mkdir(root);
  const file = path.join(root, 'file');
  await fs.writeFile(file, 'old');
  const database = new Map();
  const old = makeCache(t, root, 'same-id', database);
  await old.initialize();
  await old.buildGlobalIndex();
  const oldNamespace = old.namespace;
  const oldData = [...database];
  await old.close();
  await fs.rename(root, `${root}-old`);
  await fs.mkdir(root);
  await fs.writeFile(file, 'new content');
  const current = makeCache(t, root, 'same-id', database);
  await current.initialize();
  await current.buildGlobalIndex();
  assert.notEqual(current.namespace, oldNamespace);
  for (const [key, value] of oldData) assert.deepEqual(database.get(key), value);
  assert.equal((await current.searchFiles('file')).files[0].size, 11);
  await fs.writeFile(file, 'changed in place');
  assert.equal((await current.getFilesInDirectory(root))[0].size, 11);
  now += 3000;
  assert.equal((await current.getFilesInDirectory(root))[0].size, 16);
  await fs.unlink(file);
  assert.equal((await current.searchFiles('file')).files.length, 0);
  assert.deepEqual(await current.getFilesInDirectory(root), []);
  await fs.rename(root, `${root}-second`);
  await fs.mkdir(root);
  await assert.rejects(current.searchFiles('file'), { code: 'ESTALE' });
});

test('cold restart does not trust stale scoped or ambiguous legacy entries', async t => {
  const root = await fixture(t);
  const database = new Map([['index:status', '{"legacy":true}']]);
  const first = makeCache(t, root, 'a', database);
  await first.initialize();
  await first.buildGlobalIndex();
  const namespace = first.namespace;
  await first.close();
  database.set(namespace + 'entry:stale', JSON.stringify({ name: 'stale', path: 'stale' }));
  const second = makeCache(t, root, 'a', database);
  await second.initialize();
  await second.buildGlobalIndex();
  assert.equal(second.namespace, namespace);
  assert.equal(database.has(namespace + 'entry:stale'), false);
  assert.equal(database.get('index:status'), '{"legacy":true}');
});

test('link-aware scans and cached search reject linked files, parents and root replacement', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'root');
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'nested/file'), 'inside');
  await fs.writeFile(path.join(parent, 'sentinel'), 'outside');
  const cache = makeCache(t, root, 'a', new Map());
  await cache.initialize();
  await cache.buildGlobalIndex();
  await fs.rename(path.join(root, 'nested'), path.join(parent, 'moved'));
  await fs.symlink(path.join(parent, 'moved'), path.join(root, 'nested'));
  await assert.rejects(cache.searchFiles('file'), { code: 'ELOOP' });
  await assert.rejects(cache.getFilesInDirectory(root), { code: 'ELOOP' });
  await assert.rejects(cache.getFilesInDirectoryPaginated(root), { code: 'ELOOP' });
  await assert.rejects(cache.buildGlobalIndex(true), { code: 'ELOOP' });
  await assert.rejects(cache.enterDirectory(path.join(root, 'nested')), { code: 'ELOOP' });
  await assert.rejects(cache.getFileInfo('../sentinel'), { code: 'EACCES' });
  assert.equal(await fs.readFile(path.join(parent, 'sentinel'), 'utf8'), 'outside');
});

test('clear waits for active indexing and invalidates queued background work', { timeout: 5000 }, async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file'), 'content');
  const database = new Map([['password-reset:other', 'untouched']]);
  const cache = makeCache(t, root, 'a', database);
  await cache.initialize();
  await cache.buildGlobalIndex();
  cache.stopRootPolling();
  cache.stopPeriodicIndexing();
  const entered = barrier();
  const release = barrier();
  const originalSet = cache.redisClient.set.bind(cache.redisClient);
  let blocked = false;
  cache.redisClient.set = async (...args) => {
    if (!blocked) { blocked = true; entered.resolve(); await release.promise; }
    return originalSet(...args);
  };
  const index = cache.buildGlobalIndex(true);
  await entered.promise;
  cache._background(() => cache.updateDirectoryCache(root));
  let cleared = false;
  const clear = cache.clearCache().then(() => { cleared = true; });
  await tick();
  assert.equal(cleared, false);
  release.resolve();
  await Promise.all([index, clear]);
  await cache.work;
  assert.deepEqual([...database], [['password-reset:other', 'untouched']]);
  assert.equal(cache.directoryCache.size, 0);
});

test('close drains active work, stops timers and forbids Redis access after quit', { timeout: 5000 }, async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file'), 'content');
  const cache = makeCache(t, root, 'a', new Map());
  await cache.initialize();
  await cache.buildGlobalIndex();
  const client = cache.redisClient;
  const entered = barrier();
  const release = barrier();
  const original = client.hSet.bind(client);
  client.hSet = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const refresh = cache.refreshDirectory(root);
  await entered.promise;
  const close = cache.close();
  await assert.rejects(cache.refreshDirectory(root), { code: 'ESHUTDOWN' });
  assert.equal(client.calls.includes('quit'), false);
  release.resolve();
  await Promise.all([refresh, close]);
  assert.equal(client.calls.at(-1), 'quit');
  assert.equal(cache.rootPollingInterval, null);
  assert.equal(cache.indexingInterval, null);
  await assert.rejects(cache.initialize(), { code: 'ESHUTDOWN' });
});

test('clear during initialization prevents late initial index publication', { timeout: 5000 }, async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file'), 'content');
  const database = new Map();
  const cache = makeCache(t, root, 'a', database);
  const entered = barrier();
  const release = barrier();
  const original = cache.redisClient.hSet.bind(cache.redisClient);
  cache.redisClient.hSet = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const initializing = cache.initialize();
  assert.equal(cache.initialize(), initializing);
  await entered.promise;
  const clear = cache.clearCache();
  release.resolve();
  await Promise.all([initializing, clear]);
  await cache.work;
  assert.equal(database.size, 0);
  assert.ok(cache.indexingInterval);
});

test('close during initialization drains connect and does not start timers', { timeout: 5000 }, async t => {
  const root = await fixture(t);
  const cache = makeCache(t, root, 'a', new Map());
  const client = cache.redisClient;
  client.isReady = false;
  const entered = barrier();
  const release = barrier();
  client.connect = async () => { entered.resolve(); await release.promise; client.isReady = true; };
  const initialization = cache.initialize();
  await entered.promise;
  const close = cache.close();
  release.resolve();
  await Promise.all([initialization, close]);
  assert.equal(client.calls.at(-1), 'quit');
  assert.equal(cache.initialized, false);
  assert.equal(cache.rootPollingInterval, null);
  assert.equal(cache.indexingInterval, null);
});

test('directory invalidation treats wildcard names literally and removes deleted tree index entries', async t => {
  const root = await fixture(t);
  for (const dir of ['[*]', 'other']) {
    await fs.mkdir(path.join(root, dir));
    await fs.writeFile(path.join(root, dir, 'file'), dir);
  }
  const database = new Map();
  const cache = makeCache(t, root, 'a', database);
  await cache.initialize();
  await cache.buildGlobalIndex();
  await cache.enterDirectory(path.join(root, '[*]'));
  await cache.enterDirectory(path.join(root, 'other'));
  await fs.rm(path.join(root, '[*]'), { recursive: true });
  await cache.invalidateDirectory(path.join(root, '[*]'), { recursive: true });
  assert.equal(database.has(cache.key('dir', 'other')), true);
  assert.equal(database.has(cache.key('entry', 'other/file')), true);
  assert.equal(database.has(cache.key('entry', '[*]/file')), false);
  assert.equal(database.has(cache.key('mtime', '[*]')), false);
  assert.equal((await cache.searchFiles('file')).files.length, 1);
});

test('enhanced mutations refresh overlapping views and rebuild without reusing a closed client', async t => {
  const parent = await fixture(t);
  const nested = path.join(parent, 'nested');
  const file = path.join(nested, 'file');
  await fs.mkdir(nested);
  await fs.writeFile(file, 'before');
  const database = new Map();
  const a = new EnhancedMemoryFileSystem(parent, { locationId: 'a' });
  const b = new EnhancedMemoryFileSystem(nested, { locationId: 'b' });
  a.cache = makeCache(t, parent, 'a', database);
  b.cache = makeCache(t, nested, 'b', database);
  t.after(async () => { await a.close(); await b.close(); });
  await Promise.all([a.initialize(), b.initialize()]);
  await Promise.all([a.cache.buildGlobalIndex(), b.cache.buildGlobalIndex()]);
  await a.list(nested);
  await b.list(nested);
  await b.write(file, 'after mutation');
  assert.equal(a.cache.directoryCache.get(nested)[0].size, 14);
  assert.equal(b.cache.directoryCache.get(nested)[0].size, 14);
  assert.equal(JSON.parse(database.get(a.cache.key('entry', 'nested/file'))).size, 14);
  assert.equal(JSON.parse(database.get(b.cache.key('entry', 'file'))).size, 14);
  assert.equal((await a.searchFiles('file')).files[0].size, 14);
  assert.equal((await b.searchFiles('file')).files[0].size, 14);
  assert.equal((await a.list(nested))[0].size, 14);
  assert.equal((await b.list(nested))[0].size, 14);
  const client = b.cache.redisClient;
  await b.refreshCache();
  assert.equal(client.isReady, true);
  assert.equal(client.calls.includes('quit'), false);
  assert.equal((await b.searchFiles('file')).files[0].size, 14);
  await fs.symlink(file, path.join(nested, 'link'));
  await assert.rejects(b.list(nested), { code: 'ELOOP' });
  await Promise.all([a.close(), b.close()]);
  await assert.rejects(b.list(nested), { code: 'ESHUTDOWN' });
});

test('hot/memory TTL hits coalesce concurrent misses and the server enter/list pair', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const root = await fixture(t);
  const nested = path.join(root, 'nested');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, 'file'), 'content');
  const cache = makeCache(t, root, 'a', new Map());
  const instance = new EnhancedMemoryFileSystem(root, { locationId: 'a' });
  instance.cache = cache;
  t.after(() => instance.close());
  await instance.initialize();
  await cache.buildGlobalIndex();
  const readdir = t.mock.method(fs, 'readdir');
  const scans = cache.metrics.directoryScans;
  const contents = await Promise.all(Array.from({ length: 8 }, () => cache.enterDirectory(nested)));
  assert.equal(cache.metrics.directoryScans, scans + 1);
  assert.equal(readdir.mock.calls.filter(call => call.arguments[0] === nested).length, 1);
  assert.ok(contents.every(value => value === contents[0]));
  const hits = cache.metrics.hotCacheHits;
  assert.equal(await cache.enterDirectory(nested), contents[0]);
  assert.equal(await instance.list(nested), contents[0]);
  assert.equal(cache.metrics.hotCacheHits, hits + 2);
  assert.equal(cache.metrics.directoryScans, scans + 1);
  assert.equal(Reflect.set(contents[0][0], 'path', path.join(root, 'forged')), false);
  assert.throws(() => contents[0].push({ name: 'forged' }), TypeError);
  cache.hotCache.clear();
  now = 2999;
  assert.equal(await instance.list(nested), contents[0]);
  assert.equal(cache.metrics.memoryCacheHits, 1);
  assert.equal(cache.metrics.directoryScans, scans + 1);
  now = 3000;
  assert.notEqual(await instance.list(nested), contents[0]);
  assert.equal(cache.metrics.directoryScans, scans + 2, 'memory promotion must not renew TTL');
  assert.equal(readdir.mock.calls.filter(call => call.arguments[0] === nested).length, 2);
  assert.equal(cache.metrics.cacheMisses, 2);
});

test('in-place external changes refresh at the TTL boundary without sliding on cache hits', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const root = await fixture(t);
  const file = path.join(root, 'file');
  await fs.writeFile(file, 'a');
  const cache = makeCache(t, root, 'a', new Map());
  await cache.initialize();
  await cache.buildGlobalIndex();
  const originalMtime = (await fs.lstat(root)).mtimeMs;
  await fs.writeFile(file, 'external change');
  assert.equal((await fs.lstat(root)).mtimeMs, originalMtime);
  for (now of [1000, 2000, 2999]) assert.equal((await cache.getDirectoryContents(root))[0].size, 1);
  assert.equal(cache.metrics.directoryScans, 1);
  now = 3000;
  assert.equal((await cache.getDirectoryContents(root))[0].size, 15);
  assert.equal(cache.metrics.directoryScans, 2);
  now = 3001;
  await fs.writeFile(file, 'explicit');
  await cache.invalidateDirectory(root);
  assert.equal((await cache.getDirectoryContents(root))[0].size, 8);
  assert.equal(cache.metrics.directoryScans, 3);
  await cache.clearCache();
  assert.equal(cache.lastIndex, null);
  await cache.getDirectoryContents(root);
  assert.equal(cache.metrics.directoryScans, 4);
  await fs.writeFile(file, 'forced refresh');
  await cache.refreshDirectory(root);
  assert.equal((await cache.getDirectoryContents(root))[0].size, 14);
  assert.equal(cache.metrics.directoryScans, 5);
  assert.equal(new Cache(root, { cacheTtlMs: 60000 }).cacheTtlMs, 3000);
  assert.equal(new Cache(root, { cacheTtlMs: 20 }).cacheTtlMs, 20);
});

test('warm browse, pagination and status respond while the global index is paused', { timeout: 5000 }, async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file'), 'content');
  const cache = makeCache(t, root, 'a', new Map());
  await cache.initialize();
  await cache.buildGlobalIndex();
  const scans = cache.metrics.directoryScans;
  const lastIndex = (await cache.getIndexStatus()).lastIndex;
  const entered = barrier();
  const release = barrier();
  const set = cache.redisClient.set.bind(cache.redisClient);
  let blocked = false;
  cache.redisClient.set = async (...args) => {
    if (!blocked) { blocked = true; entered.resolve(); await release.promise; }
    return set(...args);
  };
  const index = cache.buildGlobalIndex(true);
  await entered.promise;
  try {
    const [status, listed, paginated] = await promptly(Promise.all([
      cache.getIndexStatus(), cache.enterDirectory(root), cache.getFilesInDirectoryPaginated(root, 0, 1)
    ]));
    assert.equal(status.isIndexing, true);
    assert.equal(status.progress.status, 'scanning');
    assert.deepEqual(status.lastIndex, lastIndex);
    assert.equal(listed[0].name, 'file');
    assert.equal(paginated.files[0].name, 'file');
    assert.equal(cache.metrics.directoryScans, scans);
    status.progress.current = 99999;
    status.lastIndex.totalFiles = 99999;
    const current = await promptly(cache.getIndexStatus());
    assert.equal(current.progress.current, 0);
    assert.equal(current.lastIndex.totalFiles, 1);
  } finally { release.resolve(); await index; }
  assert.equal((await cache.getIndexStatus()).isIndexing, false);
});

test('invalidation immediately expires hits even when its Redis cleanup waits for indexing', { timeout: 5000 }, async t => {
  const root = await fixture(t);
  const file = path.join(root, 'file');
  await fs.writeFile(file, 'old');
  const cache = makeCache(t, root, 'a', new Map());
  await cache.initialize();
  await cache.buildGlobalIndex();
  const entered = barrier();
  const release = barrier();
  const set = cache.redisClient.set.bind(cache.redisClient);
  let blocked = false;
  cache.redisClient.set = async (...args) => {
    if (!blocked) { blocked = true; entered.resolve(); await release.promise; }
    return set(...args);
  };
  const index = cache.buildGlobalIndex(true);
  await entered.promise;
  await fs.writeFile(file, 'new content');
  const invalidation = cache.invalidateDirectory(root);
  const read = cache.getDirectoryContents(root);
  release.resolve();
  await Promise.all([index, invalidation]);
  assert.equal((await read)[0].size, 11);
  assert.equal(cache.metrics.directoryScans, 2);
});

test('fast hits still reject root/link changes and close drains in-flight boundary checks', { timeout: 5000 }, async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'root');
  const nested = path.join(root, 'nested');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, 'file'), 'inside');
  const cache = makeCache(t, root, 'a', new Map());
  await cache.initialize();
  await cache.buildGlobalIndex();
  await cache.enterDirectory(nested);
  await fs.rename(nested, path.join(parent, 'outside'));
  await fs.symlink(path.join(parent, 'outside'), nested);
  await assert.rejects(cache.enterDirectory(nested), { code: 'ELOOP', statusCode: 403 });
  await fs.rename(root, `${root}-old`);
  await fs.mkdir(root);
  await assert.rejects(cache.getDirectoryContents(root), { code: 'ESTALE' });
  await assert.rejects(cache.getIndexStatus(), { code: 'ESTALE' });
  await cache.close();

  const fresh = makeCache(t, root, 'a', new Map());
  await fresh.initialize();
  await fresh.buildGlobalIndex();
  const entered = barrier();
  const release = barrier();
  const checked = fresh._checked.bind(fresh);
  fresh._checked = async (...args) => { const result = await checked(...args); entered.resolve(); await release.promise; return result; };
  const read = fresh.getDirectoryContents(root);
  const rejected = assert.rejects(read, { code: 'ESHUTDOWN' });
  await entered.promise;
  const client = fresh.redisClient;
  let closed = false;
  const close = fresh.close().then(() => { closed = true; });
  await tick();
  assert.equal(closed, false);
  assert.equal(client.calls.includes('quit'), false);
  release.resolve();
  await Promise.all([rejected, close]);
  assert.equal(client.calls.at(-1), 'quit');
  await assert.rejects(fresh.getIndexStatus(), { code: 'ESHUTDOWN' });
});

test('navigation evicts only directory views; upload refresh restores immediate search entries without dropping descendants', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'a');
  const otherRoot = path.join(parent, 'b');
  const nested = path.join(root, 'nested');
  await fs.mkdir(path.join(nested, 'deep'), { recursive: true });
  await fs.mkdir(otherRoot);
  await fs.writeFile(path.join(nested, 'existing.txt'), 'old');
  await fs.writeFile(path.join(nested, 'deep/retained.txt'), 'retained');
  await fs.writeFile(path.join(otherRoot, 'existing.txt'), 'other Location');
  const database = new Map([['password-reset:unrelated', 'untouched']]);
  const cache = makeCache(t, root, 'a', database);
  const other = makeCache(t, otherRoot, 'b', database);
  await Promise.all([cache.initialize(), other.initialize()]);
  await Promise.all([cache.buildGlobalIndex(), other.buildGlobalIndex()]);
  cache.stopRootPolling();
  cache.stopPeriodicIndexing();
  other.stopRootPolling();
  other.stopPeriodicIndexing();
  const unrelated = [...database].filter(([key]) => !key.startsWith(cache.namespace));
  const retainedKey = cache.key('entry', 'nested/deep/retained.txt');
  const retained = database.get(retainedKey);
  await cache.enterDirectory(nested);
  const entryKey = cache.key('entry', 'nested/existing.txt');
  const entry = database.get(entryKey);
  const mtimeKey = cache.key('mtime', 'nested');
  const mtime = database.get(mtimeKey);
  await cache.leaveDirectory(nested);
  assert.equal(cache.directoryCache.has(nested), false);
  assert.equal(database.has(cache.key('dir', 'nested')), false);
  assert.equal(database.get(entryKey), entry);
  assert.equal(database.get(mtimeKey), mtime);
  assert.equal(database.get(retainedKey), retained);
  assert.equal((await cache.searchFiles('existing')).files[0].path, 'nested/existing.txt');
  await cache.enterDirectory(root);
  assert.equal((await cache.searchFiles('retained')).files[0].path, 'nested/deep/retained.txt');
  await fs.writeFile(path.join(nested, 'uploaded.txt'), 'uploaded');
  await fs.writeFile(path.join(nested, 'existing.txt'), 'changed content');
  await cache.refreshDirectory(nested);
  assert.equal((await cache.searchFiles('uploaded')).files[0].path, 'nested/uploaded.txt');
  assert.equal(JSON.parse(database.get(entryKey)).size, 15);
  assert.equal(database.get(retainedKey), retained);
  assert.equal((await cache.searchFiles('retained')).files.length, 1);
  await fs.mkdir(path.join(nested, 'empty-upload-folder'));
  await cache.refreshDirectory(path.join(nested, 'empty-upload-folder'));
  assert.equal((await cache.searchFiles('empty-upload-folder')).files[0].isDirectory, true);
  assert.deepEqual([...database].filter(([key]) => !key.startsWith(cache.namespace)), unrelated);
  await fs.unlink(path.join(nested, 'uploaded.txt'));
  await fs.symlink(path.join(otherRoot, 'existing.txt'), path.join(nested, 'uploaded.txt'));
  await cache.leaveDirectory(nested);
  await assert.rejects(cache.searchFiles('uploaded'), { code: 'ELOOP', statusCode: 403 });
  assert.equal(await fs.readFile(path.join(otherRoot, 'existing.txt'), 'utf8'), 'other Location');
});

test('directory refresh prunes removed and directory-to-file subtrees but preserves sibling records', async t => {
  const root = await fixture(t);
  for (const dir of ['gone', 'replaced', 'retained']) {
    await fs.mkdir(path.join(root, dir, 'deep'), { recursive: true });
    await fs.writeFile(path.join(root, dir, 'deep/file.txt'), dir);
  }
  const database = new Map();
  const cache = makeCache(t, root, 'a', database);
  await cache.initialize();
  await cache.buildGlobalIndex();
  await cache.enterDirectory(path.join(root, 'gone/deep'));
  await cache.enterDirectory(path.join(root, 'replaced/deep'));
  const retained = database.get(cache.key('entry', 'retained/deep/file.txt'));
  await fs.rm(path.join(root, 'gone'), { recursive: true });
  await fs.rm(path.join(root, 'replaced'), { recursive: true });
  await fs.writeFile(path.join(root, 'replaced'), 'now a file');
  const readdir = t.mock.method(fs, 'readdir');
  await cache.refreshDirectory(root);
  assert.deepEqual(readdir.mock.calls.map(call => call.arguments[0]), [root]);
  for (const family of ['entry', 'mtime', 'dir']) {
    for (const relative of ['gone', 'gone/deep', 'gone/deep/file.txt', 'replaced/deep', 'replaced/deep/file.txt']) {
      assert.equal(database.has(cache.key(family, relative)), false, `${family}:${relative}`);
    }
  }
  assert.equal(database.has(cache.key('mtime', 'replaced')), false);
  assert.equal(JSON.parse(database.get(cache.key('entry', 'replaced'))).isDirectory, false);
  assert.equal(database.get(cache.key('entry', 'retained/deep/file.txt')), retained);
  assert.deepEqual((await cache.searchFiles('file.txt')).files.map(file => file.path), ['retained/deep/file.txt']);
});

test('file and tree mutations reconcile search incrementally across Locations without full index rebuilds', async t => {
  const parent = await fixture(t);
  const roots = ['a', 'b', 'unrelated'].map(name => path.join(parent, name));
  for (const root of roots) {
    await fs.mkdir(path.join(root, 'untouched'), { recursive: true });
    await fs.writeFile(path.join(root, 'untouched/keep.txt'), 'keep');
  }
  const database = new Map([['password-reset:other', 'preserved']]);
  const instances = roots.map((root, index) => {
    const instance = new EnhancedMemoryFileSystem(root, { locationId: String(index) });
    instance.cache = makeCache(t, root, String(index), database);
    t.after(() => instance.close());
    return instance;
  });
  await Promise.all(instances.map(instance => instance.initialize()));
  await Promise.all(instances.map(instance => instance.cache.buildGlobalIndex()));
  for (const instance of instances) {
    instance.cache.stopRootPolling();
    instance.cache.stopPeriodicIndexing();
    t.mock.method(instance.cache, 'buildGlobalIndex', () => assert.fail('Mutation must not rebuild a full Location index'));
  }
  const [a, b, other] = instances;
  const unrelated = [...database].filter(([key]) => key.startsWith(other.cache.namespace) || key === 'password-reset:other');
  const readdir = t.mock.method(fs, 'readdir');
  const work = path.join(roots[0], 'work');
  await a.mkdir(path.join(work, 'new/deep'));
  const created = path.join(work, 'created.txt');
  const renamed = path.join(work, 'renamed.txt');
  await a.write(created, 'first');
  assert.equal((await a.searchFiles('created')).files[0].size, 5);
  await a.write(created, 'longer write');
  assert.equal(JSON.parse(database.get(a.cache.key('entry', 'work/created.txt'))).size, 12);
  await a.rename(created, renamed);
  assert.equal(database.has(a.cache.key('entry', 'work/created.txt')), false);
  assert.equal((await a.searchFiles('created')).files.length, 0);
  assert.equal((await a.searchFiles('renamed')).files[0].path, 'work/renamed.txt');
  await a.copy(renamed, path.join(work, 'copy.txt'));
  assert.equal((await a.searchFiles('copy')).files[0].path, 'work/copy.txt');
  const aBeforeCopy = [...database].filter(([key]) => key.startsWith(a.cache.namespace));
  await b.copy(renamed, path.join(roots[1], 'copied.txt'));
  assert.deepEqual([...database].filter(([key]) => key.startsWith(a.cache.namespace)), aBeforeCopy);
  assert.equal((await b.searchFiles('copied')).files[0].path, 'copied.txt');
  await b.move(path.join(roots[1], 'copied.txt'), path.join(roots[1], 'moved.txt'));
  assert.equal((await b.searchFiles('copied')).files.length, 0);
  assert.equal((await b.searchFiles('moved')).files[0].path, 'moved.txt');
  const transferred = path.join(roots[1], 'transferred.txt');
  await withOperationLocks([renamed, transferred], async () => {
    await b.copy(renamed, transferred);
    await a.delete(renamed);
  });
  assert.equal((await a.searchFiles('renamed')).files.length, 0);
  assert.equal((await b.searchFiles('transferred')).files[0].path, 'transferred.txt');
  await a.write(path.join(work, 'new/deep/tree.txt'), 'tree');
  await b.copy(path.join(work, 'new'), path.join(roots[1], 'tree-copy'));
  assert.equal((await b.searchFiles('tree.txt')).files[0].path, 'tree-copy/deep/tree.txt');
  await b.rename(path.join(roots[1], 'tree-copy'), path.join(roots[1], 'tree-renamed'));
  assert.equal(database.has(b.cache.key('entry', 'tree-copy/deep/tree.txt')), false);
  assert.equal((await b.searchFiles('tree.txt')).files[0].path, 'tree-renamed/deep/tree.txt');
  await b.delete(path.join(roots[1], 'tree-renamed'));
  assert.equal((await b.searchFiles('tree.txt')).files.length, 0);
  for (const family of ['entry', 'mtime', 'dir']) {
    for (const relative of ['tree-renamed', 'tree-renamed/deep', 'tree-renamed/deep/tree.txt']) {
      assert.equal(database.has(b.cache.key(family, relative)), false);
    }
  }
  await a.delete(path.join(work, 'new'));
  assert.equal((await a.searchFiles('tree.txt')).files.length, 0);
  assert.deepEqual([...database].filter(([key]) => key.startsWith(other.cache.namespace) || key === 'password-reset:other'), unrelated);
  assert.ok(readdir.mock.calls.every(call => !roots.some(root => containsUntouched(root, call.arguments[0]))));
  for (const instance of instances) assert.equal(instance.cache.buildGlobalIndex.mock.callCount(), 0);

  function containsUntouched(root, target) {
    return target === path.join(root, 'untouched') || target.startsWith(path.join(root, 'untouched') + path.sep);
  }
});

test('copy refreshes a nested Location when its root is inside the copied destination', async t => {
  const parent = await fixture(t);
  const source = path.join(parent, 'source');
  const destinationRoot = path.join(parent, 'destination');
  const destination = path.join(destinationRoot, 'copied');
  const overlapRoot = path.join(destination, 'deep');
  await fs.mkdir(path.join(source, 'deep'), { recursive: true });
  await fs.mkdir(overlapRoot, { recursive: true });
  await fs.writeFile(path.join(source, 'deep/new-file.txt'), 'new');
  const database = new Map();
  const a = new EnhancedMemoryFileSystem(destinationRoot, { locationId: 'a' });
  const b = new EnhancedMemoryFileSystem(overlapRoot, { locationId: 'b' });
  a.cache = makeCache(t, destinationRoot, 'a', database);
  b.cache = makeCache(t, overlapRoot, 'b', database);
  t.after(async () => { await a.close(); await b.close(); });
  await Promise.all([a.initialize(), b.initialize()]);
  await Promise.all([a.cache.buildGlobalIndex(), b.cache.buildGlobalIndex()]);
  await a.copy(source, destination);
  assert.equal((await a.searchFiles('new-file')).files[0].path, 'copied/deep/new-file.txt');
  assert.equal((await b.searchFiles('new-file')).files[0].path, 'new-file.txt');
});

test('targeted subtree indexing rejects linked trees before publishing any new entries', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'root');
  await fs.mkdir(root);
  await fs.writeFile(path.join(parent, 'outside'), 'sentinel');
  const database = new Map();
  const cache = makeCache(t, root, 'a', database);
  await cache.initialize();
  await cache.buildGlobalIndex();
  const before = [...database];
  const tree = path.join(root, 'new-tree');
  await fs.mkdir(path.join(tree, 'deep'), { recursive: true });
  await fs.writeFile(path.join(tree, 'ordinary.txt'), 'ordinary');
  await fs.symlink(path.join(parent, 'outside'), path.join(tree, 'deep/link'));
  await assert.rejects(cache.indexDirectory(tree), { code: 'ELOOP', statusCode: 403 });
  assert.deepEqual([...database], before);
  assert.equal(await fs.readFile(path.join(parent, 'outside'), 'utf8'), 'sentinel');
});
