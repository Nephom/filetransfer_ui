/**
 * Test file for the transfer management system
 */

const { TransferManager, transferManager } = require('../src/backend/transfer');

describe('TransferManager', () => {
  let transferManager;

  beforeEach(() => {
    transferManager = new TransferManager();
  });

  test('should create a new transfer', () => {
    const transferId = transferManager.startTransfer({
      source: '/source/file.txt',
      destination: '/destination/file.txt',
      totalSize: 1024
    });

    expect(transferId).toMatch(/^transfer_\d+$/);
    expect(transferManager.getTransfer(transferId)).toBeDefined();
  });

  test('should update transfer progress', () => {
    const transferId = transferManager.startTransfer({
      source: '/source/file.txt',
      destination: '/destination/file.txt',
      totalSize: 1024
    });

    const transfer = transferManager.updateProgress(transferId, 512, 1024);

    expect(transfer.progress).toBe(50);
    expect(transfer.transferred).toBe(512);
  });

  test('should complete a transfer', () => {
    const transferId = transferManager.startTransfer({
      source: '/source/file.txt',
      destination: '/destination/file.txt',
      totalSize: 1024
    });

    const transfer = transferManager.completeTransfer(transferId, {
      result: 'success'
    });

    expect(transfer.status).toBe('completed');
    expect(transfer.result).toBe('success');
  });

  test('should fail a transfer', () => {
    const transferId = transferManager.startTransfer({
      source: '/source/file.txt',
      destination: '/destination/file.txt',
      totalSize: 1024
    });

    const transfer = transferManager.failTransfer(transferId, 'File not found');

    expect(transfer.status).toBe('failed');
    expect(transfer.error).toBe('File not found');
  });

  test('should get transfer statistics', () => {
    // Create some transfers
    transferManager.startTransfer({ totalSize: 1024 });
    transferManager.startTransfer({ totalSize: 2048 });

    const stats = transferManager.getStats();
    expect(stats.total).toBe(2);
  });
});