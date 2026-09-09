const { FileSystem } = require('./base');
const RedisFileSystemCache = require('./memory-cache');
const { withOperationLocks } = require('./operation-locks');
const { containsPath, pathError } = require('./path-safety');
const path = require('node:path');

// Cache invalidation includes overlapping roots, not just the destination view.
const instances = new Set();

class EnhancedMemoryFileSystem extends FileSystem {
  constructor(storagePath, { locationId = 'default' } = {}) {
    super({ storagePath });
    this.storagePath = path.resolve(storagePath);
    this.locationId = locationId;
    this.cache = new RedisFileSystemCache(storagePath, { locationId });
    this.initialized = false;
    this.pending = new Set();
    this.closing = false;
    instances.add(this);
  }

  _run(callback) {
    if (this.closing) return Promise.reject(pathError('ESHUTDOWN', 'Filesystem is closing'));
    const job = Promise.resolve().then(callback);
    this.pending.add(job);
    job.then(() => this.pending.delete(job), () => this.pending.delete(job));
    return job;
  }

  initialize() {
    if (this.closing) return Promise.reject(pathError('ESHUTDOWN', 'Filesystem is closing'));
    if (this.initialized) return Promise.resolve();
    if (!this.initialization) this.initialization = this._run(async () => {
      await this.backend.checked(this.storagePath, { allowMissing: false });
      await this.cache.initialize();
      this.initialized = true;
    }).finally(() => { this.initialization = null; });
    return this.initialization;
  }

  async _mutate(paths, callback, { signal, changedPaths = paths } = {}) {
    return this._run(() => withOperationLocks(paths, async () => {
      try { return await callback(); }
      finally {
        // A failed copy can leave partial destination data. Reconcile it too.
        for (const instance of instances) {
          if (!instance.initialized || instance.closing) continue;
          const affected = new Set();
          const root = instance.cache.storagePath;
          for (const target of changedPaths) {
            const absolute = path.resolve(target);
            if (containsPath(root, absolute)) affected.add(absolute);
            else if (containsPath(absolute, root)) affected.add(root);
          }
          if (!affected.size) continue;
          try {
            await instance.cache.refreshPaths([...affected]);
          } catch (error) {
            // Storage mutation already settled. A cache failure must not make
            // callers retry committed writes; actual I/O rechecks paths and metadata expires.
            instance.cache.emit('warning', { code: error.code || 'CACHE_ERROR' });
          }
        }
      }
    }, { signal }));
  }

  read(target) { return this._run(() => super.read(target)); }
  exists(target) { return this._run(() => super.exists(target)); }
  stat(target) { return this._run(() => super.stat(target)); }
  list(target, options = {}) {
    return this._run(async () => {
      target = await this.backend.checked(target, { allowMissing: false });
      if (!this.initialized) return super.list(target);
      if (options.offset !== undefined || options.limit !== undefined) return this.cache.getFilesInDirectoryPaginated(target, options.offset ?? 0, options.limit ?? 1000);
      return this.cache.getFilesInDirectory(target);
    });
  }
  mkdir(target) { return this._mutate([target], () => super.mkdir(target)); }
  write(target, content, options = {}) { return this._mutate([target], () => super.write(target, content, options), { signal: options.signal }); }
  delete(target) { return this._mutate([target], () => super.delete(target)); }
  copy(source, destination) { return this._mutate([source, destination], () => super.copy(source, destination), { changedPaths: [destination] }); }
  move(source, destination) { return this._mutate([source, destination], () => super.move(source, destination)); }
  rename(source, destination) { return this._mutate([source, destination], () => super.rename(source, destination)); }
  executeWithLock(target, operation, options = {}) { return this.executeWithMultipleLocks([target], operation, options); }
  executeWithMultipleLocks(paths, operation, options = {}) { return this._run(() => withOperationLocks(paths, operation, options)); }
  getCacheStats() { return this._run(() => this.cache.getStats()); }
  getFileInfo(target) { return this._run(() => this.initialized ? this.cache.getFileInfo(target) : null); }
  searchFiles(query) { return this._run(() => this.initialized ? this.cache.searchFiles(query) : []); }
  getCacheInfo() { return this._run(async () => ({ ...(await this.cache.getStats()), initialized: this.initialized, concurrentOperations: this.pending.size, storagePath: this.storagePath })); }
  refreshCache() {
    return this._run(async () => {
      if (!this.initialized) { await this.initialize(); return; }
      await this.cache.clearCache();
      await this.cache.refreshCache();
      await this.cache.buildGlobalIndex(true);
      this.cache.startPeriodicIndexing();
    });
  }
  clearCache() { return this._run(() => this.cache.clearCache()); }
  close() {
    if (this.closeJob) return this.closeJob;
    this.closing = true;
    this.closeJob = (async () => {
      await Promise.allSettled([...this.pending]);
      await this.cache.close();
      this.initialized = false;
      instances.delete(this);
    })();
    return this.closeJob;
  }
}

module.exports = EnhancedMemoryFileSystem;
