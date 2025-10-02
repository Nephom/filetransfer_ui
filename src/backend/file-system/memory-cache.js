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

    // Global index for search
    this.isIndexing = false;
    this.indexProgress = { current: 0, total: 0, status: 'idle' };
    this.indexingInterval = null;
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

      // Start periodic global indexing for search functionality
      // This runs in background and doesn't block initialization
      systemLogger.logSystem('INFO', 'Starting global indexing for search...');
      this.startPeriodicIndexing(6); // Re-index every 6 hours

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
   * Get cache statistics (alias for getCacheInfo)
   */
  async getStats() {
    return await this.getCacheInfo();
  }

  /**
   * Close the cache and disconnect from Redis.
   */
  async close() {
    systemLogger.logSystem('INFO', 'Closing Redis cache...');

    // Stop root polling
    this.stopRootPolling();

    // Stop periodic indexing
    this.stopPeriodicIndexing();

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
   * Search files using Redis global index (fast, cache-based)
   * Returns files currently in cache, or indicates if indexing is in progress
   */
  async searchFiles(query) {
    try {
      const storageRoot = path.resolve(this.storagePath);
      const normalizedQuery = query.toLowerCase();

      // Check if indexing is in progress
      if (this.isIndexing) {
        return {
          files: [],
          indexing: true,
          progress: this.indexProgress,
          message: `Index is building: ${this.indexProgress.current}/${this.indexProgress.total} files processed`
        };
      }

      // Search in Redis index using SCAN to find matching keys
      const matchingFiles = [];
      const searchPattern = `index:*${normalizedQuery}*`;

      // Use SCAN to iterate through keys matching the pattern
      for await (const key of this.redisClient.scanIterator({ MATCH: searchPattern, COUNT: 100 })) {
        try {
          const fileData = await this.redisClient.get(key);
          if (fileData) {
            const file = JSON.parse(fileData);
            matchingFiles.push(file);

            // Limit results to prevent memory issues
            if (matchingFiles.length >= 1000) {
              systemLogger.logSystem('WARN', `Search results limited to 1000 for query: ${query}`);
              break;
            }
          }
        } catch (e) {
          // Skip corrupted entries
          continue;
        }
      }

      // Check index status
      const indexStatus = await this.redisClient.get('index:status');
      const indexStats = indexStatus ? JSON.parse(indexStatus) : null;

      systemLogger.logSystem('INFO', `Search completed for "${query}": ${matchingFiles.length} results from index`);

      return {
        files: matchingFiles,
        indexing: false,
        indexStats: indexStats,
        resultCount: matchingFiles.length
      };
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to search files: ${error.message}`);
      return {
        files: [],
        error: error.message,
        indexing: this.isIndexing
      };
    }
  }

  /**
   * Build global file index by recursively scanning storagePath
   * Runs in background and updates Redis with all file paths
   */
  async buildGlobalIndex() {
    if (this.isIndexing) {
      systemLogger.logSystem('WARN', 'Index building already in progress');
      return;
    }

    this.isIndexing = true;
    this.indexProgress = { current: 0, total: 0, status: 'counting' };

    try {
      systemLogger.logSystem('INFO', 'Starting global index build...');
      const ignoreList = await this.loadIgnoreList();
      const storageRoot = path.resolve(this.storagePath);

      // Clear old index entries
      systemLogger.logSystem('INFO', 'Clearing old index entries...');
      const oldKeys = [];
      for await (const key of this.redisClient.scanIterator({ MATCH: 'index:*', COUNT: 1000 })) {
        oldKeys.push(key);
        if (oldKeys.length >= 10000) {
          await this.redisClient.del(oldKeys);
          oldKeys.length = 0;
        }
      }
      if (oldKeys.length > 0) {
        await this.redisClient.del(oldKeys);
      }

      // Recursively scan and index all files
      const startTime = Date.now();
      await this.indexDirectory(storageRoot, ignoreList);
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      // Save index status
      const indexStatus = {
        lastUpdated: Date.now(),
        totalFiles: this.indexProgress.current,
        duration: duration,
        status: 'completed'
      };
      await this.redisClient.set('index:status', JSON.stringify(indexStatus));

      this.indexProgress.status = 'completed';
      systemLogger.logSystem('INFO', `Global index build completed: ${this.indexProgress.current} files indexed in ${duration}s`);
    } catch (error) {
      this.indexProgress.status = 'error';
      systemLogger.logSystem('ERROR', `Failed to build global index: ${error.message}`);
    } finally {
      this.isIndexing = false;
    }
  }

  /**
   * Recursively index a directory and its contents
   */
  async indexDirectory(dirPath, ignoreList) {
    try {
      const items = await fs.readdir(dirPath);

      for (const itemName of items) {
        // Skip ignored directories
        if (ignoreList.includes(itemName)) {
          continue;
        }

        const fullPath = path.join(dirPath, itemName);

        try {
          const stat = await fs.stat(fullPath);
          const relativePath = path.relative(this.storagePath, fullPath);

          // Index this file/directory
          const fileData = {
            path: relativePath,
            name: itemName,
            size: stat.size || 0,
            modified: stat.mtime.getTime(),
            isDirectory: stat.isDirectory()
          };

          // Store in Redis with lowercase name as part of key for case-insensitive search
          const indexKey = `index:${itemName.toLowerCase()}:${relativePath}`;
          await this.redisClient.set(indexKey, JSON.stringify(fileData), { EX: 86400 * 7 }); // 7 day TTL

          this.indexProgress.current++;

          // Log progress every 10000 files
          if (this.indexProgress.current % 10000 === 0) {
            systemLogger.logSystem('INFO', `Indexing progress: ${this.indexProgress.current} files processed`);
          }

          // If it's a directory, recursively index it
          if (stat.isDirectory()) {
            await this.indexDirectory(fullPath, ignoreList);
          }
        } catch (err) {
          if (err.code === 'EACCES') {
            // Skip permission denied
            continue;
          } else if (err.code === 'ENOENT') {
            // Skip if file was deleted during indexing
            continue;
          } else {
            systemLogger.logSystem('WARN', `Error indexing ${fullPath}: ${err.message}`);
          }
        }
      }
    } catch (error) {
      if (error.code === 'EACCES') {
        // Skip directories we can't access
        return;
      }
      throw error;
    }
  }

  /**
   * Start periodic re-indexing in background
   * Re-indexes every 6 hours by default
   */
  startPeriodicIndexing(intervalHours = 6) {
    if (this.indexingInterval) {
      systemLogger.logSystem('WARN', 'Periodic indexing already started');
      return;
    }

    const intervalMs = intervalHours * 60 * 60 * 1000;

    // Build index immediately
    this.buildGlobalIndex();

    // Schedule periodic rebuilds
    this.indexingInterval = setInterval(() => {
      systemLogger.logSystem('INFO', 'Starting periodic index rebuild...');
      this.buildGlobalIndex();
    }, intervalMs);

    systemLogger.logSystem('INFO', `Periodic indexing started (every ${intervalHours} hours)`);
  }

  /**
   * Stop periodic indexing
   */
  stopPeriodicIndexing() {
    if (this.indexingInterval) {
      clearInterval(this.indexingInterval);
      this.indexingInterval = null;
      systemLogger.logSystem('INFO', 'Periodic indexing stopped');
    }
  }

  /**
   * Get indexing status and statistics
   */
  async getIndexStatus() {
    try {
      const indexStatus = await this.redisClient.get('index:status');
      const status = indexStatus ? JSON.parse(indexStatus) : null;

      return {
        isIndexing: this.isIndexing,
        progress: this.indexProgress,
        lastIndex: status,
        periodicIndexing: !!this.indexingInterval
      };
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to get index status: ${error.message}`);
      return {
        isIndexing: this.isIndexing,
        progress: this.indexProgress,
        error: error.message
      };
    }
  }
}

module.exports = RedisFileSystemCache;