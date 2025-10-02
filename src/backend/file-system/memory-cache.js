const EventEmitter = require('events');
const { createClient } = require('redis');
const path = require('path');
const fs = require('fs').promises;
const { systemLogger } = require('../utils/logger');

/**
 * Redis-based file system cache with polling-based monitoring
 * Optimized for large file systems (640K+ files)
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
    this.initialized = false;
    this.directoryCache = new Map();
    this.directoryMtimes = new Map(); // Track directory modification times
    this.activeDirs = new Set(); // Track directories user has entered
    this.rootPollingInterval = null;
    this.rootPollFrequency = 3000; // Poll root directory every 3 seconds
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

      // Cache only the root directory (non-recursive)
      await this.updateDirectoryCache(this.storagePath);

      // Start polling root directory for changes
      this.startRootPolling();

      this.initialized = true;
      systemLogger.logSystem('INFO', 'Redis file system cache initialized successfully (polling mode)');

      return true;
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to initialize Redis cache: ${error.message}`);
      return false;
    }
  }

  /**
   * Start polling root directory for changes
   */
  startRootPolling() {
    this.rootPollingInterval = setInterval(async () => {
      try {
        const rootStat = await fs.stat(this.storagePath);
        const cachedMtime = this.directoryMtimes.get(this.storagePath);

        if (!cachedMtime || rootStat.mtime.getTime() > cachedMtime) {
          systemLogger.logSystem('INFO', 'Root directory changed, refreshing cache...');
          await this.updateDirectoryCache(this.storagePath);
          this.directoryMtimes.set(this.storagePath, rootStat.mtime.getTime());
          this.emit('rootChange', { path: this.storagePath });
        }
      } catch (error) {
        systemLogger.logSystem('ERROR', `Root polling error: ${error.message}`);
      }
    }, this.rootPollFrequency);

    systemLogger.logSystem('INFO', `Started polling root directory every ${this.rootPollFrequency}ms`);
  }

  /**
   * Stop polling root directory
   */
  stopRootPolling() {
    if (this.rootPollingInterval) {
      clearInterval(this.rootPollingInterval);
      this.rootPollingInterval = null;
      systemLogger.logSystem('INFO', 'Stopped root directory polling');
    }
  }

  /**
   * Load ignore list from .ignoreDirs file (in project root)
   */
  async loadIgnoreList() {
    // Store .ignoreDirs in project root, same location as server.log and logs/
    const ignoreFile = path.join(__dirname, '../../../.ignoreDirs');
    const defaultIgnoreList = [
      'node_modules',
      '.git',
      '.Trash-1000',
      'vm',
      '.nfs'
    ];

    try {
      const content = await fs.readFile(ignoreFile, 'utf8');
      const customIgnores = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));

      return [...defaultIgnoreList, ...customIgnores];
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Create .ignoreDirs file with default ignores
        await this.createIgnoreFile(ignoreFile, defaultIgnoreList);
      }
      return defaultIgnoreList;
    }
  }

  /**
   * Create .ignoreDirs file with default ignores (in project root)
   */
  async createIgnoreFile(ignoreFile, defaultIgnoreList) {
    try {
      const content = defaultIgnoreList.join('\n');
      await fs.writeFile(ignoreFile, `# Ignore file for file system cache\n# Add directories to ignore (one per line)\n# This file is in the project root, same as server.log\n${content}\n`);
      systemLogger.logSystem('INFO', `Created .ignoreDirs file at: ${ignoreFile}`);
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to create .ignoreDirs file: ${error.message}`);
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
      // Check if directory mtime has changed
      const stat = await fs.stat(absolutePath);
      const cachedMtime = this.directoryMtimes.get(absolutePath);

      // Update cache if directory changed or not cached
      if (!cachedMtime || stat.mtime.getTime() > cachedMtime) {
        systemLogger.logSystem('INFO', `Caching directory (mtime changed): ${absolutePath}`);
        await this.updateDirectoryCache(absolutePath);
        this.directoryMtimes.set(absolutePath, stat.mtime.getTime());
      } else {
        systemLogger.logSystem('INFO', `Returning cached directory: ${absolutePath}`);
      }

      // Mark as active directory
      this.activeDirs.add(absolutePath);

      // Return the cached contents
      return this.directoryCache.get(absolutePath) || [];
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to enter directory: ${error.message}`);
      return [];
    }
  }

  /**
   * Clean up cache when user leaves a directory.
   * To be called when a user leaves a directory in the UI.
   */
  async leaveDirectory(dirPath) {
    const absolutePath = path.resolve(dirPath);
    const isRootDir = absolutePath === path.resolve(this.storagePath);

    // Never clear root directory
    if (isRootDir) {
      return;
    }

    systemLogger.logSystem('INFO', `User leaving directory: ${absolutePath}`);

    try {
      // Remove from active directories
      this.activeDirs.delete(absolutePath);

      // Clear from memory cache
      this.directoryCache.delete(absolutePath);
      this.directoryMtimes.delete(absolutePath);

      // Clear from Redis
      const dirKey = `dir:${absolutePath}`;
      await this.redisClient.del(dirKey);

      // Clear all file entries under this directory from Redis
      const pattern = `file:${absolutePath}/*`;
      const keys = [];

      // Use SCAN instead of KEYS for production safety
      for await (const key of this.redisClient.scanIterator({ MATCH: pattern })) {
        keys.push(key);
      }

      if (keys.length > 0) {
        await this.redisClient.del(keys);
      }

      systemLogger.logSystem('INFO', `Cleared cache for: ${absolutePath} (${keys.length} files removed)`);
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to leave directory: ${error.message}`);
    }
  }


  /**
   * Update directory cache (non-recursive, only direct children)
   * Uses mtime+size instead of MD5 for change detection
   */
  async updateDirectoryCache(dirPath, recursive = false) {
    try {
      // Ensure the directory path is absolute before using
      const absoluteDirPath = path.resolve(dirPath);
      const ignoreList = await this.loadIgnoreList();
      const files = await fs.readdir(absoluteDirPath);
      const dirContents = [];

      for (const fileName of files) {
        // Skip ignored directories
        if (ignoreList.includes(fileName)) {
          continue;
        }

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

          // For files, use size+mtime as pseudo-hash (no need to read file content)
          if (!stat.isDirectory()) {
            fileData.hash = `${stat.size}-${stat.mtime.getTime()}`;
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
   * Refresh the root directory cache
   */
  async refreshCache() {
    try {
      systemLogger.logSystem('INFO', 'Refreshing root directory cache...');

      // Re-cache only the root directory (non-recursive)
      const rootStat = await fs.stat(this.storagePath);
      await this.updateDirectoryCache(this.storagePath);
      this.directoryMtimes.set(this.storagePath, rootStat.mtime.getTime());

      systemLogger.logSystem('INFO', 'Root directory cache refresh completed');
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to refresh cache: ${error.message}`);
    }
  }

  /**
   * Get cache information
   */
  async getCacheInfo() {
    try {
      const totalDirectories = this.directoryCache.size;
      const activeDirectories = this.activeDirs.size;

      // Get Redis info
      const dbSize = await this.redisClient.dbSize();

      return {
        initialized: this.initialized,
        totalDirectories,
        activeDirectories,
        redisDbSize: dbSize,
        isPolling: !!this.rootPollingInterval,
        pollFrequency: this.rootPollFrequency
      };
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to get cache info: ${error.message}`);
      return {
        initialized: this.initialized,
        totalDirectories: 0,
        activeDirectories: 0,
        redisDbSize: 0,
        isPolling: !!this.rootPollingInterval,
        error: error.message
      };
    }
  }

  /**
   * Close the cache and disconnect from Redis.
   */
  async close() {
    systemLogger.logSystem('INFO', 'Closing Redis cache...');

    // Stop root polling
    this.stopRootPolling();

    // Clear all active directories
    for (const dirPath of this.activeDirs) {
      await this.leaveDirectory(dirPath);
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
      const rootMtime = this.directoryMtimes.get(rootPath);

      this.directoryCache.clear();
      this.directoryMtimes.clear();
      this.activeDirs.clear();

      if (rootMemoryCache) {
        this.directoryCache.set(rootPath, rootMemoryCache);
      }
      if (rootMtime) {
        this.directoryMtimes.set(rootPath, rootMtime);
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
      // Use enterDirectory to ensure proper caching
      return await this.enterDirectory(dirPath);
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

      // Load ignore list from .ignoreDirs file
      const excludeDirs = await this.loadIgnoreList();
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
            systemLogger.logSystem('WARN', `'find' process stderr (exit code ${code}): ${errorOutput}`);
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
          systemLogger.logSystem('ERROR', 'Failed to spawn find process: ' + err.message);
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