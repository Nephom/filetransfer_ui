const EventEmitter = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const { createClient } = require('redis');
const path = require('node:path');
const fs = require('node:fs').promises;
const { performance } = require('node:perf_hooks');
const { assertSafePath, assertSafeTree, containsPath, pathError } = require('./path-safety');

class RedisFileSystemCache extends EventEmitter {
  constructor(storagePath = './storage', options = {}) {
    super();
    const { locationId = 'default', redisClient, cacheTtlMs = 3000, ...redisOptions } = options;
    this.cacheTtlMs = Number.isFinite(cacheTtlMs) ? Math.max(0, Math.min(cacheTtlMs, 3000)) : 3000;
    this.storagePath = path.resolve(storagePath);
    this.configuredRoot = this.storagePath;
    this.locationId = locationId;
    this.redisOptions = redisOptions;
    this.redisClient = redisClient || null;
    this.initialized = false;
    this.rootIdentity = null;
    this.namespace = null;
    this.directoryCache = new Map();
    this.snapshotMetadata = new WeakMap();
    this.directoryMtimes = new Map();
    this.activeDirs = new Set();
    this.hotCache = new Map();
    this.hotCacheMaxSize = 50;
    this.hotCacheAccessOrder = [];
    this.lastMtimeCheck = new Map();
    this.mtimeCheckThrottle = 2000;
    this.rootPollFrequency = 3000;
    this.rootPollingInterval = null;
    this.indexingInterval = null;
    this.isIndexing = false;
    this.indexProgress = { current: 0, total: 0, status: 'idle' };
    this.lastIndex = null;
    this.metrics = { directoryScans: 0, scanErrors: 0, hotCacheHits: 0, memoryCacheHits: 0, redisCacheHits: 0, redisErrors: 0, cacheMisses: 0 };
    this.work = Promise.resolve();
    this.reads = new Set();
    this.workContext = new AsyncLocalStorage();
    this.closing = false;
    this.closed = false;
    this.generation = 0;
    this.snapshotGeneration = 0;
  }

  // Serialize scans and Redis work, including timers, so clear and close have a real
  // settlement boundary. Nested public aliases stay in the admitted job.
  _run(callback) {
    if (this.workContext.getStore() === this) return callback();
    if (this.closing || this.closed) return Promise.reject(pathError('ESHUTDOWN', 'Cache is closing'));
    const background = this.workContext.getStore();
    const job = this.work.then(() => this.workContext.run(this, async () => {
      if (background && (background.generation !== this.generation || this.closing)) return;
      await this._checked(this.configuredRoot);
      return callback();
    }));
    this.work = job.catch(() => {});
    return job;
  }

  _read(callback) {
    if (this.closing || this.closed) return Promise.reject(pathError('ESHUTDOWN', 'Cache is closing'));
    const job = Promise.resolve().then(callback).then(result => {
      if (this.closing || this.closed) throw pathError('ESHUTDOWN', 'Cache is closing');
      return result;
    });
    this.reads.add(job);
    job.then(() => this.reads.delete(job), () => this.reads.delete(job));
    return job;
  }

  async _checked(target, options = {}) {
    const canonical = await fs.realpath(this.configuredRoot);
    const stats = await fs.stat(canonical);
    const identity = `${canonical}:${stats.dev}:${stats.ino}`;
    if (this.rootIdentity && identity !== this.rootIdentity) throw pathError('ESTALE', 'Cache root identity changed');
    if (!this.rootIdentity) {
      this.rootIdentity = identity;
      this.storagePath = canonical;
      this.namespace = `fs:v2:${createHash('sha256').update(JSON.stringify([this.locationId, identity])).digest('hex')}:`;
    }
    return assertSafePath(this.configuredRoot, target, options);
  }

  key(family, relative = '') {
    if (!this.namespace) throw pathError('EINVAL', 'Cache root has not been checked');
    return `${this.namespace}${family}:${Buffer.from(relative).toString('base64url')}`;
  }

  async *_keys(family = '') {
    if (!this.redisClient?.isReady) return;
    const prefix = `${this.namespace}${family ? `${family}:` : ''}`;
    for await (const batch of this.redisClient.scanIterator({ MATCH: `${prefix}*`, COUNT: 1000 })) {
      for (const key of Array.isArray(batch) ? batch : [batch]) if (key.startsWith(prefix)) yield key;
    }
  }

  async _deleteKeys(family = '', predicate = () => true) {
    const batch = [];
    for await (const key of this._keys(family)) {
      if (!predicate(key)) continue;
      batch.push(key);
      if (batch.length === 1000) { await this.redisClient.del(batch); batch.length = 0; }
    }
    if (batch.length) await this.redisClient.del(batch);
  }

