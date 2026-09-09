const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const path = require('node:path');
const { assertSafePath, assertSafeTree, assertTransferPaths } = require('./path-safety');
const { withOperationLocks } = require('./operation-locks');
const { LocalFileSystem } = require('./base');
const EnhancedMemoryFileSystem = require('./enhanced-memory');
const LocationManager = require('../location/location-manager');

const temporaryParent = path.join(require('node:os').tmpdir(), 'opencode');
async function fixture(t) {
  await fs.mkdir(temporaryParent, { recursive: true });
  const parent = await fs.realpath(temporaryParent);
  const root = await fs.mkdtemp(path.join(parent, 'filesystem-safety-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function barrier() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('checked paths reject all links, missing linked parents and lexical escapes', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'root');
  const outside = path.join(parent, 'sentinel');
  await fs.mkdir(root);
  await fs.writeFile(outside, 'outside');
  await fs.writeFile(path.join(root, 'inside'), 'inside');
  for (const [name, target] of [['external', outside], ['internal', path.join(root, 'inside')], ['dangling', path.join(parent, 'absent')], ['parent', parent]]) {
    const link = path.join(root, name);
    await fs.symlink(target, link);
    await assert.rejects(assertSafePath(root, link), { code: 'ELOOP' });
    await assert.rejects(assertSafePath(root, `${link}/new/deep`), { code: 'ELOOP' });
  }
  await assert.rejects(assertSafePath(root, outside), { code: 'EACCES' });
  await assert.rejects(assertSafeTree(root), { code: 'ELOOP' });
  assert.equal(await assertSafePath(root, path.join(root, 'new/deep')), path.join(root, 'new/deep'));
  await assert.rejects(assertSafePath(root, path.join(root, 'new'), { allowMissing: false }), { code: 'ENOENT' });
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
});

test('configured root aliases are canonical, revisions change and runtime roots fail closed', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'root');
  const alias = path.join(parent, 'alias');
  await fs.mkdir(root);
  await fs.symlink(root, alias);
  const config = rootPath => ({ fileSystem: { locations: [{ id: 'a', displayName: 'A', rootPath }] } });
  const manager = new LocationManager(config(alias));
  assert.equal(await manager.resolveCheckedPath('a', 'new'), path.join(root, 'new'));
  assert.equal(await assertSafePath(alias, path.join(alias, 'new')), path.join(root, 'new'));
  assert.match(manager.getRevision('a'), /^[a-f0-9]{64}$/);
  assert.notEqual(manager.getRevision('a'), new LocationManager(config(root)).getRevision('a'));
  assert.equal(JSON.stringify(manager.getPublicLocations()).includes(parent), false);
  await assert.rejects(manager.resolveCheckedPath('a', '', { protectRoot: true }), { code: 'EPERM' });
  await fs.rename(root, `${root}-old`);
  await fs.mkdir(root);
  await assert.rejects(manager.resolveCheckedPath('a', ''), { code: 'ESTALE' });
  assert.equal((await manager.getHealth('a')).errorCode, 'ESTALE');
  const offline = new LocationManager({ fileSystem: { locations: [{ id: 'nfs', displayName: 'NFS', rootPath: root, storageType: 'nfs' }] } }, { platform: 'linux', mountInfoReader: async () => '' });
  await assert.rejects(offline.resolveCheckedPath('nfs', ''), { code: 'NOT_MOUNTED' });
});

test('primitive reads and mutations reject symlinks and preserve the outside sentinel', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'root');
  await fs.mkdir(root);
  const outside = path.join(parent, 'outside');
  await fs.writeFile(outside, 'safe');
  const link = path.join(root, 'link');
  await fs.symlink(outside, link);
  const local = new LocalFileSystem({ storagePath: root });
  for (const operation of [() => local.read(link), () => local.write(link, 'bad'), () => local.stat(link), () => local.exists(link), () => local.list(root), () => local.delete(link), () => local.copy(root, path.join(parent, 'copy'))]) {
    await assert.rejects(operation());
  }
  assert.equal(await local.exists(path.join(root, 'missing')), false);
  await assert.rejects(local.exists(path.join(root, 'link/child')), { code: 'ELOOP' });
  assert.equal(await fs.readFile(outside, 'utf8'), 'safe');
});

