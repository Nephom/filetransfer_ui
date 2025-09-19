/**
 * Transfer Management System
 * Handles real-time progress tracking for file transfers
 */

const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');

class TransferManager extends EventEmitter {
  /**
   * Initialize transfer manager
   */
  constructor() {
    super();
    this.transfers = new Map();
    this.transferIdCounter = 0;
  }

  /**
   * Start a new file transfer
   * @param {Object} options - Transfer options
   * @returns {string} Transfer ID
   */
  startTransfer(options = {}) {
    const transferId = `transfer_${++this.transferIdCounter}`;

    const transfer = {
      id: transferId,
      status: 'pending',
      source: options.source,
      destination: options.destination,
      totalSize: options.totalSize || 0,
      transferred: 0,
      startTime: Date.now(),
      progress: 0,
      error: null
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
    transfer.transferred = Math.min(transferredBytes, transfer.totalSize);

    // Calculate progress percentage
    if (transfer.totalSize > 0) {
      transfer.progress = Math.round((transfer.transferred / transfer.totalSize) * 100);
    } else {
      transfer.progress = 0;
    }

    // Update status based on progress
    if (transfer.progress >= 100) {
      transfer.status = 'completed';
    } else if (transfer.transferred > 0) {
      transfer.status = 'in_progress';
    } else {
      transfer.status = 'pending';
    }

    // Emit progress update
    this.emit('progressUpdate', transfer);

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
      inProgress: transfers.filter(t => t.status === 'in_progress').length,
      failed: transfers.filter(t => t.status === 'failed').length,
      pending: transfers.filter(t => t.status === 'pending').length
    };
  }
}

// Export singleton instance for easy access
const transferManager = new TransferManager();

module.exports = { TransferManager, transferManager };