const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { SESSION_TTL_MS } = require('./upload-session-store');

const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const SESSION_PATTERN = /^[0-9a-f-]{36}$/i;
const fault = (statusCode, message, details = {}) => Object.assign(new Error(message), { statusCode, ...details });

class ResumableUploadManager {
  constructor({ store, tempDir, fsImpl = fs, now = Date.now, reserveFreeBytes = 64 * 1024 * 1024 } = {}) {
    if (!store || !tempDir) throw new TypeError('Upload session store and temporary directory are required');
    this.store = store;
    this.fs = fsImpl;
    this.tempDir = path.resolve(tempDir);
    this.root = path.join(this.tempDir, 'resumable');
    this.now = now;
    this.reserveFreeBytes = reserveFreeBytes;
    this.fileLocks = new Map();
    this.activeOperations = new Map();
    this.capacityQueue = Promise.resolve();
  }

  async initialize() {
    await this.fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStats = await this.fs.promises.lstat(this.root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw fault(500, 'Unsafe resumable upload staging directory');
    const cleanup = await this.cleanupExpired();
    const sessions = await this.store.listAllActive();
    for (const session of sessions) {
      if (session.expiresAt <= this.now()) continue;
      if (session.status === 'cancelling') {
        await this.store.updateSession(session.sessionId, 'cancelled');
        await this._cleanupTargetTemps(session.sessionId);
        await this.fs.promises.rm(this._sessionRoot(session.sessionId), { recursive: true, force: true });
        continue;
      }
      await this._recoverSession(session);
    }
    for (const session of sessions) await this.pruneCompletedStaging(session.sessionId);
    return cleanup;
  }

  _sessionRoot(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_PATTERN.test(sessionId)) throw fault(400, 'Invalid upload session');
    return path.join(this.root, sessionId);
  }

  _filePath(sessionId, fileId) {
    if (typeof fileId !== 'string' || !SESSION_PATTERN.test(fileId)) throw fault(400, 'Invalid upload file ID');
    return path.join(this._sessionRoot(sessionId), 'files', `${fileId}.part`);
  }