  initialize() {
    if (this.closing || this.closed) return Promise.reject(pathError('ESHUTDOWN', 'Cache is closing'));
    if (this.initialization) return this.initialization;
    if (this.initialized) return Promise.resolve(true);
    this.initialization = this._run(async () => {
      if (!this.redisClient) {
        this.redisClient = createClient(this.redisOptions);
        this.redisClient.on('error', error => this.emit('warning', { code: error.code || 'REDIS_ERROR' }));
      }
      if (!this.redisClient.isReady) await this.redisClient.connect();
      // Cold migration: do not read or remove any unscoped legacy data.
      await this._deleteKeys();
      await this.updateDirectoryCache(this.storagePath);
      this.initialized = true;
      if (!this.closing) {
        this.startRootPolling();
        this.startPeriodicIndexing();
      }
      return true;
    }).finally(() => { this.initialization = null; });
    return this.initialization;
  }

  createStorageError(error, operation) {
    const result = new Error(`Storage operation failed during ${operation}`, { cause: error });
    Object.assign(result, { name: 'StorageCacheError', code: error.code || error.storageCode || 'STORAGE_ERROR', storageCode: error.storageCode || error.code || 'STORAGE_ERROR', operation, statusCode: 503 });
    return result;
  }

  async checkAndLoadRootCache() { return this._run(async () => true); }

  _background(callback) {
    if (this.closing || this.closed) return;
    const generation = this.generation;
    // Timers created inside initialize must not inherit its reentrant job token.
    this.workContext.run({ generation }, () => callback().catch(error => this.emit('warning', { code: error.code || 'CACHE_ERROR' })));
  }

  startRootPolling() {
    if (this.rootPollingInterval || this.closing || this.closed) return;
    this.rootPollingInterval = setInterval(() => this._background(() => this.refreshCache()), this.rootPollFrequency);
    this.rootPollingInterval.unref?.();
  }
  stopRootPolling() { clearInterval(this.rootPollingInterval); this.rootPollingInterval = null; }
  startPeriodicIndexing(intervalHours = 6, { immediate = true } = {}) {
    if (this.indexingInterval || this.closing || this.closed) return;
    this.indexingInterval = setInterval(() => this._background(() => this.buildIncrementalIndex()), intervalHours * 3600000);
    this.indexingInterval.unref?.();
    if (immediate) this._background(() => this.buildGlobalIndex());
  }
  stopPeriodicIndexing() { clearInterval(this.indexingInterval); this.indexingInterval = null; }

