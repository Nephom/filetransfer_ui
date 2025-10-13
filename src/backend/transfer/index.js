/**
 * Transfer Management System
 * Handles real-time progress tracking for file transfers
 */

const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class TransferManager extends EventEmitter {
  /**
   * Initialize transfer manager
   */
  constructor() {
    super();
    this.transfers = new Map();
    this.batches = new Map();
    this.transferIdCounter = 0;
  }

  /**
   * Start a new file transfer
   * @param {Object} options - Transfer options
   * @returns {string} Transfer ID
   */
  startTransfer(options = {}) {
    const transferId = options.id || uuidv4();

    const transfer = {
      id: transferId,
      status: 'pending', // pending | uploading | processing | completed | failed
      fileName: options.fileName || null,
      source: options.source,
      destination: options.destination,
      totalSize: options.totalSize || 0,
      transferredSize: 0,
      startTime: Date.now(),
      progress: 0,
      error: null,
      batchId: options.batchId || null
    };

    this.transfers.set(transferId, transfer);

    // Emit event for new transfer
    this.emit('transferStarted', transfer);

    return transferId;
  }

  /**
   * Update transfer progress
   * @param {string} transferId - Transfer ID
   * @param {number} transferredBytes - Bytes transferred
   * @param {number} totalBytes - Total bytes to transfer
   */
  updateProgress(transferId, transferredBytes, totalBytes = null) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      throw new Error(`Transfer ${transferId} not found`);
    }

    // Update total if provided
    if (totalBytes !== null) {
      transfer.totalSize = totalBytes;
    }

    // Update transferred bytes
    transfer.transferredSize = Math.min(transferredBytes, transfer.totalSize);

    // Calculate progress percentage
    if (transfer.totalSize > 0) {
      transfer.progress = parseFloat(((transfer.transferredSize / transfer.totalSize) * 100).toFixed(2));
    } else {
      transfer.progress = 0;
    }

    // Update status based on progress
    if (transfer.status !== 'completed' && transfer.status !== 'failed') {
      if (transfer.progress >= 100) {
        transfer.status = 'processing';
      } else if (transfer.transferredSize > 0) {
        transfer.status = 'uploading';
      }
    }

    // Emit progress update
    this.emit('progressUpdate', transfer);

    return transfer;
  }

  /**
   * Update transfer status
   * @param {string} transferId - Transfer ID
   * @param {string} status - New status (pending | uploading | processing | completed | failed)
   */
  updateTransferStatus(transferId, status) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      throw new Error(`Transfer ${transferId} not found`);
    }

    const validStatuses = ['pending', 'uploading', 'processing', 'completed', 'failed'];
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
    }

    transfer.status = status;
    this.emit('statusUpdate', transfer);

    return transfer;
  }

  /**
   * Complete a transfer
   * @param {string} transferId - Transfer ID
   * @param {Object} result - Transfer result
   */
  completeTransfer(transferId, result = {}) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      throw new Error(`Transfer ${transferId} not found`);
    }

    transfer.status = 'completed';
    transfer.endTime = Date.now();
    transfer.duration = transfer.endTime - transfer.startTime;

    // Merge result data
    Object.assign(transfer, result);

    // Emit completion event
    this.emit('transferCompleted', transfer);

    return transfer;
  }

  /**
   * Fail a transfer
   * @param {string} transferId - Transfer ID
   * @param {string} error - Error message
   */
  failTransfer(transferId, error) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      throw new Error(`Transfer ${transferId} not found`);
    }

    transfer.status = 'failed';
    transfer.error = error;
    transfer.endTime = Date.now();
    transfer.duration = transfer.endTime - transfer.startTime;

    // Emit failure event
    this.emit('transferFailed', transfer);

    return transfer;
  }

  /**
   * Get transfer status
   * @param {string} transferId - Transfer ID
   * @returns {Object|null} Transfer status or null if not found
   */
  getTransfer(transferId) {
    return this.transfers.get(transferId) || null;
  }

  /**
   * Get all transfers
   * @returns {Array} Array of all transfers
   */
  getAllTransfers() {
    return Array.from(this.transfers.values());
  }

  /**
   * Remove completed transfer
   * @param {string} transferId - Transfer ID
   */
  removeTransfer(transferId) {
    return this.transfers.delete(transferId);
  }

  /**
   * Get transfer statistics
   * @returns {Object} Transfer statistics
   */
  getStats() {
    const transfers = this.getAllTransfers();

    return {
      total: transfers.length,
      completed: transfers.filter(t => t.status === 'completed').length,
      uploading: transfers.filter(t => t.status === 'uploading').length,
      processing: transfers.filter(t => t.status === 'processing').length,
      failed: transfers.filter(t => t.status === 'failed').length,
      pending: transfers.filter(t => t.status === 'pending').length
    };
  }

  /**
   * Create a new batch for multi-file upload
   * @param {Object} options - Batch options
   * @returns {string} Batch ID
   */
  createBatch(options = {}) {
    const batchId = options.batchId || uuidv4();

    const batch = {
      batchId,
      status: 'uploading', // uploading | completed | partial_fail
      totalFiles: options.totalFiles || 0,
      files: [], // Array of transferIds
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.batches.set(batchId, batch);

    // Emit event for new batch
    this.emit('batchCreated', batch);

    return batchId;
  }

  /**
   * Get batch information
   * @param {string} batchId - Batch ID
   * @returns {Object|null} Batch object or null if not found
   */
  getBatch(batchId) {
    return this.batches.get(batchId) || null;
  }

  /**
   * Add transfer to batch
   * @param {string} batchId - Batch ID
   * @param {string} transferId - Transfer ID
   */
  addTransferToBatch(batchId, transferId) {
    const batch = this.batches.get(batchId);
    if (!batch) {
      throw new Error(`Batch ${batchId} not found`);
    }

    if (!batch.files.includes(transferId)) {
      batch.files.push(transferId);
      batch.updatedAt = Date.now();
    }

    return batch;
  }

  /**
   * Update batch progress (recalculate based on individual transfers)
   * @param {string} batchId - Batch ID
   */
  updateBatchProgress(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch) {
      throw new Error(`Batch ${batchId} not found`);
    }

    batch.updatedAt = Date.now();

    // Calculate batch status based on all transfers
    const stats = this.calculateBatchStats(batchId);

    // Update batch status
    if (stats.successCount + stats.failedCount === batch.totalFiles && batch.totalFiles > 0) {
      if (stats.failedCount === 0) {
        batch.status = 'completed';
      } else if (stats.successCount > 0) {
        batch.status = 'partial_fail';
      } else {
        batch.status = 'failed';
      }
    }

    this.emit('batchProgressUpdated', batch);

    return batch;
  }

  /**
   * Calculate batch statistics
   * @param {string} batchId - Batch ID
   * @returns {Object} Batch statistics
   */
  calculateBatchStats(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch) {
      throw new Error(`Batch ${batchId} not found`);
    }

    const transfers = batch.files.map(id => this.transfers.get(id)).filter(t => t);

    const stats = {
      totalFiles: batch.totalFiles,
      successCount: transfers.filter(t => t.status === 'completed').length,
      failedCount: transfers.filter(t => t.status === 'failed').length,
      pendingCount: transfers.filter(t => t.status === 'pending').length,
      uploadingCount: transfers.filter(t => t.status === 'uploading').length,
      processingCount: transfers.filter(t => t.status === 'processing').length,
      totalSize: transfers.reduce((sum, t) => sum + (t.totalSize || 0), 0),
      transferredSize: transfers.reduce((sum, t) => sum + (t.transferredSize || 0), 0),
      progress: 0,
      files: transfers.map(t => ({
        fileName: t.fileName,
        status: t.status,
        progress: t.progress,
        error: t.error || null
      }))
    };

    // Calculate overall progress
    if (stats.totalSize > 0) {
      stats.progress = parseFloat(((stats.transferredSize / stats.totalSize) * 100).toFixed(2));
    }

    return stats;
  }

  /**
   * Get all batches
   * @returns {Array} Array of all batches
   */
  getAllBatches() {
    return Array.from(this.batches.values());
  }

  /**
   * Remove batch
   * @param {string} batchId - Batch ID
   */
  removeBatch(batchId) {
    return this.batches.delete(batchId);
  }
}

// Export singleton instance for easy access
const transferManager = new TransferManager();

module.exports = { TransferManager, transferManager };