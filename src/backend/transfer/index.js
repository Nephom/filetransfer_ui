const EventEmitter = require('events');
const { randomUUID } = require('crypto');

const terminal = new Set(['completed', 'failed', 'cancelled', 'partial_fail', 'expired']);
const bytes = value => Number.isSafeInteger(value) && value >= 0;
const percentage = (total, transferred, known, completed) => known
  ? (total ? Math.min(100, Math.round(transferred / total * 10000) / 100) : (completed ? 100 : 0)) : 0;
const sameOwner = (a, b) => !!a && !!b && a.id === b.id && a.username === b.username;
const conflict = () => Object.assign(new Error('Batch reservation is unavailable'), { statusCode: 409 });

class TransferManager extends EventEmitter {
  #controls = new Map();

  constructor({ now = Date.now, reservationMs = 15 * 60 * 1000, maxReservations = 1000 } = {}) {
    super();
    this.now = now;
    this.reservationMs = Math.min(Math.max(reservationMs, 1), 60 * 60 * 1000);
    this.maxReservations = maxReservations;
    this.transfers = new Map();
    this.batches = new Map();
  }

  _identity(record, options) {
    Object.defineProperties(record, {
      owner: { value: options.owner ? Object.freeze({ id: options.owner.id, username: options.owner.username }) : null, enumerable: true },
      locationId: { value: options.locationId || null, enumerable: true },
      locationRevision: { value: options.locationRevision, enumerable: true }
    });
    return record;
  }

  startTransfer(options = {}) {
    const id = options.id || randomUUID();
    if (this.transfers.has(id)) throw conflict();
    const batch = options.batchId ? this.getBatch(options.batchId) : null;
    if (batch && terminal.has(batch.status)) throw conflict();
    const record = this._identity({
      id, batchId: options.batchId || null, fileName: options.fileName || null,
      source: options.source, destination: options.destination,
      status: 'pending', phase: options.phase || 'pending',
      totalSize: bytes(options.totalSize) ? options.totalSize : 0,
      totalSizeKnown: options.totalSizeKnown ?? bytes(options.totalSize),
      transferredSize: 0, committedSize: 0, progress: 0, error: null,
      startTime: this.now(), updatedAt: this.now()
    }, batch || options);
    if (!record.totalSizeKnown) record.totalSize = 0;
    this.transfers.set(id, record);
    if (batch) this.addTransferToBatch(batch.batchId, id);
    this.emit('transferStarted', record);
    return id;
  }

  updateProgress(id, transferredBytes, totalBytes = null) {
    const record = this.getTransfer(id);
    if (!record || terminal.has(record.status)) return record;
    if (!bytes(transferredBytes) || (totalBytes !== null && !bytes(totalBytes))) throw new TypeError('Invalid byte count');
    if (totalBytes !== null) {
      record.totalSize = totalBytes;
      record.totalSizeKnown = true;
    }
    record.transferredSize = Math.max(record.transferredSize, transferredBytes);
    record.progress = percentage(record.totalSize, record.transferredSize, record.totalSizeKnown, false);
    record.updatedAt = this.now();
    this.emit('progressUpdate', record);
    return record;
  }

  updateTransferStatus(id, status, phase = status) {
    const record = this.getTransfer(id);
    if (!record || terminal.has(record.status) || record.status === 'cancelling') return record;
    if (!['pending', 'uploading', 'processing'].includes(status)) throw new TypeError('Use a terminal transition method');
    Object.assign(record, { status, phase, updatedAt: this.now() });
    this.emit('statusUpdate', record);
    return record;
  }

  _finish(record, status) {
    if (!record || terminal.has(record.status)) return false;
    Object.assign(record, { status, phase: status, updatedAt: this.now(), endTime: this.now() });
    record.duration = record.endTime - (record.startTime ?? record.createdAt);
    return true;
  }

  completeTransfer(id, result = {}) {
    const record = this.getTransfer(id);
    if (!this._finish(record, 'completed')) return record;
    // Completion never invents bytes or merges caller-controlled identity/status.
    record.file = result.file;
    record.result = 'success';
    record.committedSize = record.transferredSize;
    record.progress = percentage(record.totalSize, record.transferredSize, record.totalSizeKnown, true);
    this.emit('transferCompleted', record);
    return record;
  }

  failTransfer(id, error) {
    const record = this.getTransfer(id);
    if (this._finish(record, 'failed')) {
      record.error = error;
      this.emit('transferFailed', record);
    }
    return record;
  }

  settleCancelledTransfer(id) {
    const record = this.getTransfer(id);
    this._finish(record, 'cancelled');
    return record;
  }