  async _ensureSessionDirectory(sessionId) {
    const sessionRoot = this._sessionRoot(sessionId);
    try {
      const stats = await this.fs.promises.lstat(sessionRoot);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw fault(500, 'Unsafe resumable session staging directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.fs.promises.mkdir(sessionRoot, { recursive: false, mode: 0o700 });
    }
    const filesDirectory = path.join(sessionRoot, 'files');
    try {
      const stats = await this.fs.promises.lstat(filesDirectory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw fault(500, 'Unsafe resumable upload staging directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.fs.promises.mkdir(filesDirectory, { mode: 0o700 });
    }
    return { sessionRoot, filesDirectory };
  }

  async ensureFilePath(sessionId, fileId) {
    await this._ensureSessionDirectory(sessionId);
    return this._filePath(sessionId, fileId);
  }

  async _withFileLock(sessionId, fileId, work) {
    const key = `${sessionId}:${fileId}`;
    const prior = this.fileLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const current = prior.catch(() => {}).then(() => gate);
    this.fileLocks.set(key, current);
    await prior.catch(() => {});
    try { return await work(); }
    finally {
      release();
      if (this.fileLocks.get(key) === current) this.fileLocks.delete(key);
    }
  }

  async _assertSessionActive(session) {
    const current = session && await this.store.get(session.sessionId);
    if (!current || current.expiresAt <= this.now() ||
        ['expired', 'cancelled', 'cancelling', 'failed', 'completed'].includes(current.status)) {
      throw fault(410, 'Upload session is no longer active');
    }
    if (!current.manifestComplete) throw fault(409, 'Upload manifest is not sealed');
  }

  async withSessionOperation(sessionId, work) {
    const record = { controller: new AbortController() };
    const operations = this.activeOperations.get(sessionId) || new Set();
    operations.add(record);
    this.activeOperations.set(sessionId, operations);
    let settle;
    record.settled = new Promise(resolve => { settle = resolve; });
    try {
      await this._assertSessionActive(await this.store.get(sessionId));
      return await work(record.controller.signal);
    } finally {
      settle();
      operations.delete(record);
      if (!operations.size) this.activeOperations.delete(sessionId);
    }
  }

  async _assertFreeSpace(requiredBytes) {
    if (typeof this.fs.promises.statfs !== 'function') return;
    let stats;
    try { stats = await this.fs.promises.statfs(this.root); }
    catch { return; }
    const available = Number(stats.bavail) * Number(stats.bsize);
    if (Number.isFinite(available) && available - this.reserveFreeBytes < requiredBytes) {
      throw fault(507, 'Insufficient resumable upload staging space');
    }
  }

  async sealManifest(session) {
    if (session.manifestComplete) return this.store.sealManifest(session);
    const operation = this.capacityQueue.then(async () => {
      const manifestBytes = await this.store.manifestSize(session.sessionId);
      const otherReservedBytes = await this.store.outstandingBytes(session.sessionId, this.now());
      await this._assertFreeSpace(manifestBytes + otherReservedBytes);
      return this.store.sealManifest(session);
    });
    this.capacityQueue = operation.catch(() => {});
    return operation;
  }

  async _recoverSession(session) {
    if (!session.manifestComplete || ['completed', 'cancelled', 'failed', 'expired'].includes(session.status)) return;
    const { filesDirectory } = await this._ensureSessionDirectory(session.sessionId);
    for (const entry of await this.fs.promises.readdir(filesDirectory, { withFileTypes: true })) {
      if (entry.isFile() && /^\.incoming-[0-9a-f-]{36}$/i.test(entry.name)) {
        await this.fs.promises.unlink(path.join(filesDirectory, entry.name));
      }
    }
    for (const file of await this.store.getFiles(session.sessionId)) {
      if (file.status === 'completed') continue;
      const target = this._filePath(session.sessionId, file.fileId);
      let stats;
      try { stats = await this.fs.promises.lstat(target); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stats?.isSymbolicLink() || (stats && !stats.isFile())) {
        await this.fs.promises.unlink(target);
        await this.store.resetFileOffset(session.sessionId, file.fileId);
        continue;
      }
      if (!stats && file.uploadedOffset > 0) {
        await this.store.resetFileOffset(session.sessionId, file.fileId);
        continue;
      }
      if (stats && stats.size > file.uploadedOffset) {
        const handle = await this.fs.promises.open(target, 'r+');
        try { await handle.truncate(file.uploadedOffset); await handle.sync(); }
        finally { await handle.close(); }
      } else if (stats && stats.size < file.uploadedOffset) {
        const handle = await this.fs.promises.open(target, 'r+');
        try { await handle.truncate(0); await handle.sync(); }
        finally { await handle.close(); }
        await this.store.resetFileOffset(session.sessionId, file.fileId);
      }
    }
  }

  async receiveChunk({ req, session, file, start, end, total, chunkHash }) {
    return this.withSessionOperation(session.sessionId, signal => this._withFileLock(session.sessionId, file.fileId, async () => {
      file = await this.store.getFile(session.sessionId, file.fileId);
      if (!file) { req.resume(); throw fault(404, 'Upload file not found'); }
      await this._assertSessionActive(session);
      if (file.status === 'completed') throw fault(409, 'Upload file is already complete', { expectedOffset: file.size });
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || total !== file.size ||
          start < 0 || end < start || end >= total || !HASH_PATTERN.test(chunkHash || '')) {
        req.resume();
        throw fault(400, 'Invalid upload chunk range or checksum');
      }
      const expectedLength = end - start + 1;
      const expectedIndex = Math.floor(start / file.chunkSize);
      const expectedChunkStart = expectedIndex * file.chunkSize;
      const expectedChunkLength = Math.min(file.chunkSize, file.size - expectedChunkStart);
      const hashes = file.chunkHashes;
      if (start !== expectedChunkStart || expectedLength !== expectedChunkLength || hashes[expectedIndex] !== chunkHash.toLowerCase()) {
        req.resume();
        throw fault(400, 'Upload chunk does not match the manifest');
      }
      if (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) !== expectedLength) {
        req.resume();
        throw fault(400, 'Upload chunk length does not match its range');
      }
      if (start !== file.uploadedOffset) {
        req.resume();
        throw fault(409, 'Upload offset mismatch', { expectedOffset: file.uploadedOffset });
      }
      await this._assertFreeSpace(expectedLength);
      const partPath = await this.ensureFilePath(session.sessionId, file.fileId);
      const partDirectory = path.dirname(partPath);
      let partStats;
      try { partStats = await this.fs.promises.stat(partPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (partStats && partStats.size > start) {
        const handle = await this.fs.promises.open(partPath, 'r+');
        try { await handle.truncate(start); await handle.sync(); }
        finally { await handle.close(); }
      } else if (partStats && partStats.size < start) {
        const handle = await this.fs.promises.open(partPath, 'r+');
        try { await handle.truncate(0); await handle.sync(); }
        finally { await handle.close(); }
        await this.store.resetFileOffset(session.sessionId, file.fileId);
        req.resume();
        throw fault(409, 'Staged upload data was incomplete; restart this file', { expectedOffset: 0 });
      }

      const incomingPath = path.join(partDirectory, `.incoming-${randomUUID()}`);
      const digest = createHash('sha256');
      let received = 0;
      const measure = new Transform({ transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > expectedLength) return callback(fault(413, 'Upload chunk is too large'));
        digest.update(chunk);
        callback(null, chunk);
      } });
      try {
        await pipeline(req, measure, this.fs.createWriteStream(incomingPath, { flags: 'wx', mode: 0o600 }), { signal });
        await this._assertSessionActive(session);
        if (received !== expectedLength || digest.digest('hex') !== chunkHash.toLowerCase()) {
          throw fault(400, 'Upload chunk checksum or length is invalid');
        }
        const incoming = await this.fs.promises.open(incomingPath, 'r+');
        try { await incoming.sync(); }
        finally { await incoming.close(); }
        let part;
        try { part = await this.fs.promises.open(partPath, 'r+'); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          part = await this.fs.promises.open(partPath, 'w+', 0o600);
        }
        try {
          const bytes = await this.fs.promises.readFile(incomingPath);
          let written = 0;
          while (written < bytes.length) {
            const result = await part.write(bytes, written, bytes.length - written, start + written);
            if (!result.bytesWritten) throw fault(507, 'Unable to persist upload chunk');
            written += result.bytesWritten;
          }
          await part.sync();
        } finally { await part.close(); }
        const advanced = await this.store.advanceOffset(session.sessionId, file, start, end + 1);
        if (!advanced) {
          const latest = await this.store.getFile(session.sessionId, file.fileId);
          if (latest?.uploadedOffset === end + 1) {
            return { fileId: file.fileId, uploadedOffset: end + 1, size: file.size, status: 'uploading' };
          }
          throw fault(409, 'Upload offset changed', { expectedOffset: latest?.uploadedOffset ?? start });
        }
        return { fileId: file.fileId, uploadedOffset: end + 1, size: file.size, status: 'uploading' };
      } finally {
        await this.fs.promises.unlink(incomingPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }));
  }

  async verifyFile(sessionId, file) {
    const filePath = await this.ensureFilePath(sessionId, file.fileId);
    if (file.uploadedOffset !== file.size) throw fault(409, 'Upload file is incomplete', { expectedOffset: file.uploadedOffset });
    let stats;
    try { stats = await this.fs.promises.lstat(filePath); }
    catch (error) {
      if (error.code !== 'ENOENT' || file.size !== 0) throw fault(409, 'Staged upload file is missing', { expectedOffset: 0 });
      const handle = await this.fs.promises.open(filePath, 'wx', 0o600);
      await handle.close();
      stats = await this.fs.promises.stat(filePath);
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== file.size) throw fault(409, 'Staged upload file size is invalid', { expectedOffset: 0 });
    const handle = await this.fs.promises.open(filePath, 'r');
    try {
      for (let index = 0; index < file.chunkHashes.length; index++) {
        const length = Math.min(file.chunkSize, file.size - index * file.chunkSize);
        const buffer = Buffer.allocUnsafe(length);
        let read = 0;
        while (read < length) {
          const result = await handle.read(buffer, read, length - read, index * file.chunkSize + read);
          if (!result.bytesRead) throw fault(409, 'Staged upload file is truncated');
          read += result.bytesRead;
        }
        const digest = createHash('sha256').update(buffer).digest('hex');
        if (digest !== file.chunkHashes[index]) throw fault(409, 'Staged upload chunk failed integrity verification');
      }
    } finally { await handle.close(); }
    return filePath;
  }

  async removeFileStaging(sessionId, fileId) {
    const target = this._filePath(sessionId, fileId);
    for (const directory of [this._sessionRoot(sessionId), path.dirname(target)]) {
      try {
        const stats = await this.fs.promises.lstat(directory);
        if (!stats.isDirectory() || stats.isSymbolicLink()) throw fault(500, 'Unsafe resumable upload staging directory');
      } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    }
    await this.fs.promises.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }

  async pruneCompletedStaging(sessionId) {
    for (const file of await this.store.getFilesInternal(sessionId)) {
      if (file.status === 'completed') {
        await this._cleanupFileTargetTemp(sessionId, file);
        await this.removeFileStaging(sessionId, file.fileId);
      }
    }
  }

  async cleanupFilePublicationTemp(sessionId, fileId) {
    const file = await this.store.getFile(sessionId, fileId);
    if (!file?.publishTempPath) return;
    await this._cleanupFileTargetTemp(sessionId, file);
    await this.store.updateFile(sessionId, fileId, { publishTempPath: null });
  }

  async cleanupExpired() {
    const expired = await this.store.expired(this.now());
    let removed = 0;
    for (const session of expired) {
      await this.store.updateSession(session.sessionId, 'expired');
      const active = [...(this.activeOperations.get(session.sessionId) || [])];
      active.forEach(operation => operation.controller.abort());
      await Promise.allSettled(active.map(operation => operation.settled));
      await this._cleanupTargetTemps(session.sessionId);
      const directory = this._sessionRoot(session.sessionId);
      await this.fs.promises.rm(directory, { recursive: true, force: true });
      await this.store.remove(session.sessionId);
      removed++;
    }
    return { removed };
  }

  async cancel(session) {
    const transition = await this.store.transitionSession(session.sessionId, 'cancelling', ['manifest', 'uploading']);
    const latest = await this.store.get(session.sessionId);
    if (transition.changes !== 1 && latest?.status === 'completed') return this.store.serialize(latest);
    const active = [...(this.activeOperations.get(session.sessionId) || [])];
    active.forEach(operation => operation.controller.abort());
    await Promise.allSettled(active.map(operation => operation.settled));
    const current = await this.store.get(session.sessionId);
    if (current?.status === 'completed') return this.store.serialize(current);
    if (current?.status === 'cancelled') return this.store.serialize(current);
    if (current?.manifestComplete) {
      const files = await this.store.getFiles(session.sessionId);
      if (files.length === current.expectedFileCount && files.every(file => file.status === 'completed')) {
        await this.store.transitionSession(session.sessionId, 'completed', ['cancelling']);
        return this.store.serialize(await this.store.get(session.sessionId));
      }
    }
    await this._cleanupTargetTemps(session.sessionId);
    await this.store.updateSession(session.sessionId, 'cancelled');
    await this.fs.promises.rm(this._sessionRoot(session.sessionId), { recursive: true, force: true });
    return this.store.serialize(await this.store.get(session.sessionId));
  }

  async _cleanupTargetTemps(sessionId) {
    for (const file of await this.store.getFilesInternal(sessionId)) {
      await this._cleanupFileTargetTemp(sessionId, file);
    }
  }

  async _cleanupFileTargetTemp(sessionId, file) {
    const prefix = `.nfterm-upload-${sessionId}-${file.fileId}`;
    const name = file.publishTempPath ? path.basename(file.publishTempPath) : '';
    if (file.publishTempPath && (name === `${prefix}.tmp` || new RegExp(`^${prefix}-\\d+\\.tmp$`).test(name))) {
      await this.fs.promises.unlink(file.publishTempPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

module.exports = { ResumableUploadManager, RESUMABLE_SESSION_TTL_MS: SESSION_TTL_MS };
