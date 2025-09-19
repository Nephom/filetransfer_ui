/**
 * Test file for file operations
 */

const FileOperations = require('../src/backend/file-system/operations');
const { FileSystem } = require('../src/backend/file-system');

describe('FileOperations', () => {
  let fileOperations;
  const testDir = './test-files-operations';

  beforeAll(async () => {
    // Create a test directory
    const fs = require('fs').promises;
    await fs.mkdir(testDir, { recursive: true });

    const fileSystem = new FileSystem();
    fileOperations = new FileOperations(fileSystem);
  });

  afterAll(async () => {
    // Clean up test files
    const fs = require('fs').promises;
    try {
      await fs.rm(testDir, { recursive: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test('should create directory', async () => {
    const newDir = `${testDir}/new-test-dir`;
    const result = await fileOperations.createDirectory(newDir);

    expect(result.success).toBe(true);
    expect(result.operation).toBe('mkdir');
  });

  test('should fail to create existing directory', async () => {
    const result = await fileOperations.createDirectory(testDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });

  test('should get file info', async () => {
    const testFile = `${testDir}/test.txt`;

    // Create a test file
    const fs = require('fs').promises;
    await fs.writeFile(testFile, 'test content');

    const result = await fileOperations.fileInfo(testFile);

    expect(result.success).toBe(true);
    expect(result.path).toBe(testFile);
    expect(result.stats).toHaveProperty('size');
    expect(result.stats).toHaveProperty('isFile');
  });
});