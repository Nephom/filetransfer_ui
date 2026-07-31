const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const test = require('node:test');
const UploadAPI = require('../src/backend/api/upload');
const { systemLogger } = require('../src/backend/utils/logger');

test('temporary upload cleanup removes only expired regular files', async () => {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'filetransfer-cleanup-'));
  const uploadsDir = path.join(tempRoot, 'temp', 'uploads');

  try {
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.writeFile(path.join(uploadsDir, 'expired-upload'), 'expired');
    await fs.writeFile(path.join(uploadsDir, 'recent-upload'), 'recent');
    await fs.mkdir(path.join(uploadsDir, 'nested-directory'));
    await fs.utimes(path.join(uploadsDir, 'expired-upload'), new Date(0), new Date(0));

    process.chdir(tempRoot);
    systemLogger.setLogLevel('ERROR');
    const result = await new UploadAPI().cleanupTempUploads(7);

    assert.deepStrictEqual(result, { scanned: 2, deleted: 1, releasedBytes: 7 });
    await assert.rejects(fs.access(path.join(uploadsDir, 'expired-upload')));
    await fs.access(path.join(uploadsDir, 'recent-upload'));
    await fs.access(path.join(uploadsDir, 'nested-directory'));
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
