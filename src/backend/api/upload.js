const express = require('express');
const Busboy = require('busboy');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { randomUUID } = require('crypto');
const { setMaxListeners } = require('events');
const { createHash } = require('node:crypto');
const { transferManager } = require('../transfer');
const { dedupeFilename } = require('../utils/dedupe-filename');
const { RESUMABLE_SESSION_TTL_MS } = require('../transfer/resumable-upload');

const activeStages = new Set();
// Match middleware/security.js's extension policy, without its obsolete 100 MiB cap.
const dangerousExtensions = new Set([
  '.exe', '.bat', '.cmd', '.com', '.pif', '.scr', '.vbs', '.js', '.jar',
  '.php', '.asp', '.aspx', '.jsp', '.sh', '.ps1', '.py', '.rb'
]);
const terminal = new Set(['completed', 'failed', 'cancelled', 'partial_fail', 'expired']);
const fault = (statusCode, message, details = {}) => Object.assign(new Error(message), { statusCode, ...details });
const relativePath = (value, allowEmpty = false) => {
  if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x1f]/.test(value)) throw fault(400, 'Invalid relative path');
  const portable = value.replace(/\\/g, '/');
  if ((!portable && !allowEmpty) || portable.startsWith('/') || /^[a-z]:/i.test(portable) || portable.split('/').includes('..')) {
    throw fault(400, 'Invalid relative path');
  }
  const normalized = path.posix.normalize(portable);
  if (normalized === '.' && !allowEmpty) throw fault(400, 'Invalid relative path');
  return normalized === '.' ? '' : normalized;
};
const compareNormalizedPaths = (left, right) => {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

class UploadAPI {
  #workers = new Set();

  constructor(options = {}) {
    this.router = express.Router();
    this.transfers = options.transferManager || transferManager;
    this.authenticate = options.authenticate || ((...args) => require('../middleware/auth').authenticate(...args));
    this.getConfig = options.getConfig || (key => require('../config').get(key));
    this.fs = options.fs || fs;
    this.tempDir = path.resolve(options.tempDir || './temp/uploads');
    this.withOperationLocks = options.withOperationLocks || ((...args) => require('../file-system/operation-locks').withOperationLocks(...args));
    this.assertSafePath = options.assertSafePath || ((...args) => require('../file-system/path-safety').assertSafePath(...args));
    this.assertSafeTree = options.assertSafeTree || ((...args) => require('../file-system/path-safety').assertSafeTree(...args));
    this.logger = options.logger || { logSystem: (...args) => require('../utils/logger').systemLogger.logSystem(...args) };
    this.cache = null;
    this.locationManager = null;
    this.locationPermissionManager = null;
    this.cacheResolver = null;
    this.resumableUploads = options.resumableUploads || null;
    this._setupRoutes();
  }

  setCache(cache) { this.cache = cache; }
  setLocationManager(locationManager, cacheResolver = null, locationPermissionManager = null) {
    this.locationManager = locationManager;
    this.cacheResolver = cacheResolver;
    this.locationPermissionManager = locationPermissionManager;
  }
  setResumableUploads(manager) { this.resumableUploads = manager; }

  async waitForIdle() {
    // The parent must stop new admission first and must not hold locks needed by workers.
    while (this.#workers.size) await Promise.all([...this.#workers]);
  }

  _owner(req) {
    const id = req.user?.id;
    const validId = (typeof id === 'string' && id.length > 0) || (Number.isSafeInteger(id) && id >= 0);
    if (!validId || typeof req.user.username !== 'string' || !req.user.username) {
      throw fault(401, 'Authentication required');
    }
    return { id: req.user.id, username: req.user.username };
  }

  async _resolveLocation(req, rel = '', explicitId) {
    const mgr = this.locationManager;
    const permissions = this.locationPermissionManager;
    const cacheResolver = this.cacheResolver;
    const cache = this.cache;
    if (!mgr || !permissions) throw fault(503, 'Location service is not ready');
    const locationId = explicitId || req.headers['x-location-id'] || req.body?.locationId || req.query?.locationId ||
      (mgr.getLocation('default') ? 'default' : null);
    const location = typeof locationId === 'string' && mgr.getLocation(locationId);
    if (!location || !location.enabled) throw fault(403, 'Location is unavailable');
    for (const capability of ['upload', 'write']) await permissions.assertCurrent(req.user, locationId, capability);
    const revision = mgr.getRevision(locationId);
    if (req.headers['x-location-revision'] !== undefined && req.headers['x-location-revision'] !== revision) throw fault(409, 'Location changed');
    const rootPath = await mgr.resolveCheckedPath(locationId, '', { allowMissing: false });
    const targetPath = await mgr.resolveCheckedPath(locationId, relativePath(rel, true), { allowMissing: true });
    if (mgr !== this.locationManager || permissions !== this.locationPermissionManager || revision !== mgr.getRevision(locationId)) throw fault(409, 'Location changed');
    return { locationId, locationRevision: revision, rootPath, targetPath, path: relativePath(rel, true), owner: this._owner(req),
      manager: mgr, cacheResolver, cache };
  }

  async _authorizeRecord(req, record) {
    const owner = this._owner(req);
    if (!record || record.owner?.id !== owner.id || record.owner?.username !== owner.username) throw fault(404, 'Upload not found');
    if (req.headers['x-location-id'] && req.headers['x-location-id'] !== record.locationId) throw fault(403, 'Location does not match upload');
    const context = await this._resolveLocation(req, record.path || '', record.locationId);
    if (context.locationRevision !== record.locationRevision) throw fault(409, 'Location changed');
    return context;
  }

  async _recheck(user, context) {
    const current = await this._resolveLocation({ user, headers: {} }, context.path, context.locationId);
    if (current.locationRevision !== context.locationRevision || current.targetPath !== context.targetPath || current.rootPath !== context.rootPath) {
      throw fault(409, 'Location changed');
    }
  }

  _respondError(res, error) {
    if (res.headersSent || res.destroyed) return;
    const status = error.statusCode || ({ ENOSPC: 507, EACCES: 403, EPERM: 403, ENOENT: 404, ABORT_ERR: 409 }[error.code]) || 500;
    res.status(status).json({ success: false,
      ...(Number.isSafeInteger(error.expectedOffset) && error.expectedOffset >= 0 ? { expectedOffset: error.expectedOffset } : {}),
      ...(Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs > 0 ? { retryAfterMs: error.retryAfterMs } : {}),
      error: { code: status, message: status < 500 ?
      ({ 400: 'Invalid upload request', 401: 'Authentication required', 403: 'Upload access denied', 404: 'Upload not found',
        409: 'Upload state or Location changed', 413: 'Upload limit exceeded', 429: 'Upload admission capacity reached' }[status] || 'Upload rejected') : 'Upload could not be completed' } });
  }

  _setupRoutes() {
    const auth = (req, res, next) => Promise.resolve(this.authenticate(req, res, next)).catch(error => this._respondError(res, error));
    const route = fn => (req, res) => Promise.resolve().then(() => {
      if (Object.keys(req.query || {}).some(key => /token|password|authorization/i.test(key))) {
        throw fault(400, 'Body/query credentials are not supported');
      }
      return fn(req, res);
    }).catch(error => this._respondError(res, error));
    this.router.post('/upload/batches', auth, express.json({ limit: '20kb' }), route(async (req, res) => {
      const body = req.body;
      if (!body || Array.isArray(body) || Object.keys(body).some(key => !['path', 'clientAttemptId'].includes(key)) ||
          typeof body.path !== 'string' || (body.clientAttemptId !== undefined &&
            (typeof body.clientAttemptId !== 'string' || !body.clientAttemptId || body.clientAttemptId.length > 128))) throw fault(400, 'Invalid reservation');
      const context = await this._resolveLocation(req, body.path);
      const batchId = this.transfers.reserveBatch({ ...context, clientAttemptId: body.clientAttemptId });
      const batch = this.transfers.getBatch(batchId);
      res.status(201).json({ batchId, status: 'reserved', locationId: batch.locationId, expiresAt: batch.expiresAt });
    }));
    this.router.get('/upload/sessions/config', auth, route(async (req, res) => {
      if (this.getConfig('transfer.enableResume') !== true) throw fault(404, 'Resumable uploads are disabled');
      const chunkSize = this.getConfig('transfer.chunkSize');
      if (!Number.isSafeInteger(chunkSize) || chunkSize < 1024 * 1024 || chunkSize > 64 * 1024 * 1024) {
        throw fault(503, 'Invalid upload chunk size');
      }
      res.set('Cache-Control', 'no-store').json({ chunkSize });
    }));
    this.router.post('/upload/sessions', auth, express.json({ limit: '20kb' }), route(async (req, res) => {
      if (this.getConfig('transfer.enableResume') !== true) throw fault(404, 'Resumable uploads are disabled');
      const body = req.body;
      if (!body || Array.isArray(body) || Object.keys(body).some(key => ![
        'path', 'clientAttemptId', 'fileCount', 'directoryCount', 'chunkSize'
      ].includes(key)) || typeof body.path !== 'string' ||
          typeof body.clientAttemptId !== 'string' || !body.clientAttemptId || body.clientAttemptId.length > 128 ||
          !Number.isSafeInteger(body.fileCount) || body.fileCount < 0 ||
          !Number.isSafeInteger(body.directoryCount) || body.directoryCount < 0 ||
          body.fileCount + body.directoryCount < 1 || body.fileCount + body.directoryCount > 100000 ||
          (body.chunkSize !== undefined && (!Number.isSafeInteger(body.chunkSize) || body.chunkSize < 1024 * 1024 || body.chunkSize > 64 * 1024 * 1024))) {
        throw fault(400, 'Invalid resumable upload session');
      }
      const manager = this._requireResumableUploads();
      const context = await this._resolveLocation(req, body.path);
      const chunkSize = this.getConfig('transfer.chunkSize');
      if (!Number.isSafeInteger(chunkSize) || chunkSize < 1024 * 1024 || chunkSize > 64 * 1024 * 1024) {
        throw fault(503, 'Invalid upload chunk size');
      }
      if (body.chunkSize !== undefined && body.chunkSize !== chunkSize) {
        throw fault(409, 'Upload chunk size changed; refresh upload options and rebuild the manifest');
      }
      const session = await manager.store.create(context, {
        clientAttemptId: body.clientAttemptId,
        expectedFileCount: body.fileCount,
        expectedDirectoryCount: body.directoryCount,
        chunkSize
      });
      const { created, ...publicSession } = session;
      res.status(created ? 201 : 200).json({ ...publicSession, expiresInMs: RESUMABLE_SESSION_TTL_MS });
    }));
    this.router.get('/upload/sessions', auth, route(async (req, res) => {
      const manager = this._requireResumableUploads();
      const owner = this._owner(req);
      const sessions = await manager.store.list(owner);
      const accessible = [];
      for (const session of sessions) {
        if (session.expiresAt <= manager.now() || session.status === 'expired') continue;
        try {
          const context = await this._resolveLocation(req, session.path, session.locationId);
          if (context.locationRevision === session.locationRevision) accessible.push(session);
        } catch { /* Hide sessions whose Location permission or revision is no longer valid. */ }
      }
      res.set('Cache-Control', 'no-store').json({ sessions: accessible });
    }));
    this.router.post('/upload/sessions/:sessionId/manifest/pages/:pageIndex', auth, express.json({ limit: '5mb' }), route(async (req, res) => {
      const manager = this._requireResumableUploads();
      const { session, context } = await this._authorizedUploadSession(req, req.params.sessionId);
      if (session.manifestComplete || session.status !== 'manifest') throw fault(409, 'Upload manifest is already sealed');
      const pageIndex = Number(req.params.pageIndex);
      const body = req.body;
      if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || !body || Array.isArray(body) ||
          Object.keys(body).some(key => !['fileOffset', 'directoryOffset', 'files', 'directories'].includes(key)) ||
          !Number.isSafeInteger(body.fileOffset) || body.fileOffset < 0 ||
          !Number.isSafeInteger(body.directoryOffset) || body.directoryOffset < 0 ||
          !Array.isArray(body.files) || body.files.length > 50 || !Array.isArray(body.directories) || body.directories.length > 50) {
        throw fault(400, 'Invalid upload manifest page');
      }
      const maxFileSize = this.getConfig('fileSystem.maxFileSize');
      const files = body.files.map(entry => {
        if (!entry || Array.isArray(entry) || Object.keys(entry).some(key => ![
          'fileId', 'path', 'name', 'size', 'chunkHashes'
        ].includes(key)) || typeof entry.fileId !== 'string' || !/^[0-9a-f-]{36}$/i.test(entry.fileId) ||
            typeof entry.path !== 'string' || typeof entry.name !== 'string' ||
            !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > maxFileSize ||
            !Array.isArray(entry.chunkHashes)) throw fault(400, 'Invalid upload manifest file');
        const filePath = relativePath(entry.path);
        const name = this._sanitizeFilename(entry.name);
        if (path.posix.basename(filePath) !== name || Buffer.byteLength(name) > 16384) throw fault(400, 'Invalid upload manifest filename');
        if (this.getConfig('security.enableFileUploadSecurity') === true &&
            [filePath, name].some(value => dangerousExtensions.has(path.extname(value).toLowerCase()))) {
          throw fault(400, 'File type is not allowed');
        }
        const chunks = Math.ceil(entry.size / session.chunkSize);
        if (entry.chunkHashes.length !== chunks || entry.chunkHashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash))) {
          throw fault(400, 'Invalid upload chunk checksum manifest');
        }
        return { fileId: entry.fileId, relativePath: filePath, fileName: name, size: entry.size,
          chunkHashes: entry.chunkHashes.map(hash => hash.toLowerCase()) };
      });
      const directories = body.directories.map(value => relativePath(value));
      if (body.fileOffset + files.length > session.expectedFileCount ||
          body.directoryOffset + directories.length > session.expectedDirectoryCount) throw fault(400, 'Manifest page exceeds declared inventory');
      const result = await manager.store.addManifestPage(session, {
        pageIndex, fileOffset: body.fileOffset, directoryOffset: body.directoryOffset,
        files, directories: { paths: directories }
      });
      await this._recheck(req.user, context);
      res.status(201).json({ success: true, ...result });
    }));
    this.router.post('/upload/sessions/:sessionId/manifest/complete', auth, route(async (req, res) => {
      const manager = this._requireResumableUploads();
      const { session, context } = await this._authorizedUploadSession(req, req.params.sessionId);
      const sealed = await manager.sealManifest(session);
      await this._ensureZeroByteStaging(sealed.sessionId);
      await this._ensureResumableDirectories(sealed, context, req.user);
      res.set('Cache-Control', 'no-store').json(manager.store.serialize(sealed));
    }));
    this.router.get('/upload/sessions/:sessionId', auth, route(async (req, res) => {
      const manager = this._requireResumableUploads();
      const { session } = await this._authorizedUploadSession(req, req.params.sessionId);
      const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
      const directoryOffset = Math.max(0, Number.parseInt(req.query.directoryOffset, 10) || 0);
      const requestedLimit = Number.parseInt(req.query.limit, 10);
      const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 100;
      const allFiles = await manager.store.getFiles(session.sessionId, offset, limit);
      const directories = await manager.store.getDirectories(session.sessionId, directoryOffset, limit);
      res.set('Cache-Control', 'no-store').json({
        session: manager.store.serialize(session),
        files: allFiles,
        nextOffset: offset + allFiles.length < session.expectedFileCount ? offset + allFiles.length : null,
        directories,
        nextDirectoryOffset: directoryOffset + directories.length < session.expectedDirectoryCount
          ? directoryOffset + directories.length : null
      });
    }));
    this.router.put('/upload/sessions/:sessionId/files/:fileId/chunks', auth, route(async (req, res) => {
      const manager = this._requireResumableUploads();
      const { session } = await this._authorizedUploadSession(req, req.params.sessionId);
      const file = await manager.store.getFile(session.sessionId, req.params.fileId);
      if (!file) throw fault(404, 'Upload file not found');
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers['content-range'] || '');
      if (!range) { req.resume(); throw fault(400, 'Content-Range is required'); }
      const result = await manager.receiveChunk({ req, session, file,
        start: Number(range[1]), end: Number(range[2]), total: Number(range[3]),
        chunkHash: req.headers['x-chunk-sha256'] });
      res.set('Cache-Control', 'no-store').json(result);
    }));
    this.router.post('/upload/sessions/:sessionId/files/:fileId/complete', auth, route(async (req, res) => {
      const { session, context } = await this._authorizedUploadSession(req, req.params.sessionId);
      const file = await this.resumableUploads.store.getFile(session.sessionId, req.params.fileId);
      if (!file) throw fault(404, 'Upload file not found');
      const result = file.status === 'completed'
        ? await this._finalizeResumableFile(session, file, context, req.user)
        : await this.resumableUploads.withSessionOperation(session.sessionId, signal =>
          this._finalizeResumableFile(session, file, context, req.user, signal));
      res.set('Cache-Control', 'no-store').json(result);
    }));
    this.router.post('/upload/sessions/:sessionId/complete', auth, route(async (req, res) => {
      const manager = this._requireResumableUploads();
      const { session, context } = await this._authorizedUploadSession(req, req.params.sessionId);
      if (session.status === 'completed') return res.set('Cache-Control', 'no-store').json({ success: true, sessionId: session.sessionId, status: 'completed' });
      const result = await manager.withSessionOperation(session.sessionId, async signal => {
      const files = await manager.store.getFiles(session.sessionId);
      if (files.some(file => file.status !== 'completed')) throw fault(409, 'Upload session still has unfinished files');
      signal.throwIfAborted();
      const settled = await manager.store.transitionSession(session.sessionId, 'completed', ['uploading']);
      if (settled.changes !== 1) {
        const latest = await manager.store.get(session.sessionId);
        if (latest?.status !== 'completed') throw fault(409, 'Upload session was cancelled before finalization');
      }
      return { success: true, sessionId: session.sessionId, status: 'completed' };
      });
      res.set('Cache-Control', 'no-store').json(result);
    }));
    this.router.post('/upload/sessions/:sessionId/cancel', auth, route(async (req, res) => {
      const { session } = await this._authorizedUploadSession(req, req.params.sessionId);
      if (['completed', 'cancelled', 'failed', 'expired'].includes(session.status)) {
        if (session.status === 'cancelled') return res.set('Cache-Control', 'no-store').json(this.resumableUploads.store.serialize(session));
        throw fault(409, 'Upload session is already settled');
      }
      const result = await this.resumableUploads.cancel(session);
      res.set('Cache-Control', 'no-store').json(result);
    }));
    for (const [endpoint, single, asynchronous] of [
      ['/upload', false, true], ['/upload/multiple', false, true], ['/upload/single', true, false],
      ['/upload/progress', true, false], ['/upload/single-progress', true, true]
    ]) this.router.post(endpoint, auth, route((req, res) => this._handleUpload(req, res, { single, asynchronous })));

    // Batch paths must precede the single-transfer parameter route.
    for (const isBatch of [true, false]) {
      const endpoint = isBatch ? '/progress/batch/:batchId' : '/progress/:transferId';
      const progress = cancel => route(async (req, res) => {
        const id = isBatch ? req.params.batchId : req.params.transferId;
        const record = isBatch ? this.transfers.getBatch(id) : this.transfers.getTransfer(id);
        await this._authorizeRecord(req, record);
        if (cancel) await (isBatch ? this.transfers.cancelBatch(id) : this.transfers.cancelTransfer(id));
        const result = isBatch ? this.transfers.serializeBatch(id) : this.transfers.serializeTransfer(id);
        res.set('Cache-Control', 'no-store').status(result.status === 'cancelling' ? 202 : 200).json(result);
      });
      this.router.get(endpoint, auth, progress(false));
      this.router.post(`${endpoint}/cancel`, auth, progress(true));
    }
  }

  _requireResumableUploads() {
    if (!this.resumableUploads) throw fault(503, 'Resumable upload service is not ready');
    return this.resumableUploads;
  }

  async _authorizedUploadSession(req, sessionId) {
    const manager = this._requireResumableUploads();
    const owner = this._owner(req);
    const session = await manager.store.getOwned(sessionId, owner);
    if (!session) throw fault(404, 'Upload session not found');
    if (req.headers['x-location-id'] && req.headers['x-location-id'] !== session.locationId) {
      throw fault(403, 'Location does not match upload session');
    }
    if (session.expiresAt <= manager.now()) throw fault(410, 'Upload session has expired');
    const context = await this._resolveLocation(req, session.destinationPath, session.locationId);
    if (context.locationRevision !== session.locationRevision || context.path !== session.destinationPath) {
      throw fault(409, 'Upload Location changed');
    }
    return { session, context };
  }

  async _ensureZeroByteStaging(sessionId) {
    const files = await this.resumableUploads.store.getFiles(sessionId);
    for (const file of files) {
      if (file.size !== 0 || file.status === 'completed') continue;
      const filePath = await this.resumableUploads.ensureFilePath(sessionId, file.fileId);
      await this.fs.promises.open(filePath, 'a', 0o600).then(handle => handle.close());
    }
  }

  async _ensureResumableDirectories(session, context, user) {
    const directories = (await this.resumableUploads.store.getDirectories(session.sessionId)).sort(compareNormalizedPaths);
    for (const directory of directories) {
      const target = await context.manager.resolveCheckedPath(context.locationId,
        path.posix.join(session.destinationPath, directory), { allowMissing: true });
      await this.withOperationLocks([context.targetPath, target], async () => {
        await this._recheck(user, context);
        await this.assertSafePath(context.rootPath, target, { allowMissing: true });
        await this.fs.promises.mkdir(target, { recursive: true });
      });
    }
    if (directories.length) {
      try { await this._refreshCacheDirectory(context.targetPath, context); }
      catch { this._warn('Committed resumable upload directory cache refresh failed'); }
    }
  }

  async _finalizeResumableFile(session, file, context, user, signal = null) {
    const manager = this._requireResumableUploads();
    if (file.status === 'completed') {
      await manager.cleanupFilePublicationTemp(session.sessionId, file.fileId);
      await manager.removeFileStaging(session.sessionId, file.fileId);
      return {
        fileId: file.fileId, status: 'completed',
        path: path.relative(context.rootPath, file.publishPath).split(path.sep).join('/'),
        size: file.size, uploadedOffset: file.size
      };
    }
    if (await manager.store.hasEarlierCollision(session.sessionId, file)) {
      throw fault(409, 'A preceding file with the same destination path must finish first', { retryAfterMs: 200 });
    }
    const stagedPath = await manager.verifyFile(session.sessionId, file);
    const destination = await context.manager.resolveCheckedPath(context.locationId,
      path.posix.join(session.destinationPath, file.relativePath), { allowMissing: true });
    const folder = path.dirname(destination);
    const tempPrefix = `.nfterm-upload-${session.sessionId}-${file.fileId}`;
    let tempPath = file.publishTempPath || path.join(folder, `${tempPrefix}.tmp`);
    let ownedTempPath = file.publishTempPath || null;
    const expectedChunkHashes = file.chunkHashes;
    let finalPath;
    await this.withOperationLocks([context.targetPath, folder, tempPath], async () => {
      signal?.throwIfAborted();
      await this._recheck(user, context);
      await this.assertSafePath(context.rootPath, folder, { allowMissing: true });
      await this.fs.promises.mkdir(folder, { recursive: true });
      const verifyAt = async candidate => {
        try {
          const stats = await this.fs.promises.lstat(candidate);
          if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== file.size) return false;
          const handle = await this.fs.promises.open(candidate, 'r');
          try {
            for (let index = 0; index < expectedChunkHashes.length; index++) {
              const length = Math.min(file.chunkSize, file.size - index * file.chunkSize);
              const buffer = Buffer.allocUnsafe(length);
              let read = 0;
              while (read < length) {
                const result = await handle.read(buffer, read, length - read, index * file.chunkSize + read);
                if (!result.bytesRead) return false;
                read += result.bytesRead;
              }
              if (createHash('sha256').update(buffer).digest('hex') !== expectedChunkHashes[index]) return false;
            }
            return true;
          } finally { await handle.close(); }
        } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      };
      const isOwnedLink = async (candidate, temporary) => {
        if (!(await verifyAt(candidate))) return false;
        try {
          const [outputStats, temporaryStats] = await Promise.all([
            this.fs.promises.lstat(candidate), this.fs.promises.lstat(temporary)
          ]);
          return outputStats.dev === temporaryStats.dev && outputStats.ino === temporaryStats.ino;
        } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      };

      if (file.publishPath) {
        await this.assertSafePath(context.rootPath, file.publishPath, { allowMissing: true });
        if (ownedTempPath && await isOwnedLink(file.publishPath, ownedTempPath)) {
          finalPath = file.publishPath;
          await manager.store.updateFile(session.sessionId, file.fileId, {
            status: 'completed', publishPath: finalPath, publishTempPath: ownedTempPath
          });
          return;
        }
      }

      if (!file.publishTempPath) {
        for (let attempt = 0; ; attempt++) {
          tempPath = path.join(folder, attempt ? `${tempPrefix}-${attempt}.tmp` : `${tempPrefix}.tmp`);
          await this.assertSafePath(context.rootPath, tempPath, { allowMissing: true });
          try { await this.fs.promises.lstat(tempPath); }
          catch (error) { if (error.code === 'ENOENT') break; throw error; }
        }
      } else if (path.dirname(file.publishTempPath) !== folder ||
          !(path.basename(file.publishTempPath) === `${tempPrefix}.tmp` || new RegExp(`^${tempPrefix}-\\d+\\.tmp$`).test(path.basename(file.publishTempPath)))) {
        throw fault(500, 'Invalid resumable publication checkpoint');
      }
      await this.assertSafePath(context.rootPath, tempPath, { allowMissing: true });

      let tempExists = await verifyAt(tempPath);
      if (!tempExists) {
        await this._assertDestinationSpace(folder, file.size);
        let present = false;
        try { await this.fs.promises.lstat(tempPath); present = true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (present && file.publishTempPath !== tempPath) throw fault(409, 'Resumable publication staging name is already occupied');
        if (present) await this.fs.promises.unlink(tempPath);
        await manager.store.updateFile(session.sessionId, file.fileId, { status: 'publishing', publishTempPath: tempPath });
        ownedTempPath = tempPath;
        await pipeline(this.fs.createReadStream(stagedPath), this.fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }),
          ...(signal ? [{ signal }] : []));
        const handle = await this.fs.promises.open(tempPath, 'r+');
        try { await handle.sync(); }
        finally { await handle.close(); }
        tempExists = await verifyAt(tempPath);
        if (!tempExists) throw fault(500, 'Staged upload failed publication verification');
      }

      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        const candidate = attempt ? path.join(folder, dedupeFilename(path.basename(destination), attempt)) : destination;
        await this.assertSafePath(context.rootPath, candidate, { allowMissing: true });
        await manager.store.updateFile(session.sessionId, file.fileId, {
          status: 'publishing', publishPath: candidate, publishTempPath: tempPath
        });
        try {
          signal?.throwIfAborted();
          await this._recheck(user, context);
          await this.fs.promises.link(tempPath, candidate);
          await this._syncDirectory(folder);
          finalPath = candidate;
          await manager.store.updateFile(session.sessionId, file.fileId, {
            status: 'completed', publishPath: finalPath, publishTempPath: tempPath
          });
          break;
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
    }, { signal });

    if (!finalPath) finalPath = file.publishPath;
    let tempRemoved = false;
    try {
      await this.fs.promises.unlink(ownedTempPath || tempPath);
      tempRemoved = true;
    } catch (error) {
      if (error.code === 'ENOENT') tempRemoved = true;
      else this._warn('Resumable upload publication staging cleanup failed');
    }
    if (tempRemoved) await manager.store.updateFile(session.sessionId, file.fileId, {
      status: 'completed', publishPath: finalPath, publishTempPath: null
    });
    await manager.removeFileStaging(session.sessionId, file.fileId);
    try { await this._refreshCacheDirectory(path.dirname(finalPath), context); }
    catch { this._warn('Committed resumable upload cache refresh failed'); }
    return {
      fileId: file.fileId,
      status: 'completed',
      path: path.relative(context.rootPath, finalPath).split(path.sep).join('/'),
      size: file.size,
      uploadedOffset: file.size
    };
  }

  _registerFile(file, batchId, parentController) {
    file.transferId = this.transfers.startTransfer({ batchId, fileName: file.originalname,
      totalSize: file.measured ? file.size : undefined, phase: file.measured ? 'pending' : 'receiving' });
    file.controller = new AbortController();
    file.done = deferred();
    file.abort = () => file.controller.abort();
    parentController.signal.addEventListener('abort', file.abort, { once: true });
    if (parentController.signal.aborted) file.abort();
    this.transfers.registerWorker(file.transferId, file.controller, file.done.promise);
    if (file.measured) this.transfers.updateProgress(file.transferId, file.size, file.size);
    else this.transfers.updateTransferStatus(file.transferId, 'uploading', 'receiving');
    file.cancelQueued = () => {
      if (!file.ready || file.processing || file.cancellation || terminal.has(this.transfers.getTransfer(file.transferId).status)) return;
      file.cancellation = (async () => {
        try {
          await this.fs.promises.unlink(file.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
          this.transfers.settleCancelledTransfer(file.transferId);
        } catch (error) {
          file.cleanupFailed = true;
          this.transfers.failTransfer(file.transferId, error);
        } finally {
          parentController.signal.removeEventListener('abort', file.abort);
          file.done.resolve();
        }
      })();
    };
    file.controller.signal.addEventListener('abort', file.cancelQueued, { once: true });
  }

  async _parse(req, state, single) {
    const maxFileSize = this.getConfig('fileSystem.maxFileSize');
    if (!Number.isSafeInteger(maxFileSize) || maxFileSize <= 0 || maxFileSize >= Number.MAX_SAFE_INTEGER) throw fault(503, 'Invalid upload limit');
    // One extra byte distinguishes an exact-size file from Busboy's inclusive limit event.
    let parser;
    try { parser = Busboy({ headers: req.headers, defParamCharset: 'utf8', limits: {
      fileSize: maxFileSize + 1, files: single ? 1 : 1000, fields: 2010, parts: 3010, fieldSize: 16384, fieldNameSize: 100
    } }); } catch { throw fault(400, 'Invalid multipart content type'); }
    await this.fs.promises.mkdir(this.tempDir, { recursive: true });
    state.stage = await this.fs.promises.mkdtemp(path.join(this.tempDir, 'upload-'));
    activeStages.add(state.stage);
    const writes = [];
    const streams = new Set();
    let firstError;
    let metadataBytes = 0;
    const fail = error => {
      firstError ||= error;
      // Do not destroy Busboy reentrantly from a file/limit callback.
      queueMicrotask(() => {
        req.unpipe(parser);
        for (const stream of streams) stream.destroy(firstError);
        parser.destroy(firstError);
        req.resume();
      });
    };
    const abort = () => fail(fault(409, 'Upload cancelled'));
    const interrupted = () => fail(fault(400, 'Upload interrupted'));
    state.controller.signal.addEventListener('abort', abort, { once: true });
    req.once('aborted', interrupted);
    req.once('error', interrupted);
    const parsed = new Promise((resolve, reject) => {
      parser.once('finish', resolve);
      parser.once('error', error => { firstError ||= fault(400, 'Malformed multipart'); reject(firstError); });
    });
    parser.on('field', (name, value, info) => {
      metadataBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
      if (info.nameTruncated || info.valueTruncated || name.length > 100 || metadataBytes > 32 * 1024 * 1024) return fail(fault(413, 'Metadata limit exceeded'));
      if (!['path', 'locationId', 'fileName', 'filePaths', 'filePaths[]', 'directoryPaths', 'directoryPaths[]'].includes(name)) return fail(fault(400, 'Unexpected multipart field'));
      const key = name.replace(/\[\]$/, '');
      const values = state.fields[key] ||= [];
      values.push(value);
      if (values.length > (['filePaths', 'directoryPaths'].includes(key) ? 1000 : 1)) fail(fault(400, 'Duplicate or excess metadata'));
    });
    parser.on('file', (name, stream, info) => {
      streams.add(stream);
      stream.on('error', () => {});
      if (name !== (single ? 'file' : 'files') || !info.filename || Buffer.byteLength(info.filename) > 16384) {
        stream.resume();
        return fail(fault(400, 'Unexpected file'));
      }
      const file = { path: path.join(state.stage, randomUUID()), originalname: path.basename(info.filename.replace(/\\/g, '/')), size: 0,
        receivedIndex: state.files.length };
      state.files.push(file);
      if (state.batchId) this._registerFile(file, state.batchId, state.controller);
      const signal = file.controller?.signal || state.controller.signal;
      stream.once('limit', () => fail(fault(413, 'File limit exceeded')));
      const measure = new Transform({ transform: (chunk, encoding, callback) => {
        file.size += chunk.length;
        if (file.size > maxFileSize) return callback(fault(413, 'File limit exceeded'));
        if (file.transferId) this.transfers.updateProgress(file.transferId, file.size);
        callback(null, chunk);
      } });
      const write = pipeline(stream, measure, this.fs.createWriteStream(file.path, { flags: 'wx', mode: 0o600 }), { signal })
        .then(() => {
          if (stream.truncated) throw fault(413, 'Truncated file');
          file.measured = true;
          if (file.transferId) this.transfers.updateProgress(file.transferId, file.size, file.size);
        }).catch(error => { fail(error); }).finally(() => streams.delete(stream));
      writes.push(write);
    });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.once(event, () => fail(fault(413, 'Multipart count exceeded')));
    try {
      if (state.controller.signal.aborted) abort();
      else if (req.aborted) interrupted();
      else req.pipe(parser);
      await parsed;
    } catch (error) { firstError ||= error; fail(firstError); }
    finally {
      await Promise.all(writes);
      state.controller.signal.removeEventListener('abort', abort);
      req.removeListener('aborted', interrupted);
      req.removeListener('error', interrupted);
    }
    if (firstError) throw firstError;
  }

  async _cleanupStage(state) {
    if (!state.stage) return;
    const stage = state.stage;
    try {
      await this.fs.promises.rm(stage, { recursive: true, force: true });
      state.stage = null;
    } finally {
      // All streams have settled here. A failed deletion must remain eligible for a later sweep.
      activeStages.delete(stage);
    }
  }

  async _handleUpload(req, res, { single, asynchronous }) {
    this._owner(req);
    const state = { files: [], fields: Object.create(null), controller: new AbortController(), stage: null, batchId: null };
    setMaxListeners(1010, state.controller.signal);
    const done = deferred();
    this.#workers.add(done.promise);
    done.promise.then(() => this.#workers.delete(done.promise));
    let context;
    let admission;
    let handedOff = false;
    const reservedId = req.headers['x-upload-batch-id'];
    const registerBatch = () => this.transfers.registerWorker(state.batchId, state.controller, done.promise, true);
    try {
      if (Object.keys(req.query || {}).some(key => /token|password|authorization/i.test(key))) throw fault(400, 'Body/query credentials are not supported');
      if (reservedId) {
        if (single || typeof reservedId !== 'string') throw fault(400, 'Invalid batch reservation');
        const batch = this.transfers.getBatch(reservedId);
        context = await this._authorizeRecord(req, batch);
        this.transfers.claimBatch(reservedId, context);
        state.batchId = reservedId;
        registerBatch();
      } else if (req.headers['x-location-revision'] !== undefined) {
        admission = await this._resolveLocation(req, '', req.query?.locationId);
      }
      await this._parse(req, state, single);
      const fields = state.fields;
      const rel = relativePath(fields.path?.[0] ?? req.query?.path ?? context?.path ?? '', true);
      const locationId = fields.locationId?.[0] || req.query?.locationId;
      if (context && (rel !== context.path || (locationId && locationId !== context.locationId))) throw fault(409, 'Reservation target mismatch');
      if (req.headers['x-location-id'] && locationId && locationId !== req.headers['x-location-id']) throw fault(400, 'Conflicting Location');
      context ||= await this._resolveLocation(req, rel, locationId);
      if (admission && (context.locationId !== admission.locationId || context.locationRevision !== admission.locationRevision ||
          context.rootPath !== admission.rootPath)) throw fault(409, 'Location changed');
      await this._recheck(req.user, context);
      const filePaths = (fields.filePaths || []).map(value => relativePath(value));
      const directories = (fields.directoryPaths || []).map(value => relativePath(value));
      if ((filePaths.length && filePaths.length !== state.files.length) || (!state.files.length && !directories.length) ||
          (single && (state.files.length !== 1 || filePaths.length || directories.length))) throw fault(400, 'Invalid upload inventory');
      const secureFiles = this.getConfig('security.enableFileUploadSecurity') === true;
      for (let index = 0; index < state.files.length; index++) {
        const file = state.files[index];
        const originalname = file.originalname;
        if (single && (fields.fileName?.[0] || req.query?.fileName)) file.originalname = this._sanitizeFilename(fields.fileName?.[0] || req.query.fileName);
        const name = filePaths[index] || relativePath(file.originalname);
        if (secureFiles && [originalname, file.originalname, name].some(value => dangerousExtensions.has(path.extname(value).toLowerCase()))) {
          throw fault(400, 'File type is not allowed');
        }
        file.destination = await context.manager.resolveCheckedPath(context.locationId, path.posix.join(rel, name), { allowMissing: true });
      }
      state.directories = [];
      for (const directory of directories) {
        const target = await context.manager.resolveCheckedPath(context.locationId, path.posix.join(rel, directory), { allowMissing: true });
        let stat;
        try { stat = await this.fs.promises.lstat(target); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (stat && !stat.isDirectory()) throw fault(400, 'Directory target is not a directory');
        state.directories.push(target);
      }
      state.files.sort((left, right) => compareNormalizedPaths(
        path.relative(context.rootPath, left.destination).split(path.sep).join('/'),
        path.relative(context.rootPath, right.destination).split(path.sep).join('/')
      ) || left.receivedIndex - right.receivedIndex);
      state.directories.sort((left, right) => compareNormalizedPaths(
        path.relative(context.rootPath, left).split(path.sep).join('/'),
        path.relative(context.rootPath, right).split(path.sep).join('/')
      ));
      await this._recheck(req.user, context);
      if (!state.batchId) {
        state.batchId = this.transfers.createBatch(context);
        registerBatch();
        for (const file of state.files) this._registerFile(file, state.batchId, state.controller);
      }
      this.transfers.sealBatch(state.batchId);
      for (const file of state.files) {
        file.ready = true;
        this.transfers.updateTransferStatus(file.transferId, 'pending');
        if (file.controller.signal.aborted) file.cancelQueued();
      }
      const worker = Promise.resolve().then(() => this._processFiles(state, context, req.user)).finally(done.resolve);
      // The worker owns all staged files from this point, including response-write failure.
      handedOff = true;
      if (!state.files.length || !asynchronous) {
        await worker;
        const batch = this.transfers.getBatch(state.batchId);
        if (batch?.status !== 'completed') throw fault(batch?.status === 'cancelled' ? 409 : 500, 'Upload failed');
        if (!state.files.length) return res.json({ success: true, batchId: state.batchId, locationId: context.locationId,
          message: 'Folders uploaded successfully.', folders: directories.length });
        const record = this.transfers.serializeTransfer(state.files[0].transferId);
        return res.json({ success: true, transferId: record.id, message: 'File uploaded successfully', file: record.file });
      }
      worker.catch(() => { this._warn('Upload worker failed'); });
      res.status(202).json({ success: true, ...(single ? { transferId: state.files[0].transferId } : { batchId: state.batchId }),
        message: 'Upload accepted. Poll for progress.' });
    } catch (error) {
      if (!handedOff) {
        let cleanupError;
        try { await this._cleanupStage(state); } catch (failure) { cleanupError = failure; }
        this._settleRemaining(state, cleanupError || error, !!cleanupError);
        if (state.batchId) this.transfers.updateBatchProgress(state.batchId, { settled: true,
          error: cleanupError || (state.controller.signal.aborted ? null : error) });
        done.resolve();
      }
      this._respondError(res, error);
    }
  }

  _settleRemaining(state, error, cleanupFailed = false) {
    for (const file of state.files) {
      if (!file.transferId) continue;
      const record = this.transfers.getTransfer(file.transferId);
      if (!terminal.has(record.status)) {
        if (file.controller.signal.aborted && !cleanupFailed) this.transfers.settleCancelledTransfer(file.transferId);
        else this.transfers.failTransfer(file.transferId, error);
      }
      state.controller.signal.removeEventListener('abort', file.abort);
      file.controller.signal.removeEventListener('abort', file.cancelQueued);
      file.done.resolve();
    }
  }

  async _processFiles(state, context, user) {
    let outerError;
    let workComplete = false;
    try {
      for (const directory of state.directories) {
        await this.withOperationLocks([context.targetPath, directory], async () => {
          state.controller.signal.throwIfAborted();
          await this._recheck(user, context);
          await this.assertSafePath(context.rootPath, directory, { allowMissing: true });
          await this.fs.promises.mkdir(directory, { recursive: true });
        }, { signal: state.controller.signal });
      }
      for (const file of state.files) {
        if (file.cancellation) { await file.cancellation; continue; }
        file.processing = true;
        let failure;
        try {
          file.controller.signal.throwIfAborted();
          this.transfers.updateTransferStatus(file.transferId, 'processing');
          const finalPath = await this._publish(file, context, user);
          // Publication wins a later cancellation. Cache failure cannot undo a committed output.
          this.transfers.completeTransfer(file.transferId, { file: {
            name: file.originalname, path: path.relative(context.rootPath, finalPath).split(path.sep).join('/'), size: file.size
          } });
        } catch (error) { failure = error; }
        finally {
          try { await this.fs.promises.unlink(file.path); }
          catch (error) { if (error.code !== 'ENOENT') { failure = error; file.cleanupFailed = true; } }
          if (failure) {
            if (file.controller.signal.aborted && !file.cleanupFailed) this.transfers.settleCancelledTransfer(file.transferId);
            else this.transfers.failTransfer(file.transferId, failure);
          }
          state.controller.signal.removeEventListener('abort', file.abort);
          file.controller.signal.removeEventListener('abort', file.cancelQueued);
          file.done.resolve();
        }
        this.transfers.updateBatchProgress(state.batchId);
      }
      workComplete = true;
      if (state.directories.length) {
        try {
          await this.withOperationLocks([context.targetPath], () => this._refreshCacheDirectory(context.targetPath, context));
        }
        catch { this._warn('Committed directory upload cache refresh failed'); }
      }
    } catch (error) { outerError = error; }
    await Promise.all(state.files.map(file => file.cancellation));
    let cleanupError;
    try { await this._cleanupStage(state); } catch (error) { cleanupError = error; }
    this._settleRemaining(state, cleanupError || outerError || fault(500, 'Worker stopped'), !!cleanupError);
    const fileCleanupError = state.files.some(file => file.cleanupFailed) ? fault(500, 'Upload cleanup failed') : null;
    this.transfers.updateBatchProgress(state.batchId, { settled: true,
      error: cleanupError || fileCleanupError || (state.controller.signal.aborted ? null : outerError), workComplete });
  }

  async _publish(file, context, user) {
    const signal = file.controller.signal;
    // Lock the parent through exclusive creation, stream settlement, authorization, and cleanup.
    return this.withOperationLocks([context.targetPath, path.dirname(file.destination), file.path], async () => {
      signal.throwIfAborted();
      await this._recheck(user, context);
      await this.assertSafePath(context.rootPath, path.dirname(file.destination), { allowMissing: true });
      await this.fs.promises.mkdir(path.dirname(file.destination), { recursive: true });
      let handle;
      let finalPath;
      let owned = false;
      let committed = false;
      try {
        for (let attempt = 0; ; attempt++) {
          signal.throwIfAborted();
          finalPath = attempt ? path.join(path.dirname(file.destination), dedupeFilename(path.basename(file.destination), attempt)) : file.destination;
          await this.assertSafePath(context.rootPath, finalPath, { allowMissing: true });
          try { handle = await this.fs.promises.open(finalPath, 'wx', 0o666); owned = true; break; }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        await pipeline(this.fs.createReadStream(file.path), handle.createWriteStream(), { signal });
        await handle.close();
        handle = null;
        if ((await this.fs.promises.stat(finalPath)).size !== file.size) throw fault(500, 'Published file size mismatch');
        await this._recheck(user, context);
        signal.throwIfAborted();
        committed = true;
        try { await this._refreshCacheDirectory(path.dirname(finalPath), context); }
        catch { this._warn('Committed upload cache refresh failed'); }
        return finalPath;
      } finally {
        try {
          if (handle) await handle.close();
        } finally {
          // finalPath alone is not proof of ownership: only a successful wx open is.
          if (!committed && owned) {
            try { await this.fs.promises.unlink(finalPath); }
            catch (error) { file.cleanupFailed = true; throw error; }
          }
        }
      }
    }, { signal });
  }

  async _refreshCacheDirectory(directory, context) {
    const isCurrent = () => this.locationManager === context.manager && this.cacheResolver === context.cacheResolver &&
      this.cache === context.cache && context.manager.getRevision(context.locationId) === context.locationRevision;
    if (!isCurrent()) throw fault(409, 'Location changed');
    const cache = context.cacheResolver ? await context.cacheResolver(context.locationId) : context.cache;
    if (!isCurrent()) throw fault(409, 'Location changed');
    if (cache?.refreshDirectory) await cache.refreshDirectory(directory);
    else if (cache?.scanDirectory) await cache.scanDirectory(directory);
  }

  async _assertDestinationSpace(directory, requiredBytes) {
    if (typeof this.fs.promises.statfs !== 'function') return;
    let stats;
    try { stats = await this.fs.promises.statfs(directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const available = Number(stats.bavail) * Number(stats.bsize);
    const reserve = Math.min(64 * 1024 * 1024, Math.floor(available * 0.05));
    if (Number.isFinite(available) && available - reserve < requiredBytes) throw fault(507, 'Insufficient destination storage space');
  }

  async _syncDirectory(directory) {
    let handle;
    try {
      handle = await this.fs.promises.open(directory, 'r');
      await handle.sync();
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
    } finally { await handle?.close().catch(() => {}); }
  }

  _warn(message) { try { this.logger.logSystem('WARN', message); } catch { /* Logging cannot change a committed result. */ } }

  async cleanupTempUploads(retentionDays) {
    if (!Number.isFinite(retentionDays) || retentionDays < 0) throw new TypeError('Invalid retention');
    this.transfers.expireReservations();
    await this.cleanupResumableSessions();
    const result = { scanned: 0, deleted: 0, releasedBytes: 0 };
    let entries;
    try { entries = await this.fs.promises.readdir(this.tempDir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return result; throw error; }
    for (const entry of entries) {
      const candidate = path.join(this.tempDir, entry.name);
      if (activeStages.has(candidate) || (!entry.isFile() && !entry.isDirectory()) || (entry.isDirectory() && !entry.name.startsWith('upload-'))) continue;
      const stat = await this.fs.promises.lstat(candidate);
      result.scanned++;
      if (stat.mtimeMs >= Date.now() - retentionDays * 86400000) continue;
      await this.assertSafeTree(candidate);
      await this.fs.promises.rm(candidate, { recursive: entry.isDirectory(), force: true });
      result.deleted++;
      if (entry.isFile()) result.releasedBytes += stat.size;
    }
    return result;
  }

  async cleanupResumableSessions() {
    if (!this.resumableUploads) return { removed: 0 };
    return this.resumableUploads.cleanupExpired();
  }

  _sanitizeFilename(filename) {
    if (typeof filename !== 'string') throw fault(400, 'Invalid filename');
    // Express has already decoded query parameters. Multipart filenames are literal UTF-8.
    const value = filename.replace(/[\/\\]/g, '_').replace(/\.\./g, '_');
    if (!value || value === '.' || /[<>:"|?*\x00-\x1f]/.test(value)) throw fault(400, 'Invalid filename');
    return value;
  }

  getUploadProgress(id) { return this.transfers.serializeTransfer(id); }
  getAllUploads() { return this.transfers.getAllTransfers().map(t => this.transfers.serializeTransfer(t.id)); }
  getRouter() { return this.router; }
}

module.exports = UploadAPI;