test('copy preflights recursive links, existing destination trees and nested hard links', async t => {
  const root = await fixture(t);
  const local = new LocalFileSystem({ storagePath: root });
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  await fs.mkdir(path.join(source, 'deep'), { recursive: true });
  await fs.writeFile(path.join(source, 'file'), 'original');
  await fs.symlink(path.join(source, 'file'), path.join(source, 'deep/link'));
  await assert.rejects(local.copy(source, destination), { code: 'ELOOP' });
  assert.equal(await local.exists(destination), false);
  await assert.rejects(local.delete(source), { code: 'ELOOP' });
  await fs.unlink(path.join(source, 'deep/link'));
  await fs.mkdir(destination);
  await fs.link(path.join(source, 'file'), path.join(destination, 'file'));
  await assert.rejects(local.copy(source, destination), { code: 'EINVAL' });
  assert.equal(await fs.readFile(path.join(source, 'file'), 'utf8'), 'original');
  await fs.unlink(path.join(destination, 'file'));
  await fs.symlink(source, path.join(destination, 'unrelated-link'));
  await assert.rejects(local.copy(source, destination), { code: 'ELOOP' });
  await fs.unlink(path.join(destination, 'unrelated-link'));
  await local.copy(source, destination);
  assert.equal(await fs.readFile(path.join(destination, 'file'), 'utf8'), 'original');
});

test('same object, hard links, descendants, ancestors and root mutations are rejected', async t => {
  const root = await fixture(t);
  const local = new LocalFileSystem({ storagePath: root });
  const file = path.join(root, 'file');
  const hardlink = path.join(root, 'hardlink');
  await fs.writeFile(file, 'sole content');
  await fs.link(file, hardlink);
  for (const method of ['copy', 'move', 'rename']) {
    await assert.rejects(local[method](file, file), { code: 'EINVAL' });
    await assert.rejects(local[method](file, hardlink), { code: 'EINVAL' });
    await assert.rejects(local[method](root, path.join(root, 'child')));
    await assert.rejects(local[method](file, root));
  }
  await assert.rejects(local.delete(root), { code: 'EPERM' });
  await assert.rejects(local.write(root, 'bad'), { code: 'EPERM' });
  await assert.rejects(assertTransferPaths(file, root), { code: 'EINVAL' });
  const nested = path.join(root, 'nested');
  await fs.mkdir(nested);
  for (const method of ['copy', 'move', 'rename']) await assert.rejects(local[method](nested, path.join(nested, 'child')), { code: 'EINVAL' });
  const overlapping = new EnhancedMemoryFileSystem(root, { locationId: 'overlap' });
  t.after(() => overlapping.close());
  await assert.rejects(overlapping.move(file, hardlink), { code: 'EINVAL' });
  assert.equal(await fs.readFile(file, 'utf8'), 'sole content');
});

test('move falls back only on EXDEV, preserves failure codes and never deletes after failed copy', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  await fs.writeFile(source, 'content');
  const local = new LocalFileSystem({ storagePath: root });
  let copies = 0;
  let deletes = 0;
  local.rename = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  local.copy = async () => { copies++; throw Object.assign(new Error('copy failed'), { code: 'ENOSPC' }); };
  local.delete = async () => { deletes++; };
  await assert.rejects(local.move(source, destination), { code: 'EACCES' });
  assert.equal(copies, 0);
  local.rename = async () => { throw Object.assign(new Error('cross device'), { code: 'EXDEV' }); };
  await assert.rejects(local.move(source, destination), { code: 'ENOSPC' });
  assert.equal(copies, 1);
  assert.equal(deletes, 0);
  local.copy = LocalFileSystem.prototype.copy;
  local.delete = async () => { throw Object.assign(new Error('delete failed'), { code: 'EPERM' }); };
  await assert.rejects(local.move(source, destination), { code: 'EPERM' });
  assert.equal(await fs.readFile(source, 'utf8'), 'content');
  assert.equal(await fs.readFile(destination, 'utf8'), 'content');
  local.delete = LocalFileSystem.prototype.delete;
  await local.move(source, destination);
  assert.equal(await local.exists(source), false);
});