  createBatch(options = {}) {
    const batchId = options.batchId || randomUUID();
    if (this.batches.has(batchId)) throw conflict();
    const batch = this._identity({
      batchId, status: options.reserved ? 'reserved' : 'uploading',
      phase: options.reserved ? 'reserved' : 'receiving',
      totalFiles: options.totalFiles || 0, files: [], inventoryComplete: false,
      path: options.path || '', targetPath: options.targetPath,
      clientAttemptId: options.clientAttemptId,
      createdAt: this.now(), updatedAt: this.now(),
      expiresAt: options.reserved ? this.now() + this.reservationMs : null
    }, options);
    this.batches.set(batchId, batch);
    this.emit('batchCreated', batch);
    return batchId;
  }

  reserveBatch(options) {
    this.expireReservations();
    if (options.clientAttemptId) {
      const existing = this.getAllBatches().find(batch => sameOwner(batch.owner, options.owner) &&
        batch.clientAttemptId === options.clientAttemptId);
      if (existing) {
        if (existing.status !== 'reserved' || existing.locationId !== options.locationId ||
            existing.locationRevision !== options.locationRevision || existing.path !== options.path) throw conflict();
        return existing.batchId;
      }
    }
    if (this.getAllBatches().filter(batch => batch.status === 'reserved').length >= this.maxReservations) {
      throw Object.assign(new Error('Reservation capacity reached'), { statusCode: 429 });
    }
    return this.createBatch({ ...options, reserved: true });
  }

  claimBatch(id, context) {
    this.expireReservations();
    const batch = this.getBatch(id);
    if (!batch || batch.status !== 'reserved' || !sameOwner(batch.owner, context.owner) ||
        batch.locationId !== context.locationId || batch.locationRevision !== context.locationRevision ||
        batch.path !== context.path || batch.targetPath !== context.targetPath) throw conflict();
    Object.assign(batch, { status: 'uploading', phase: 'receiving', updatedAt: this.now() });
    return batch;
  }

  expireReservations(now = this.now()) {
    for (const batch of this.batches.values()) {
      if (batch.status === 'reserved' && batch.expiresAt <= now) this._finish(batch, 'expired');
    }
  }

  addTransferToBatch(batchId, id) {
    const batch = this.getBatch(batchId);
    const transfer = this.getTransfer(id);
    if (!batch || !transfer || transfer.batchId !== batchId || terminal.has(batch.status)) throw conflict();
    if (!batch.files.includes(id)) batch.files.push(id);
    batch.totalFiles = Math.max(batch.totalFiles, batch.files.length);
    return batch;
  }

  sealBatch(id) {
    const batch = this.getBatch(id);
    batch.inventoryComplete = true;
    batch.totalFiles = batch.files.length;
    batch.phase = 'processing';
    batch.updatedAt = this.now();
  }

  calculateBatchStats(id) {
    const batch = this.getBatch(id);
    if (!batch) return null;
    const transfers = batch.files.map(id => this.getTransfer(id)).filter(Boolean);
    const count = status => transfers.filter(record => record.status === status).length;
    const totalSizeKnown = batch.inventoryComplete && transfers.length === batch.totalFiles && transfers.every(t => t.totalSizeKnown);
    const totalSize = totalSizeKnown ? transfers.reduce((sum, t) => sum + t.totalSize, 0) : 0;
    const transferredSize = transfers.reduce((sum, t) => sum + t.transferredSize, 0);
    const successCount = count('completed');
    const failedCount = count('failed');
    const cancelledCount = count('cancelled');
    return {
      totalFiles: batch.totalFiles, successCount, failedCount, cancelledCount,
      pendingCount: batch.totalFiles - successCount - failedCount - cancelledCount,
      uploadingCount: count('uploading'), processingCount: count('processing'),
      totalSize, totalSizeKnown, transferredSize,
      committedSize: transfers.reduce((sum, t) => sum + t.committedSize, 0),
      progress: percentage(totalSize, transferredSize, totalSizeKnown, batch.status === 'completed'),
      files: transfers.map(t => this.serializeTransfer(t.id))
    };
  }

  updateBatchProgress(id, { settled = false, error = null, workComplete = false } = {}) {
    const batch = this.getBatch(id);
    if (!batch || terminal.has(batch.status)) return batch;
    const stats = this.calculateBatchStats(id);
    if (settled && stats.pendingCount === 0) {
      const completed = batch.inventoryComplete && stats.successCount === stats.totalFiles && (stats.totalFiles > 0 || workComplete);
      const status = error ? 'failed' : completed ? 'completed' : stats.cancelledCount || batch.status === 'cancelling' ? 'cancelled'
        : stats.failedCount ? (stats.successCount ? 'partial_fail' : 'failed') : 'completed';
      this._finish(batch, status);
      batch.error = error;
    }
    this.emit('batchProgressUpdated', batch);
    return batch;
  }

