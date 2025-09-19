/**
 * Test file for the file system abstraction
 */

const { FileSystem, LocalFileSystem } = require('../src/backend/file-system');
const ConfigManager = require('../src/backend/config');
const fs = require('fs').promises;
const path = require('path');

describe('FileSystem Abstraction', () => {
  let fileSystem;
  const testDir = './test-files';

  beforeAll(async () => {
    // Create a test directory
    await fs.mkdir(testDir, { recursive: true });
    fileSystem = new FileSystem();
  });

  afterAll(async () => {
    // Clean up test files
    try {
      await fs.rm(testDir, { recursive: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test('should initialize FileSystem correctly', () => {
    expect(fileSystem).toBeInstanceOf(FileSystem);
  });

  test('should create and write files', async () => {
    const testFile = path.join(testDir, 'test.txt');
    const content = 'Hello, World!';

    await fileSystem.write(testFile, content);

    const result = await fileSystem.read(testFile);
    expect(result.toString()).toBe(content);
  });

  test('should list directory contents', async () => {
    // Clean up any existing files first
    try {
      await fs.rm(testDir, { recursive: true });
      await fs.mkdir(testDir, { recursive: true });
    } catch (error) {
      // Ignore cleanup errors
    }

    const testFile = path.join(testDir, 'list-test.txt');
    const content = 'Test file for listing';

    await fileSystem.write(testFile, content);

    const items = await fileSystem.list(testDir);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('list-test.txt');
  });

  test('should create directories', async () => {
    const newDir = path.join(testDir, 'new-directory');

    await fileSystem.mkdir(newDir);
    const exists = await fileSystem.exists(newDir);
    expect(exists).toBe(true);
  });

  test('should delete files', async () => {
    const testFile = path.join(testDir, 'delete-test.txt');
    const content = 'This will be deleted';

    await fileSystem.write(testFile, content);
    const existsBefore = await fileSystem.exists(testFile);
    expect(existsBefore).toBe(true);

    await fileSystem.delete(testFile);
    const existsAfter = await fileSystem.exists(testFile);
    expect(existsAfter).toBe(false);
  });

  test('should get file stats', async () => {
    const testFile = path.join(testDir, 'stats-test.txt');
    const content = 'Test file for stats';

    await fileSystem.write(testFile, content);
    const stats = await fileSystem.stat(testFile);

    expect(stats).toHaveProperty('size');
    expect(stats).toHaveProperty('isFile');
    expect(stats).toHaveProperty('isDirectory');
    expect(stats.isFile).toBe(true);
  });
});

describe('ConfigManager', () => {
  let configManager;

  beforeEach(async () => {
    configManager = new ConfigManager();
    // Load configuration before each test
    await configManager.load();
  });

  test('should load default configuration', async () => {
    const config = await configManager.load();
    expect(config).toHaveProperty('fileSystem');
    expect(config).toHaveProperty('server');
    expect(config).toHaveProperty('security');
  });

  test('should get configuration values', () => {
    const port = configManager.get('server.port');
    expect(port).toBe(3000);
  });

  test('should set configuration values', () => {
    configManager.set('server.port', 4000);
    const port = configManager.get('server.port');
    expect(port).toBe(4000);
  });

  test('should validate configuration', async () => {
    // Test valid config
    const config = await configManager.load();
    expect(config).toBeDefined();

    // Test that we can set and get values correctly
    configManager.set('server.port', 8080);
    const newPort = configManager.get('server.port');
    expect(newPort).toBe(8080);
  });
});