test('destination primitive permits checked cross-Location and trusted temp sources', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'destination-root');
  await fs.mkdir(root);
  const local = new LocalFileSystem({ storagePath: root });
  const source = path.join(parent, 'staged');
  await fs.writeFile(source, 'staged content');
  await local.copy(source, path.join(root, 'copy'));
  local.rename = async () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); };
  await local.move(source, path.join(root, 'moved'));
  assert.equal(await fs.readFile(path.join(root, 'moved'), 'utf8'), 'staged content');
  await assert.rejects(fs.lstat(source), { code: 'ENOENT' });
});

test('ancestor locks span cross-instance copy/delete and allow disjoint work', { timeout: 5000 }, async t => {
  const root = await fixture(t);
  const sourceRoot = path.join(root, 'source');
  const destinationRoot = path.join(root, 'destination');
  await fs.mkdir(sourceRoot);
  await fs.mkdir(destinationRoot);
  const source = path.join(sourceRoot, 'file');
  const destination = path.join(destinationRoot, 'file');
  await fs.writeFile(source, 'before');
  const a = new EnhancedMemoryFileSystem(sourceRoot, { locationId: 'a' });
  const b = new EnhancedMemoryFileSystem(destinationRoot, { locationId: 'b' });
  t.after(async () => { await a.close(); await b.close(); });
  const copied = barrier();
  const release = barrier();
  const transaction = withOperationLocks([sourceRoot, destination], async () => {
    await b.copy(source, destination);
    copied.resolve();
    await release.promise;
    await a.delete(source);
  });
  await copied.promise;
  let wrote = false;
  const write = a.write(source, 'after').then(() => { wrote = true; });
  await withOperationLocks([path.join(root, 'disjoint')], async () => {});
  await tick();
  assert.equal(wrote, false);
  release.resolve();
  await Promise.all([transaction, write]);
  assert.equal(await fs.readFile(destination, 'utf8'), 'before');
  assert.equal(await fs.readFile(source, 'utf8'), 'after');
});

test('atomic reversed locks, inode aliases, cancellation and reentrant waiters settle', { timeout: 5000 }, async t => {
  const root = await fixture(t);
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  await fs.writeFile(a, 'a');
  await fs.link(a, b);
  const entered = barrier();
  const release = barrier();
  const first = withOperationLocks([a], async () => {
    entered.resolve();
    await release.promise;
    await withOperationLocks([a], async () => {});
  });
  await entered.promise;
  let secondEntered = false;
  const second = withOperationLocks([b, a], async () => { secondEntered = true; });
  const controller = new AbortController();
  const cancelled = withOperationLocks([root], async () => assert.fail('cancelled callback ran'), { signal: controller.signal });
  const rejection = assert.rejects(cancelled, { code: 'ABORT_ERR' });
  controller.abort();
  await rejection;
  await tick();
  assert.equal(secondEntered, false);
  release.resolve();
  await Promise.all([first, second]);
  await Promise.all([withOperationLocks([a, b], async () => tick()), withOperationLocks([b, a], async () => {})]);
  await assert.rejects(withOperationLocks([a], async () => { throw new Error('failure'); }), /failure/);
  await withOperationLocks([a], async () => {});
});

test('filesystem close drains admitted mutations and rejects later work', { timeout: 5000 }, async t => {
  const root = await fixture(t);
  const file = path.join(root, 'file');
  const instance = new EnhancedMemoryFileSystem(root);
  const entered = barrier();
  const release = barrier();
  instance.backend.write = async () => { entered.resolve(); await release.promise; await fs.writeFile(file, 'settled'); };
  const write = instance.write(file, 'content');
  await entered.promise;
  let closed = false;
  const close = instance.close().then(() => { closed = true; });
  await assert.rejects(instance.write(file, 'late'), { code: 'ESHUTDOWN' });
  await tick();
  assert.equal(closed, false);
  release.resolve();
  await Promise.all([write, close]);
  assert.equal(await fs.readFile(file, 'utf8'), 'settled');
});

