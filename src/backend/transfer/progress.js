// Progress tracking for file transfers
class TransferProgress {
  constructor() {
    this.transfers = new Map();
  }

  createTransfer(transferId, totalSize, fileName = null) {
    this.transfers.set(transferId, {
      id: transferId,
      fileName: fileName,
      totalSize: totalSize,
      transferredSize: 0,
      startTime: Date.now(),
      status: 'pending', // pending | uploading | processing | completed | failed
      error: null
    });
  }

  updateProgress(transferId, transferredSize) {
    const transfer = this.transfers.get(transferId);
    if (transfer) {
      transfer.transferredSize = transferredSize;
      transfer.updatedAt = Date.now();

      // Auto-update status based on progress
      if (transfer.status === 'pending' && transferredSize > 0) {
        transfer.status = 'uploading';
      }
    }
  }

  updateStatus(transferId, status) {
    const transfer = this.transfers.get(transferId);
    if (transfer) {
      const validStatuses = ['pending', 'uploading', 'processing', 'completed', 'failed'];
      if (validStatuses.includes(status)) {
        transfer.status = status;
        transfer.updatedAt = Date.now();
      }
    }
  }

  getProgress(transferId) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return null;

    const progress = transfer.totalSize > 0
      ? parseFloat(((transfer.transferredSize / transfer.totalSize) * 100).toFixed(2))
      : 0;

    return {
      id: transfer.id,
      fileName: transfer.fileName,
      totalSize: transfer.totalSize,
      transferredSize: transfer.transferredSize,
      progress: progress,
      status: transfer.status,
      elapsedTime: Date.now() - transfer.startTime,
      error: transfer.error
    };
  }

  completeTransfer(transferId) {
    const transfer = this.transfers.get(transferId);
    if (transfer) {
      transfer.status = 'completed';
      transfer.completedAt = Date.now();
    }
  }

  failTransfer(transferId, error) {
    const transfer = this.transfers.get(transferId);
    if (transfer) {
      transfer.status = 'failed';
      transfer.error = error;
      transfer.failedAt = Date.now();
    }
  }

  removeTransfer(transferId) {
    this.transfers.delete(transferId);
  }
}

module.exports = new TransferProgress();