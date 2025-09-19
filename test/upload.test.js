/**
 * Test file for the upload API
 */

const UploadAPI = require('../src/backend/api/upload');
const { transferManager } = require('../src/backend/transfer');

describe('UploadAPI', () => {
  let uploadAPI;

  beforeEach(() => {
    uploadAPI = new UploadAPI();
  });

  test('should create upload API instance', () => {
    expect(uploadAPI).toBeDefined();
    expect(uploadAPI.getRouter).toBeDefined();
  });

  test('should start transfer correctly', () => {
    const transferId = transferManager.startTransfer({
      source: '/test/source.txt',
      destination: '/test/dest.txt',
      totalSize: 1024
    });

    const transfer = transferManager.getTransfer(transferId);
    expect(transfer).toBeDefined();
    expect(transfer.status).toBe('pending');
  });

  test('should update transfer progress', () => {
    const transferId = transferManager.startTransfer({
      source: '/test/source.txt',
      destination: '/test/dest.txt',
      totalSize: 1024
    });

    const updatedTransfer = transferManager.updateProgress(transferId, 512, 1024);

    expect(updatedTransfer.progress).toBe(50);
    expect(updatedTransfer.transferred).toBe(512);
  });
});