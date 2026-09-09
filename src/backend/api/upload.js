const express = require('express');
const Busboy = require('busboy');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { randomUUID } = require('crypto');
const { setMaxListeners } = require('events');
const { transferManager } = require('../transfer');
const { dedupeFilename } = require('../utils/dedupe-filename');

const activeStages = new Set();
// Match middleware/security.js's extension policy, without its obsolete 100 MiB cap.
const dangerousExtensions = new Set([
  '.exe', '.bat', '.cmd', '.com', '.pif', '.scr', '.vbs', '.js', '.jar',
  '.php', '.asp', '.aspx', '.jsp', '.sh', '.ps1', '.py', '.rb'
]);
const terminal = new Set(['completed', 'failed', 'cancelled', 'partial_fail', 'expired']);
const fault = (statusCode, message) => Object.assign(new Error(message), { statusCode });
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
    this._setupRoutes();
  }

  setCache(cache) { this.cache = cache; }
  setLocationManager(locationManager, cacheResolver = null, locationPermissionManager = null) {
    this.locationManager = locationManager;
    this.cacheResolver = cacheResolver;
    this.locationPermissionManager = locationPermissionManager;
  }

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
    res.status(status).json({ success: false, error: { code: status, message: status < 500 ?
      ({ 400: 'Invalid upload request', 401: 'Authentication required', 403: 'Upload access denied', 404: 'Upload not found',
        409: 'Upload state or Location changed', 413: 'Upload limit exceeded', 429: 'Reservation capacity reached' }[status] || 'Upload rejected') : 'Upload could not be completed' } });
  }

  _setupRoutes() {
    const auth = (req, res, next) => Promise.resolve(this.authenticate(req, res, next)).catch(error => this._respondError(res, error));
    const route = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(error => this._respondError(res, error));
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
      const file = { path: path.join(state.stage, randomUUID()), originalname: path.basename(info.filename.replace(/\\/g, '/')), size: 0 };
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

  _warn(message) { try { this.logger.logSystem('WARN', message); } catch { /* Logging cannot change a committed result. */ } }

  async cleanupTempUploads(retentionDays) {
    if (!Number.isFinite(retentionDays) || retentionDays < 0) throw new TypeError('Invalid retention');
    this.transfers.expireReservations();
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
