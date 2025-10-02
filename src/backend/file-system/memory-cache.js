const EventEmitter = require('events');
const { createClient } = require('redis');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const chokidar = require('chokidar');
const { systemLogger } = require('../utils/logger');

/**
 * Redis-based file system cache with file watching
 */
class RedisFileSystemCache extends EventEmitter {
  constructor(storagePath = './storage', redisOptions = {}) {
    super();
    this.storagePath = path.resolve(storagePath); // Ensure it's an absolute path
    this.redisOptions = {
      host: redisOptions.host || 'localhost',
      port: redisOptions.port || 6379,
      ...redisOptions
    };
    this.redisClient = null;
    this.activeWatchers = new Map(); // Use a map to track active watchers
    this.initialized = false;
    this.fileHashes = new Map();
    this.directoryCache = new Map();
    this.scanQueue = [];
    this.isScanning = false;
  }

  /**
   * Initialize the cache and connect to Redis
   */
  async initialize() {
    try {
      await systemLogger.logSystem('INFO', 'Initializing Redis file system cache...');

      // Connect to Redis
      this.redisClient = createClient(this.redisOptions);

      this.redisClient.on('error', (err) => {
        systemLogger.logSystem('ERROR', `Redis Client Error: ${err.message}`);
      });

      this.redisClient.on('connect', () => {
        systemLogger.logSystem('INFO', 'Connected to Redis');
      });

      await this.redisClient.connect();

      // Initialize file hashes from Redis (existing cached data)
      await this.loadFileHashes();

      // Start file watcher to monitor changes
      await this.startFileWatcher();

      // Cache only the root directory (non-recursive)
      await this.updateDirectoryCache(this.storagePath);

      this.initialized = true;
      systemLogger.logSystem('INFO', 'Redis file system cache initialized successfully');

      return true;
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to initialize Redis cache: ${error.message}`);
      return false;
    }
  }

  /**
   * Load file hashes from Redis
   */
  async loadFileHashes() {
    try {
      // Get all file entries from Redis
      const keys = await this.redisClient.keys('file:*');
      
      for (const key of keys) {
        const fileData = await this.redisClient.hGetAll(key);
        if (fileData && fileData.path && fileData.hash) {
          this.fileHashes.set(fileData.path, {
            hash: fileData.hash,
            modified: fileData.modified
          });
        }
      }
      
      systemLogger.logSystem('INFO', `Loaded ${this.fileHashes.size} file hashes from Redis`);
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to load file hashes: ${error.message}`);
    }
  }

  /**
   * Load ignore list from .ignoreDirs file
   */
  async loadIgnoreList() {
    const ignoreFile = path.join(this.storagePath, '.ignoreDirs');
    const defaultIgnoreList = [
      '**/node_modules/**',
      '**/.git/**',
      '**/.Trash-1000/**',
      '**/vm/**',
      '**/.nfs*',
    ];

    try {
      const content = await fs.readFile(ignoreFile, 'utf8');
      const customIgnores = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => `**/${line}/**`);

      return [...defaultIgnoreList, ...customIgnores];
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Create .ignoreDirs file with existing ignores
        await this.createIgnoreFile(ignoreFile, defaultIgnoreList);
      }
      return defaultIgnoreList;
    }
  }

  /**
   * Create .ignoreDirs file with default ignores
   */
  async createIgnoreFile(ignoreFile, defaultIgnoreList) {
    try {
      const content = defaultIgnoreList.map(pattern => {
        const dirName = pattern.match(/\*\*\/([^\/]+)\/\*\*/)[1];
        return dirName;
      }).join('\n');

      await fs.writeFile(ignoreFile, `# Ignore file for file system cache\n# Add directories to ignore (one per line)\n${content}\n`);
      systemLogger.logSystem('INFO', `Created .ignoreDirs file at: ${ignoreFile}`);
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to create .ignoreDirs file: ${error.message}`);
    }
  }

  /**
   * Start file watcher to monitor changes
   */
  async startFileWatcher() {
    try {
      const ignoreList = await this.loadIgnoreList();

      this.watcher = chokidar.watch(this.storagePath, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: true,
        depth: 10, // Limit depth to prevent performance issues
        ignored: ignoreList
      });

      this.watcher
        .on('add', (filePath) => this.handleFileChange('add', filePath))
        .on('change', (filePath) => this.handleFileChange('change', filePath))
        .on('unlink', (filePath) => this.handleFileChange('unlink', filePath))
        .on('addDir', (dirPath) => this.handleDirectoryChange('add', dirPath))
        .on('unlinkDir', (dirPath) => this.handleDirectoryChange('unlink', dirPath))
        .on('error', (error) => {
          if (error.code === 'EACCES') {
            systemLogger.logSystem('WARN', `Skipping path due to permission error: ${error.path}`);
          } else {
            systemLogger.logSystem('ERROR', `File watcher error: ${error.message}`);
          }
        });

      systemLogger.logSystem('INFO', `File watcher started for: ${this.storagePath}`);
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to start file watcher: ${error.message}`);
    }
  }

  /**
   * Add directory to ignore list
   */
  async addToIgnoreList(dirPath) {
    const ignoreFile = path.join(this.storagePath, '.ignoreDirs');
    try {
      const relativeDir = path.relative(this.storagePath, dirPath);
      const content = await fs.readFile(ignoreFile, 'utf8');

      if (!content.includes(relativeDir)) {
        await fs.appendFile(ignoreFile, `\n${relativeDir}\n`);
        systemLogger.logSystem('INFO', `Added ${relativeDir} to ignore list`);
      }
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to add to ignore list: ${error.message}`);
    }
  }

  /**
   * Cache directory contents when user enters a directory.
   * To be called when a user enters a directory in the UI.
   */
  async enterDirectory(dirPath) {
    const absolutePath = path.resolve(dirPath);
    const isRootDir = absolutePath === path.resolve(this.storagePath);

    systemLogger.logSystem('INFO', `User entering directory: ${absolutePath}`);

    try {
      // Root directory is always kept in hot cache
      if (isRootDir) {
        systemLogger.logSystem('INFO', `Returning root directory from hot cache`);
        return this.directoryCache.get(absolutePath) || [];
      }

      // Check if already cached for non-root directories
      const dirKey = `dir:${absolutePath}`;
      const dirData = await this.redisClient.hGetAll(dirKey);

      if (Object.keys(dirData).length > 0 && dirData.cached) {
        systemLogger.logSystem('INFO', `Directory already cached: ${absolutePath}`);
        return JSON.parse(dirData.contents || '[]');
      }

      // Cache the directory contents (non-recursive)
      await this.updateDirectoryCache(absolutePath);

      // Return the cached contents
      return this.directoryCache.get(absolutePath) || [];
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to enter directory: ${error.message}`);
      return [];
    }
  }

  /**
   * Handle file change events
   */
  async handleFileChange(event, filePath) {
    try {
      const relativePath = path.relative(this.storagePath, filePath);
      
      switch (event) {
        case 'add':
        case 'change':
          await this.updateFileHash(filePath);
          break;
        case 'unlink':
          await this.removeFileFromCache(filePath);
          break;
      }

      systemLogger.logSystem('INFO', `File ${event}: ${relativePath}`);
      this.emit('fileChange', { event, path: relativePath, fullPath: filePath });
    } catch (error) {
      systemLogger.logSystem('ERROR', `Error handling file change: ${error.message}`);
    }
  }

  /**
   * Handle directory change events
   */
  async handleDirectoryChange(event, dirPath) {
    try {
      const relativePath = path.relative(this.storagePath, dirPath);
      
      switch (event) {
        case 'add':
          await this.updateDirectoryCache(dirPath);
          break;
        case 'unlink':
          await this.removeDirectoryFromCache(dirPath);
          break;
      }

      systemLogger.logSystem('INFO', `Directory ${event}: ${relativePath}`);
      this.emit('directoryChange', { event, path: relativePath, fullPath: dirPath });
    } catch (error) {
      systemLogger.logSystem('ERROR', `Error handling directory change: ${error.message}`);
    }
  }

  /**
   * Update file hash in cache
   */
  async updateFileHash(filePath) {
    try {
      const stat = await fs.stat(filePath);
      const content = await fs.readFile(filePath);
      const hash = crypto.createHash('md5').update(content).digest('hex');
      
      const fileKey = `file:${filePath}`;
      const fileData = {
        path: filePath,
        hash: hash,
        size: stat.size,
        modified: stat.mtime.getTime(),
        isDirectory: false
      };

      // Convert all values to strings for Redis
      const redisFileData = {};
      for (const [key, value] of Object.entries(fileData)) {
        redisFileData[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
      }
      await this.redisClient.hSet(fileKey, redisFileData);
      this.fileHashes.set(filePath, { hash, modified: stat.mtime.getTime() });
      
      // Update parent directory cache
      const parentDir = path.dirname(filePath);
      await this.updateDirectoryCache(parentDir);
    } catch (error) {
      if (error.code === 'EACCES') {
        // Skip files we can't access
        systemLogger.logSystem('WARN', `Skipping file hash update for ${error.path} due to permission error.`);
        // If it's a directory permission error, add to ignore list
        if (error.path) {
          const containingDir = path.dirname(filePath);
          await this.addToIgnoreList(containingDir);
        }
      } else {
        systemLogger.logSystem('ERROR', `Failed to update file hash: ${error.message}`);
      }
    }
  }

  /**
   * Update directory cache (non-recursive, only direct children)
   */
  async updateDirectoryCache(dirPath, recursive = false) {
    try {
      // Ensure the directory path is absolute before using
      const absoluteDirPath = path.resolve(dirPath);
      const files = await fs.readdir(absoluteDirPath);
      const dirContents = [];

      for (const fileName of files) {
        const fullPath = path.join(absoluteDirPath, fileName);

        try {
          const stat = await fs.stat(fullPath);
          const relativePath = path.relative(this.storagePath, fullPath);

          const fileData = {
            path: fullPath,
            name: fileName,
            size: stat.size || 0,
            modified: stat.mtime.getTime(),
            isDirectory: stat.isDirectory()
          };

          // Only store file hash for files, not directories
          if (!stat.isDirectory()) {
            const content = await fs.readFile(fullPath);
            fileData.hash = crypto.createHash('md5').update(content).digest('hex');

            // Store file in Redis
            const fileKey = `file:${fullPath}`;
            const redisFileData = {};
            for (const [key, value] of Object.entries(fileData)) {
              redisFileData[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
            }
            await this.redisClient.hSet(fileKey, redisFileData);
            this.fileHashes.set(fullPath, { hash: fileData.hash, modified: fileData.modified });
          }

          dirContents.push(fileData);
        } catch (err) {
          if (err.code !== 'EACCES') {
            systemLogger.logSystem('ERROR', `Error processing item in directory: ${fullPath} - ${err.message}`);
          }
        }
      }

      const isRootDir = absoluteDirPath === path.resolve(this.storagePath);
      const dirKey = `dir:${absoluteDirPath}`;
      await this.redisClient.hSet(dirKey, {
        contents: JSON.stringify(dirContents),
        cached: Date.now().toString(),
        isRoot: isRootDir.toString()
      });
      this.directoryCache.set(absoluteDirPath, dirContents);

      const cacheType = isRootDir ? '(hot cache)' : '(regular cache)';
      systemLogger.logSystem('INFO', `Cached directory ${cacheType}: ${absoluteDirPath} (${dirContents.length} items)`);
    } catch (error) {
      if (error.code === 'EACCES') {
        // Skip directories we can't access
        systemLogger.logSystem('WARN', `Skipping directory cache update for ${error.path} due to permission error.`);
      } else {
        systemLogger.logSystem('ERROR', `Failed to update directory cache: ${error.message}`);
      }
    }
  }

  /**
   * Get directory contents from cache
   */
  async getDirectoryContents(dirPath) {
    try {
      // Ensure the directory path is absolute before using
      const absoluteDirPath = path.resolve(dirPath);
      const dirKey = `dir:${absoluteDirPath}`;
      const dirData = await this.redisClient.hGetAll(dirKey);

      if (Object.keys(dirData).length > 0) {
        const contents = JSON.parse(dirData.contents || '[]');
        return contents;
      }

      // If not in cache, scan the directory and cache it
      await this.scanDirectory(absoluteDirPath);
      const cachedContents = this.directoryCache.get(absoluteDirPath);
      return cachedContents || [];
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to get directory contents: ${error.message}`);
      return [];
    }
  }

  /**
   * Remove file from cache
   */
  async removeFileFromCache(filePath) {
    try {
      // Ensure the file path is absolute before using
      const absoluteFilePath = path.resolve(filePath);
      const fileKey = `file:${absoluteFilePath}`;
      await this.redisClient.del(fileKey);
      this.fileHashes.delete(absoluteFilePath);

      // Update parent directory cache
      const parentDir = path.dirname(absoluteFilePath);
      await this.updateDirectoryCache(parentDir);
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to remove file from cache: ${error.message}`);
    }
  }

  /**
   * Remove directory from cache
   */
  async removeDirectoryFromCache(dirPath) {
    try {
      // Ensure the directory path is absolute before using
      const absoluteDirPath = path.resolve(dirPath);
      // Remove all files in the directory recursively
      const dirKey = `dir:${absoluteDirPath}`;
      await this.redisClient.del(dirKey);
      this.directoryCache.delete(absoluteDirPath);

      // Remove individual file entries under this directory
      const fileKeys = await this.redisClient.keys(`file:${absoluteDirPath}/*`);
      if (fileKeys.length > 0) {
        await this.redisClient.del(fileKeys);
      }
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to remove directory from cache: ${error.message}`);
    }
  }

  /**
   * Scan and cache a directory (non-recursive, only direct children)
   */
  async scanDirectory(dirPath) {
    try {
      // Ensure the directory path is absolute before scanning
      const absoluteDirPath = path.resolve(dirPath);
      systemLogger.logSystem('INFO', `Scanning directory (non-recursive): ${absoluteDirPath}`);

      // Simply update the directory cache for this directory only
      await this.updateDirectoryCache(absoluteDirPath);

      systemLogger.logSystem('INFO', `Completed scan for: ${absoluteDirPath}`);
    } catch (error) {
      if (error.code === 'EACCES') {
        systemLogger.logSystem('WARN', `Skipping directory scan for ${dirPath} due to permission error.`);
        await this.addToIgnoreList(dirPath);
      } else {
        systemLogger.logSystem('ERROR', `Failed to scan directory: ${error.message}`);
      }
    }
  }

  /**
   * Refresh the root directory cache
   */
  async refreshCache() {
    try {
      systemLogger.logSystem('INFO', 'Refreshing root directory cache...');

      // Re-cache only the root directory (non-recursive)
      await this.updateDirectoryCache(path.resolve(this.storagePath));

      systemLogger.logSystem('INFO', 'Root directory cache refresh completed');
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to refresh cache: ${error.message}`);
    }
  }

  /**
   * Add or update a path in the cache
   */
  async addOrUpdatePath(fullPath) {
    try {
      // Ensure the path is absolute before using
      const absolutePath = path.resolve(fullPath);
      const stat = await fs.stat(absolutePath);
      
      if (stat.isDirectory()) {
        await this.updateDirectoryCache(absolutePath);
      } else {
        await this.updateFileHash(absolutePath);
      }
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to add/update path: ${error.message}`);
    }
  }

  /**
   * Get cache information
   */
  async getCacheInfo() {
    try {
      const totalFiles = this.fileHashes.size;
      const totalDirectories = this.directoryCache.size;
      
      // Get Redis info
      const dbSize = await this.redisClient.dbSize();
      
      return {
        initialized: this.initialized,
        totalFiles,
        totalDirectories,
        redisDbSize: dbSize,
        isWatching: !!this.watcher
      };
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to get cache info: ${error.message}`);
      return {
        initialized: this.initialized,
        totalFiles: 0,
        totalDirectories: 0,
        redisDbSize: 0,
        isWatching: !!this.watcher,
        error: error.message
      };
    }
  }

  /**
   * Close the cache and disconnect from Redis.
   */
  async close() {
    // Stop all active watchers
    console.log('Closing all active file watchers...');
    for (const path of this.activeWatchers.keys()) {
      await this.leaveDirectory(path);
    }
    
    if (this.redisClient) {
      await this.redisClient.quit();
      this.redisClient = null;
    }
    this.initialized = false;
    systemLogger.logSystem('INFO', 'Redis cache closed');
  }

  /**
   * Clear all cache data except root directory (hot cache)
   */
  async clearCache() {
    if (!this.redisClient || !this.redisClient.isReady) {
      systemLogger.logSystem('ERROR', 'Cannot clear cache: Redis client is not connected.');
      return;
    }

    try {
      systemLogger.logSystem('INFO', 'Clearing file system cache (preserving root directory)...');

      // Save root directory cache
      const rootPath = path.resolve(this.storagePath);
      const rootDirKey = `dir:${rootPath}`;
      const rootCache = await this.redisClient.hGetAll(rootDirKey);

      // Clear all cache
      await this.redisClient.flushDb();

      // Restore root directory cache
      if (Object.keys(rootCache).length > 0) {
        await this.redisClient.hSet(rootDirKey, rootCache);
        systemLogger.logSystem('INFO', 'Root directory cache preserved');
      }

      // Clear memory cache except root
      const rootMemoryCache = this.directoryCache.get(rootPath);
      this.directoryCache.clear();
      this.fileHashes.clear();

      if (rootMemoryCache) {
        this.directoryCache.set(rootPath, rootMemoryCache);
      }

      systemLogger.logSystem('INFO', 'Cache cleared successfully (root directory preserved).');
      this.emit('clear');
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to clear cache: ${error.message}`);
    }
  }

  /**
   * Get files in a directory from cache
   */
  async getFilesInDirectory(dirPath) {
    try {
      // Ensure the directory path is absolute before using
      const absoluteDirPath = path.resolve(dirPath);
      const dirKey = `dir:${absoluteDirPath}`;
      const dirData = await this.redisClient.hGetAll(dirKey);

      if (Object.keys(dirData).length > 0) {
        const contents = JSON.parse(dirData.contents || '[]');
        return contents;
      }

      // If not in cache, scan the directory and cache it
      await this.scanDirectory(absoluteDirPath);
      const cachedContents = this.directoryCache.get(absoluteDirPath);
      return cachedContents || [];
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to get files in directory: ${error.message}`);
      return [];
    }
  }

  /**
   * Search files by spawning the system's native `find` command.
   * This is a robust, performant solution that correctly ignores specified
   * directories and handles large filesystems efficiently.
   */
  async searchFiles(query) {
    try {
      const { spawn } = require('child_process');
      const storageRoot = path.resolve(this.storagePath);

      const findArgs = [
        storageRoot, // The search MUST start from the configured storage root.
      ];

      // Define directories to exclude within the storageRoot.
      const excludeDirs = ['node_modules', '.git', '.cache', '.vscode', '.idea'];
      const pathExclusionArgs = [];

      // Create full, absolute paths for exclusion, based on the storageRoot.
      excludeDirs.forEach(dir => {
        pathExclusionArgs.push('-path', path.join(storageRoot, dir));
      });

      // Construct the `( -path ... -o -path ... ) -prune` part of the command.
      if (pathExclusionArgs.length > 0) {
          findArgs.push('(');
          pathExclusionArgs.forEach((arg, i) => {
              findArgs.push(arg);
              // Add -o (OR) between each `-path ...` pair
              if (i < pathExclusionArgs.length - 1 && i % 2 === 1) {
                  findArgs.push('-o');
              }
          });
          findArgs.push(')', '-prune', '-o');
      }

      // Add the case-insensitive name search and the print action.
      findArgs.push('-iname', `*${query}*`, '-print');

      const findProcess = spawn('find', findArgs);

      let output = '';
      let errorOutput = '';

      findProcess.stdout.on('data', (data) => {
        output += data.toString();
      });

      findProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      return new Promise((resolve, reject) => {
        findProcess.on('close', async (code) => {
          if (code !== 0 && errorOutput) {
            console.warn(`'find' process stderr (exit code ${code}): ${errorOutput}`);
          }

          if (!output.trim()) {
            return resolve({ files: [] });
          }

          const paths = output.trim().split('\n');

          const statPromises = paths.map(async (p) => {
            if (!p) return null;
            try {
              const stats = await fs.stat(p);
              const relativePath = path.relative(storageRoot, p);
              return {
                path: relativePath,
                name: path.basename(p),
                isDirectory: stats.isDirectory(),
                size: stats.size,
                modified: stats.mtime.getTime(),
              };
            } catch (e) {
              return null;
            }
          });

          const files = (await Promise.all(statPromises)).filter(Boolean);
          resolve({ files });
        });

        findProcess.on('error', (err) => {
          console.error('Failed to spawn find process.', err);
          reject(new Error('Failed to execute search command.'));
        });
      });
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to search files: ${error.message}`);
      return { files: [] };
    }
  }
}

module.exports = RedisFileSystemCache;