test('directory move transaction retains discovered hard-link identities through deletion', { timeout: 5000 }, async t => {
  const root = await fixture(t);
  const local = new LocalFileSystem({ storagePath: root });
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  const alias = path.join(root, 'alias');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'file'), 'before');
  await fs.link(path.join(source, 'file'), alias);
  const copied = barrier();
  const release = barrier();
  const move = withOperationLocks([source, destination], async () => {
    await local.copy(source, destination);
    copied.resolve();
    await release.promise;
    await local.delete(source);
  });
  await copied.promise;
  let wrote = false;
  const write = local.write(alias, 'after').then(() => { wrote = true; });
  await tick();
  assert.equal(wrote, false);
  release.resolve();
  await Promise.all([move, write]);
  assert.equal(await fs.readFile(path.join(destination, 'file'), 'utf8'), 'before');
  assert.equal(await fs.readFile(alias, 'utf8'), 'after');
});

test('case aliases cannot turn a directory copy into a descendant copy', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'MixedCase');
  await fs.mkdir(source);
  try { await fs.stat(path.join(root, 'mixedcase')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.skip('Fixture filesystem is case-sensitive');
    return;
  }
  await assert.rejects(new LocalFileSystem({ storagePath: root }).copy(source, path.join(root, 'mixedcase/child')), { code: 'EINVAL' });
});

test('reversed nested expansions fail instead of deadlocking and release their locks', { timeout: 5000 }, async t => {
  const root = await fixture(t);
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  const entered = barrier();
  const release = barrier();
  const first = withOperationLocks([a], async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  await withOperationLocks([b], async () => {
    await assert.rejects(withOperationLocks([a], async () => assert.fail('must not run')), { code: 'EDEADLK' });
  });
  release.resolve();
  await first;
  await withOperationLocks([a, b], async () => {});
});

test('checked exists propagates access denial and I/O failures', async t => {
  const root = await fixture(t);
  const local = new LocalFileSystem({ storagePath: root });
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    local.checked = async () => { throw Object.assign(new Error(code), { code }); };
    await assert.rejects(local.exists(path.join(root, 'file')), { code });
  }
});

test('tree identity expansion rejects an active alias owner rather than waiting under a parent lock', { timeout: 5000 }, async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  const alias = path.join(root, 'alias');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'file'), 'before');
  await fs.link(path.join(source, 'file'), alias);
  const entered = barrier();
  const release = barrier();
  const held = withOperationLocks([alias], async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  try {
    const local = new LocalFileSystem({ storagePath: root });
    await assert.rejects(local.copy(source, path.join(root, 'destination')), { code: 'EDEADLK' });
    assert.equal(await local.exists(path.join(root, 'destination')), false);
  } finally { release.resolve(); await held; }
});

test('queued locks recheck replacement inode aliases before dispatch', { timeout: 5000 }, async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  const replacement = path.join(root, 'replacement');
  const alias = path.join(root, 'alias');
  await fs.writeFile(source, 'old');
  await fs.writeFile(replacement, 'replacement');
  await fs.link(replacement, alias);
  const pathEntered = barrier();
  const pathRelease = barrier();
  const aliasEntered = barrier();
  const aliasRelease = barrier();
  const pathOwner = withOperationLocks([source], async () => { pathEntered.resolve(); await pathRelease.promise; });
  const aliasOwner = withOperationLocks([alias], async () => { aliasEntered.resolve(); await aliasRelease.promise; });
  await Promise.all([pathEntered.promise, aliasEntered.promise]);
  const observed = barrier();
  const stat = fs.stat;
  const spy = t.mock.method(fs, 'stat', async (...args) => {
    const result = await stat(...args);
    if (args[0] === source) observed.resolve();
    return result;
  });
  let wrote = false;
  const writer = new LocalFileSystem({ storagePath: root }).write(source, 'new').then(() => { wrote = true; });
  await observed.promise;
  await tick();
  spy.mock.restore();
  await fs.rename(replacement, source);
  pathRelease.resolve();
  await pathOwner;
  await tick();
  assert.equal(wrote, false);
  aliasRelease.resolve();
  await Promise.all([aliasOwner, writer]);
  assert.equal(await fs.readFile(alias, 'utf8'), 'new');
});

test('missing case-alias names share a reservation lock', { timeout: 5000 }, async t => {
  const root = await fixture(t);
  const entered = barrier();
  const release = barrier();
  const first = withOperationLocks([path.join(root, 'NewFile')], async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let admitted = false;
  const second = withOperationLocks([path.join(root, 'newfile')], async () => { admitted = true; });
  await tick();
  assert.equal(admitted, false);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(admitted, true);
});
