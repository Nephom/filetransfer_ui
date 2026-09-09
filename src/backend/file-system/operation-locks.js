const fs = require('node:fs').promises;
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { containsPath, pathError } = require('./path-safety');

const context = new AsyncLocalStorage();
const active = new Set();
const waiting = [];

async function identify(input) {
  let current = path.resolve(input);
  const missing = [];
  for (;;) {
    try {
      const canonical = await fs.realpath(current);
      const stats = await fs.stat(canonical);
      // Missing names have no inode to canonicalize. Conservative folding also
      // makes new-name reservations conflict on case/Unicode-insensitive disks.
      return { path: path.join(canonical, ...missing).normalize('NFC').toLowerCase(), identity: missing.length ? null : `${stats.dev}:${stats.ino}` };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function summarize(request) {
  request.identities = new Set(request.paths.map(item => item.identity).filter(Boolean));
  request.roots = [];
  for (const candidate of [...new Set(request.paths.map(item => item.path))].sort()) {
    if (!request.roots.some(root => containsPath(root, candidate))) request.roots.push(candidate);
  }
}

async function describe(paths, signal) {
  const descriptors = [];
  for (let i = 0; i < paths.length; i += 64) {
    if (signal?.aborted) throw pathError('ABORT_ERR', 'Operation cancelled while waiting for locks');
    descriptors.push(...await Promise.all(paths.slice(i, i + 64).map(identify)));
  }
  return descriptors;
}

function conflicts(left, right) {
  if (left.roots.some(a => right.roots.some(b => containsPath(a, b) || containsPath(b, a)))) return true;
  const [small, large] = left.identities.size < right.identities.size
    ? [left.identities, right.identities] : [right.identities, left.identities];
  for (const identity of small) if (large.has(identity)) return true;
  return false;
}

function pump() {
  for (let i = 0; i < waiting.length;) {
    const request = waiting[i];
    if ([...active].some(held => held.owner !== request.owner && conflicts(held, request))
      || waiting.slice(0, i).some(earlier => earlier.owner !== request.owner && conflicts(earlier, request))) {
      i++;
      continue;
    }
    waiting.splice(i, 1);
    request.cleanup();
    active.add(request);
    request.resolve();
  }
}

async function withOperationLocks(paths, callback, { signal } = {}) {
  if (signal?.aborted) throw pathError('ABORT_ERR', 'Operation cancelled while waiting for locks');
  const descriptors = await describe(paths, signal);
  if (signal?.aborted) throw pathError('ABORT_ERR', 'Operation cancelled while waiting for locks');
  const inherited = context.getStore();
  const owner = inherited && [...active].some(held => held.owner === inherited) ? inherited : {};
  const request = { paths: descriptors, owner, cleanup() {} };
  summarize(request);
  // A caller must acquire its entire transaction up front. Refuse a contended
  // nested expansion rather than waiting while holding locks needed by its peer.
  const nested = [...active].some(held => held.owner === owner);
  if (nested && [...active].some(held => held.owner !== owner && conflicts(held, request))) {
    throw pathError('EDEADLK', 'Nested operation conflicts with another active transaction');
  }
  if (nested && waiting.some(held => held.owner !== owner && conflicts(held, request))) {
    const covered = descriptors.every(item => [...active].some(held => held.owner === owner
      && (held.roots.some(parent => containsPath(parent, item.path)) || (item.identity && held.identities.has(item.identity)))));
    if (!covered) throw pathError('EDEADLK', 'Acquire all transaction paths before entering nested operations');
  }
  await new Promise((resolve, reject) => {
    request.resolve = resolve;
    const abort = () => {
      const index = waiting.indexOf(request);
      if (index !== -1) waiting.splice(index, 1);
      request.cleanup();
      reject(pathError('ABORT_ERR', 'Operation cancelled while waiting for locks'));
      pump();
    };
    request.cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    // Reentrant calls must not queue behind a waiter blocked by their own owner.
    if (nested && ![...active].some(held => held.owner !== owner && conflicts(held, request))) {
      request.cleanup();
      active.add(request);
      resolve();
    } else {
      waiting.push(request);
      pump();
    }
  });
  try {
    // A preceding path owner may have replaced an inode while this request
    // waited. Reserve the paths, then recheck aliases before running any I/O.
    const fresh = { paths: await describe(paths, signal) };
    summarize(fresh);
    if ([...active].some(held => held.owner !== owner && conflicts(held, fresh))) {
      if (nested) throw pathError('EDEADLK', 'Nested operation discovered a conflicting replacement inode');
      active.delete(request);
      pump();
      return await withOperationLocks(paths, callback, { signal });
    }
    Object.assign(request, fresh);
    if (signal?.aborted) throw pathError('ABORT_ERR', 'Operation cancelled before dispatch');
    return await context.run(owner, callback);
  } finally {
    // Keep identities discovered by nested tree operations until the enclosing
    // transaction settles (not merely until its copy phase finishes).
    const enclosing = [...active].find(held => held !== request && held.owner === owner);
    if (enclosing) {
      const known = new Set(enclosing.paths.map(item => `${item.path}\0${item.identity}`));
      for (const item of request.paths) {
        const key = `${item.path}\0${item.identity}`;
        if (!known.has(key)) { enclosing.paths.push(item); known.add(key); }
      }
      summarize(enclosing);
    }
    active.delete(request);
    pump();
  }
}

module.exports = { withOperationLocks };
