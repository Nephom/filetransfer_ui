// Progress tracking for file transfers
class TransferProgress {
  constructor() {
    this.transfers = new Map();
  }

  createTransfer(transferId, totalSize) {
    this.transfers.set(transferId, {
      id: transferId,
      totalSize: totalSize,
      transferred: 0,
      startTime: Date.now(),
      status: 'in_progress'
    });
  }

  updateProgress(transferId, transferred) {
    const transfer = this.transfers.get(transferId);
    if (transfer) {
      transfer.transferred = transferred;
      transfer.updatedAt = Date.now();
    }
  }

  getProgress(transferId) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return null;

    return {
      id: transfer.id,
      totalSize: transfer.totalSize,
      transferred: transfer.transferred,
      progress: transfer.totalSize > 0 ? (transfer.transferred / transfer.totalSize) * 100 : 0,
      status: transfer.status,
      elapsedTime: Date.now() - transfer.startTime
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