  // Controls stay outside records and exist until all stream and cleanup work settles.
  registerWorker(id, controller, settled, isBatch = false) {
    const key = `${isBatch ? 'batch' : 'transfer'}:${id}`;
    if (this.#controls.has(key)) throw new Error('Worker already registered');
    const control = { controller, settled: Promise.resolve(settled), cancellation: null };
    this.#controls.set(key, control);
    control.settled.finally(() => {
      if (this.#controls.get(key) === control) this.#controls.delete(key);
    }).catch(() => {});
  }

  async _cancel(id, isBatch) {
    const record = isBatch ? this.getBatch(id) : this.getTransfer(id);
    if (!record || terminal.has(record.status)) return record;
    const wasReserved = record.status === 'reserved';
    const control = this.#controls.get(`${isBatch ? 'batch' : 'transfer'}:${id}`);
    record.status = 'cancelling';
    record.phase = 'cancelling';
    record.updatedAt = this.now();
    if (!control) {
      // Only unclaimed reservations have no worker. Never confirm an uncontrolled active job.
      if (isBatch && wasReserved) this._finish(record, 'cancelled');
      return record;
    }
    if (!control.cancellation) {
      control.cancellation = (async () => {
        control.controller.abort();
        try { await control.settled; } catch { /* Worker records cleanup failure. */ }
        return record;
      })();
    }
    return control.cancellation;
  }

  cancelTransfer(id) { return this._cancel(id, false); }
  cancelBatch(id) { return this._cancel(id, true); }
  getTransfer(id) { return this.transfers.get(id) || null; }
  getBatch(id) { this.expireReservations(); return this.batches.get(id) || null; }
  getAllTransfers() { return Array.from(this.transfers.values()); }
  getAllBatches() { return Array.from(this.batches.values()); }

  serializeTransfer(id) {
    const t = this.getTransfer(id);
    if (!t) return null;
    const file = t.file;
    const safePath = typeof file?.path === 'string' && !file.path.startsWith('/') &&
      !file.path.includes('\\') && !file.path.split('/').includes('..') && !/^[a-z]:/i.test(file.path);
    return {
      id: t.id, batchId: t.batchId, locationId: t.locationId, fileName: t.fileName,
      status: t.status, phase: t.phase, totalSize: t.totalSizeKnown ? t.totalSize : 0,
      totalSizeKnown: t.totalSizeKnown, transferredSize: t.transferredSize,
      committedSize: t.committedSize, progress: t.progress,
      startTime: t.startTime, updatedAt: t.updatedAt, endTime: t.endTime,
      error: t.error ? { code: 'UPLOAD_FAILED', message: 'Upload could not be completed' } : null,
      ...(safePath ? { file: { name: file.name, path: file.path, size: file.size } } : {})
    };
  }

  serializeBatch(id) {
    const batch = this.getBatch(id);
    if (!batch) return null;
    return {
      batchId: id, locationId: batch.locationId, status: batch.status, phase: batch.phase,
      createdAt: batch.createdAt, updatedAt: batch.updatedAt, expiresAt: batch.expiresAt,
      ...this.calculateBatchStats(id),
      error: batch.error ? { code: 'UPLOAD_FAILED', message: 'Upload could not be completed' } : null
    };
  }

  removeTransfer(id) {
    const t = this.getTransfer(id);
    if (!t || !terminal.has(t.status) || this.#controls.has(`transfer:${id}`) || (t.batchId && this.batches.has(t.batchId))) return false;
    return this.transfers.delete(id);
  }

  removeBatch(id) {
    const batch = this.getBatch(id);
    if (!batch || !terminal.has(batch.status) || this.#controls.has(`batch:${id}`) ||
        batch.files.some(id => this.#controls.has(`transfer:${id}`))) return false;
    return this.batches.delete(id);
  }

  getStats() {
    const all = this.getAllTransfers();
    return Object.fromEntries(['total', 'completed', 'uploading', 'processing', 'failed', 'pending', 'cancelled']
      .map(status => [status, status === 'total' ? all.length : all.filter(t => t.status === status).length]));
  }

  cleanup(retentionMs = 24 * 60 * 60 * 1000, now = this.now()) {
    this.expireReservations(now);
    let batchesRemoved = 0;
    let transfersRemoved = 0;
    for (const batch of this.batches.values()) {
      if (terminal.has(batch.status) && now - batch.endTime >= retentionMs && this.removeBatch(batch.batchId)) batchesRemoved++;
    }
    for (const t of this.transfers.values()) {
      if (terminal.has(t.status) && now - t.endTime >= retentionMs && this.removeTransfer(t.id)) transfersRemoved++;
    }
    return { transfersRemoved, batchesRemoved };
  }
}

const transferManager = new TransferManager();
module.exports = { TransferManager, transferManager };