  async loadIgnoreList() {
    const defaults = ['node_modules', '.git', '.Trash-1000', 'vm', '.nfs'];
    try {
      const text = await fs.readFile(path.join(__dirname, '../../../.ignoreDirs'), 'utf8');
      return [...defaults, ...text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))];
    } catch (error) { if (error.code !== 'ENOENT') throw error; return defaults; }
  }

  updateHotCache(absolutePath, contents) {
    this.hotCache.delete(absolutePath);
    this.hotCache.set(absolutePath, { contents, timestamp: this.snapshotMetadata.get(contents)?.timestamp });
    while (this.hotCache.size > this.hotCacheMaxSize) this.hotCache.delete(this.hotCache.keys().next().value);
    this.hotCacheAccessOrder = [...this.hotCache.keys()];
  }
  getFromHotCache(absolutePath) { return this.hotCache.get(absolutePath)?.contents || null; }
  shouldCheckMtime(absolutePath) { return Date.now() - (this.lastMtimeCheck.get(absolutePath) || 0) > this.mtimeCheckThrottle; }

  async _scan(dirPath) {
    const absolute = await this._checked(dirPath, { allowMissing: false });
    const ignored = await this.loadIgnoreList();
    const contents = [];
    for (const name of await fs.readdir(absolute)) {
      // Check links even when the name is excluded from the search index.
      const fullPath = await this._checked(path.join(absolute, name), { allowMissing: false });
      const stats = await fs.lstat(fullPath);
      if (ignored.includes(name)) continue;
      const data = { path: fullPath, name, size: stats.size, modified: stats.mtimeMs, isDirectory: stats.isDirectory() };
      if (!data.isDirectory) data.hash = `${stats.size}-${stats.mtimeMs}`;
      contents.push(data);
    }
    const stats = await fs.lstat(absolute);
    return { absolute, contents, mtime: stats.mtimeMs, stats };
  }

  updateDirectoryCache(dirPath, recursive = false) {
    return this._run(async () => {
      if (recursive) {
        const absolute = await this._checked(dirPath, { allowMissing: false });
        const entries = await assertSafeTree(absolute);
        if (!entries[0].stats.isDirectory()) throw pathError('ENOTDIR', 'Index target is not a directory');
        const ignored = await this.loadIgnoreList();
        let contents;
        // Preflight the selected subtree once, not the entire Location or each
        // descendant tree again. Normal file mutations only scan their parents.
        for (const entry of entries) {
          if (!entry.stats.isDirectory() || path.relative(absolute, entry.path).split(path.sep).some(name => ignored.includes(name))) continue;
          const current = await this.updateDirectoryCache(entry.path);
          if (entry.path === absolute) contents = current;
        }
        return contents;
      }
      this.metrics.directoryScans++;
      try {
        const generation = this.snapshotGeneration;
        const timestamp = performance.now();
        const { absolute, contents, mtime, stats } = await this._scan(dirPath);
        for (const entry of contents) Object.freeze(entry);
        Object.freeze(contents);
        if (this.redisClient?.isReady) {
          const children = new Map(contents.map(entry => [entry.name, entry]));
          // Preserve unchanged descendants. Remove only missing immediate
          // children and subtrees whose former directory is gone or now a file.
          for (const family of ['entry', 'mtime', 'dir']) {
            await this._deleteKeys(family, key => {
              const relativeKey = Buffer.from(key.slice(`${this.namespace}${family}:`.length), 'base64url').toString();
              const candidate = path.resolve(this.storagePath, relativeKey);
              if (candidate === absolute || !containsPath(absolute, candidate)) return false;
              const relative = path.relative(absolute, candidate);
              const name = relative.split(path.sep)[0];
              const child = children.get(name);
              return !child || (!child.isDirectory && (relative !== name || family !== 'entry'));
            });
          }
          for (const entry of contents) {
            const relative = path.relative(this.storagePath, entry.path);
            await this.redisClient.set(this.key('entry', relative), JSON.stringify({ ...entry, path: relative }));
          }
          const relativeDirectory = path.relative(this.storagePath, absolute);
          if (relativeDirectory) await this.redisClient.set(this.key('entry', relativeDirectory), JSON.stringify({ path: relativeDirectory, name: path.basename(absolute), size: stats.size, modified: mtime, isDirectory: true }));
          await this.redisClient.set(this.key('mtime', path.relative(this.storagePath, absolute)), String(mtime));
          await this.redisClient.hSet(this.key('dir', path.relative(this.storagePath, absolute)), {
            contents: JSON.stringify(contents), cached: String(Date.now()), mtime: String(mtime), isRoot: String(absolute === this.storagePath)
          });
        }
        if (generation === this.snapshotGeneration) {
          this.snapshotMetadata.set(contents, { timestamp, generation });
          this.directoryCache.set(absolute, contents);
          this.directoryMtimes.set(absolute, mtime);
          this.updateHotCache(absolute, contents);
        }
        return contents;
      } catch (error) {
        this.metrics.scanErrors++;
        throw this.createStorageError(error, 'directory_scan');
      }
    });
  }

  getDirectoryContents(dirPath) {
    return this._read(async () => {
      const cachedContents = async () => {
        const generation = this.snapshotGeneration;
        const absolute = await this._checked(dirPath, { allowMissing: false });
        const stats = await fs.lstat(absolute);
        if (!stats.isDirectory()) throw pathError('ENOTDIR', 'Cached listing target is not a directory');
        const hot = this.getFromHotCache(absolute);
        const contents = hot || this.directoryCache.get(absolute);
        const metadata = contents && this.snapshotMetadata.get(contents);
        if (!metadata || generation !== this.snapshotGeneration || metadata.generation !== generation
          || performance.now() - metadata.timestamp >= this.cacheTtlMs
          || this.directoryMtimes.get(absolute) !== stats.mtimeMs) return null;
        this.metrics[hot ? 'hotCacheHits' : 'memoryCacheHits']++;
        this.updateHotCache(absolute, contents);
        return contents;
      };
      const cached = await cachedContents();
      if (cached) return cached;
      return this._run(async () => {
        // Coalesce concurrent misses and the server's enterDirectory/list pair.
        const refreshed = await cachedContents();
        if (refreshed) return refreshed;
        this.metrics.cacheMisses++;
        return this.updateDirectoryCache(dirPath);
      });
    });
  }
  enterDirectory(dirPath) {
    return this._read(async () => {
      const absolute = await this._checked(dirPath, { allowMissing: false });
      const contents = await this.getDirectoryContents(absolute);
      this.activeDirs.add(absolute);
      return contents;
    });
  }
  leaveDirectory(dirPath) {
    return this._run(async () => {
      const absolute = await this._checked(dirPath);
      this.activeDirs.delete(absolute);
      if (absolute !== this.storagePath) await this.invalidateDirectory(absolute, { preserveIndex: true });
    });
  }

  invalidateDirectory(dirPath, { recursive = false, preserveIndex = false } = {}) {
    // Expire snapshots immediately, even if Redis invalidation waits for indexing.
    this.snapshotGeneration++;
    return this._run(async () => {
      const absolute = await this._checked(dirPath);
      const matches = candidate => candidate === absolute || (recursive && containsPath(absolute, candidate));
      for (const cache of [this.directoryCache, this.directoryMtimes, this.lastMtimeCheck, this.hotCache]) {
        for (const candidate of cache.keys()) if (matches(candidate)) cache.delete(candidate);
      }
      this.hotCacheAccessOrder = [...this.hotCache.keys()];
      // Decode opaque key suffixes instead of inserting paths into Redis globs.
      for (const family of preserveIndex ? ['dir'] : ['dir', 'entry', 'mtime']) {
        await this._deleteKeys(family, key => {
          const relative = Buffer.from(key.slice(`${this.namespace}${family}:`.length), 'base64url').toString();
          const candidate = path.resolve(this.storagePath, relative);
          return matches(candidate) || (family === 'entry' && path.dirname(candidate) === absolute);
        });
      }
    });
  }

  refreshDirectory(dirPath) { return this.updateDirectoryCache(dirPath); }
  refreshPaths(paths) {
    this.snapshotGeneration++;
    return this._run(async () => {
      const parents = new Set();
      const trees = new Set();
      for (const target of paths) {
        const absolute = await this._checked(target);
        await this.invalidateDirectory(absolute, { recursive: true });
        try {
          if ((await fs.lstat(absolute)).isDirectory()) trees.add(absolute);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        // Include ancestors for newly created nested folders. Each is scanned
        // non-recursively, so sibling directory contents are never traversed.
        for (let parent = path.dirname(absolute); containsPath(this.storagePath, parent); parent = path.dirname(parent)) {
          parents.add(parent);
          if (parent === this.storagePath) break;
        }
      }
      const selectedTrees = [...trees].filter(tree => ![...trees].some(other => other !== tree && containsPath(other, tree)));
      for (const parent of parents) {
        if (selectedTrees.some(tree => containsPath(tree, parent))) continue;
        try { await this._checked(parent, { allowMissing: false }); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        await this.updateDirectoryCache(parent);
      }
      for (const tree of selectedTrees) await this.updateDirectoryCache(tree, true);
    });
  }
  scanDirectory(dirPath) { return this.updateDirectoryCache(dirPath); }
  refreshCache() { return this.updateDirectoryCache(this.storagePath); }
  getFilesInDirectory(dirPath) { return this.enterDirectory(dirPath); }
  getFilesInDirectoryPaginated(dirPath, offset = 0, limit = 1000) {
    return this._read(async () => {
      const all = await this.enterDirectory(dirPath);
      const start = Math.max(0, Number(offset) || 0);
      const end = limit > 0 ? Math.min(start + Number(limit), all.length) : all.length;
      return { files: all.slice(start, end), total: all.length, offset: start, limit, hasMore: end < all.length };
    });
  }

  getFileInfo(filePath) {
    return this._run(async () => {
      const absolute = await this._checked(path.isAbsolute(filePath) ? filePath : path.resolve(this.storagePath, filePath), { allowMissing: false });
      const stats = await fs.lstat(absolute);
      return { path: path.relative(this.storagePath, absolute), name: path.basename(absolute), size: stats.size, modified: stats.mtimeMs, isDirectory: stats.isDirectory() };
    });
  }

  searchFiles(query) {
    return this._run(async () => {
      const files = [];
      const literal = String(query).toLowerCase();
      for await (const key of this._keys('entry')) {
        let record;
        try { record = JSON.parse(await this.redisClient.get(key)); } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
        if (!record || typeof record.name !== 'string' || typeof record.path !== 'string' || !record.name.toLowerCase().includes(literal)) continue;
        try {
          const current = await this.getFileInfo(record.path);
          files.push(current);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await this.redisClient.del(key);
          continue;
        }
        if (files.length >= 1000) break;
      }
      const status = await this.getIndexStatus();
      return { files, indexing: false, indexUpdating: this.isIndexing, indexStats: status.lastIndex, resultCount: files.length };
    });
  }

  buildGlobalIndex(force = false) {
    if (this.indexJob) return this.indexJob;
    this.indexJob = this._run(async () => {
      this.isIndexing = true;
      this.indexProgress = { current: 0, total: 0, status: 'scanning' };
      try {
        const start = Date.now();
        const entries = await assertSafeTree(await this._checked(this.storagePath, { allowMissing: false }));
        const ignored = await this.loadIgnoreList();
        await this._deleteKeys('entry');
        await this._deleteKeys('mtime');
        for (const { path: absolute, stats } of entries) {
          const relative = path.relative(this.storagePath, absolute);
          if (relative.split(path.sep).some(component => ignored.includes(component))) continue;
          if (stats.isDirectory() && this.redisClient?.isReady) await this.redisClient.set(this.key('mtime', relative), String(stats.mtimeMs));
          if (!relative) continue;
          const record = { path: relative, name: path.basename(absolute), size: stats.size, modified: stats.mtimeMs, isDirectory: stats.isDirectory() };
          if (this.redisClient?.isReady) await this.redisClient.set(this.key('entry', relative), JSON.stringify(record));
          this.indexProgress.current++;
        }
        this.indexProgress.total = this.indexProgress.current;
        this.indexProgress.status = 'completed';
        const lastIndex = { lastUpdated: Date.now(), totalFiles: this.indexProgress.current, duration: ((Date.now() - start) / 1000).toFixed(2), status: 'completed', type: force ? 'full' : 'refresh' };
        if (this.redisClient?.isReady) await this.redisClient.set(this.key('meta', 'index'), JSON.stringify(lastIndex));
        this.lastIndex = Object.freeze(lastIndex);
      } catch (error) {
        this.indexProgress.status = 'error';
        throw error;
      } finally { this.isIndexing = false; }
    }).finally(() => { this.indexJob = null; });
    return this.indexJob;
  }

  buildIncrementalIndex() { return this.buildGlobalIndex(); }
  indexDirectory(dirPath, ignoreList) { return this.updateDirectoryCache(dirPath, true); }
  async indexDirectoryNonRecursive(dirPath, ignoreList) { return (await this.updateDirectoryCache(dirPath)).length; }
  scanForNewDirectories(startPath, ignoreList, existingDirs) { return this.indexDirectory(startPath, ignoreList); }

  getIndexStatus() {
    return this._read(async () => {
      await this._checked(this.configuredRoot, { allowMissing: false });
      return { isIndexing: this.isIndexing, progress: { ...this.indexProgress }, lastIndex: this.lastIndex && { ...this.lastIndex }, periodicIndexing: !!this.indexingInterval };
    });
  }
  getCacheInfo() {
    return this._run(async () => {
      let count = 0;
      for await (const key of this._keys()) count++;
      return { initialized: this.initialized, totalDirectories: this.directoryCache.size, activeDirectories: this.activeDirs.size, redisDbSize: count, isPolling: !!this.rootPollingInterval, pollFrequency: this.rootPollFrequency, cacheMetrics: { ...this.metrics } };
    });
  }
  getStats() { return this.getCacheInfo(); }

  clearCache() {
    this.generation++;
    this.snapshotGeneration++;
    this.stopRootPolling();
    this.stopPeriodicIndexing();
    return this._run(async () => {
      this.generation++;
      this.snapshotGeneration++;
      this.stopRootPolling();
      this.stopPeriodicIndexing();
      await this._deleteKeys();
      for (const cache of [this.directoryCache, this.directoryMtimes, this.activeDirs, this.hotCache, this.lastMtimeCheck]) cache.clear();
      this.hotCacheAccessOrder = [];
      this.indexProgress = { current: 0, total: 0, status: 'idle' };
      this.lastIndex = null;
      this.emit('clear');
      // Polling may rebuild fresh data later; no old index job survives this point.
      if (this.initialized && !this.closing) {
        this.startRootPolling();
        this.startPeriodicIndexing(6, { immediate: false });
      }
    });
  }

  close() {
    if (this.closeJob) return this.closeJob;
    this.closing = true;
    this.stopRootPolling();
    this.stopPeriodicIndexing();
    this.closeJob = (async () => {
      await this.work;
      await Promise.allSettled([...this.reads]);
      if (this.redisClient?.isOpen || this.redisClient?.isReady) await this.redisClient.quit();
      this.redisClient = null;
      this.initialized = false;
      this.closed = true;
      for (const cache of [this.directoryCache, this.directoryMtimes, this.activeDirs, this.hotCache, this.lastMtimeCheck]) cache.clear();
      this.hotCacheAccessOrder = [];
    })();
    return this.closeJob;
  }
}

module.exports = RedisFileSystemCache;
