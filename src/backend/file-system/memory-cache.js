const EventEmitter = require('events');
const { createClient } = require('redis');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const chokidar = require('chokidar');

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
      console.log('Initializing Redis file system cache...');
      
      // Connect to Redis
      this.redisClient = createClient(this.redisOptions);
      
      this.redisClient.on('error', (err) => {
        console.error('Redis Client Error:', err);
      });
      
      this.redisClient.on('connect', () => {
        console.log('Connected to Redis');
      });
      
      await this.redisClient.connect();
      
      // Perform an initial shallow scan of the root storage path
      console.log(`Performing initial scan of root: ${this.storagePath}`);
      await this.updateDirectoryCache(this.storagePath);
      
      this.initialized = true;
      console.log('Redis file system cache initialized successfully');
      
      return true;
    } catch (error) {
      console.error('Failed to initialize Redis cache:', error);
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
      
      console.log(`Loaded ${this.fileHashes.size} file hashes from Redis`);
    } catch (error) {
      console.error('Failed to load file hashes:', error);
    }
  }

  /**
   * Scans a directory and starts watching it for changes.
   * To be called when a user enters a directory in the UI.
   */
  async enterDirectory(dirPath) {
    const absolutePath = path.resolve(dirPath);
    console.log(`Entering and watching directory: ${absolutePath}`);
    
    // First, ensure the directory contents are cached
    await this.updateDirectoryCache(absolutePath);

    // Then, start watching if not already watched
    if (this.activeWatchers.has(absolutePath)) {
      console.log(`Already watching ${absolutePath}`);
      return;
    }

    try {
      const watcher = chokidar.watch(absolutePath, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: true,
        depth: 0, // IMPORTANT: Watch only the current directory, not recursively
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.Trash-1000/**',
          '**/vm/**',
          '**/.nfs*',
        ]
      });

      watcher
        .on('add', (filePath) => this.handleFileChange('add', filePath))
        .on('change', (filePath) => this.handleFileChange('change', filePath))
        .on('unlink', (filePath) => this.handleFileChange('unlink', filePath))
        .on('addDir', (dirPath) => this.handleDirectoryChange('add', dirPath))
        .on('unlinkDir', (dirPath) => this.handleDirectoryChange('unlink', dirPath))
        .on('error', (error) => {
          if (error.code === 'EACCES') {
            console.warn(`Skipping path due to permission error: ${error.path}`);
          } else {
            console.error(`Watcher error in ${absolutePath}:`, error);
          }
        });
      
      this.activeWatchers.set(absolutePath, watcher);
      console.log(`Successfully started watcher for: ${absolutePath}`);
    } catch (error) {
      console.error(`Failed to start watcher for ${absolutePath}:`, error);
    }
  }

  /**
   * Stops watching a directory for changes.
   * To be called when a user leaves a directory in the UI.
   */
  async leaveDirectory(dirPath) {
    const absolutePath = path.resolve(dirPath);
    const watcher = this.activeWatchers.get(absolutePath);

    if (watcher) {
      console.log(`Stopping watcher for: ${absolutePath}`);
      await watcher.close();
      this.activeWatchers.delete(absolutePath);
      console.log(`Successfully stopped watcher for: ${absolutePath}`);
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

      console.log(`File ${event}:`, relativePath);
      this.emit('fileChange', { event, path: relativePath, fullPath: filePath });
    } catch (error) {
      console.error('Error handling file change:', error);
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

      console.log(`Directory ${event}:`, relativePath);
      this.emit('directoryChange', { event, path: relativePath, fullPath: dirPath });
    } catch (error) {
      console.error('Error handling directory change:', error);
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
        console.warn(`Skipping file hash update for ${error.path} due to permission error.`);
      } else {
        console.error('Failed to update file hash:', error);
      }
    }
  }

  /**
   * Update directory cache
   */
  async updateDirectoryCache(dirPath) {
    try {
      // Ensure the directory path is absolute before using
      const absoluteDirPath = path.resolve(dirPath);
      const files = await fs.readdir(absoluteDirPath);
      const dirContents = [];

      for (const fileName of files) {
        const fullPath = path.join(absoluteDirPath, fileName);
        const fileKey = `file:${fullPath}`;
        const fileData = await this.redisClient.hGetAll(fileKey);

        if (Object.keys(fileData).length > 0) {
          dirContents.push(fileData);
        } else {
          // Create entry for file not yet in cache
          try {
            const stat = await fs.stat(fullPath);
            const relativePath = path.relative(this.storagePath, fullPath);
            const hash = stat.isDirectory() ? 'directory' : crypto.createHash('md5').update(relativePath).digest('hex');
            
            const newFileData = {
              path: fullPath,
              hash: hash,
              size: stat.size || 0,
              modified: stat.mtime.getTime(),
              isDirectory: stat.isDirectory()
            };

            // Convert all values to strings for Redis
            const redisNewFileData = {};
            for (const [key, value] of Object.entries(newFileData)) {
              redisNewFileData[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
            }
            await this.redisClient.hSet(fileKey, redisNewFileData);
            dirContents.push(newFileData);
          } catch (err) {
            console.error('Error processing file in directory:', fullPath, err);
          }
        }
      }

      const dirKey = `dir:${absoluteDirPath}`;
      await this.redisClient.hSet(dirKey, { 
        contents: typeof dirContents === 'object' ? JSON.stringify(dirContents) : String(dirContents) 
      });
      this.directoryCache.set(absoluteDirPath, dirContents);
    } catch (error) {
      if (error.code === 'EACCES') {
        // Skip directories we can't access
        console.warn(`Skipping directory cache update for ${error.path} due to permission error.`);
      } else {
        console.error('Failed to update directory cache:', error);
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
      console.error('Failed to get directory contents:', error);
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
      console.error('Failed to remove file from cache:', error);
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
      console.error('Failed to remove directory from cache:', error);
    }
  }

  /**
   * Scan and cache a directory
   */
  async scanDirectory(dirPath) {
    try {
      // Ensure the directory path is absolute before scanning
      const absoluteDirPath = path.resolve(dirPath);
      console.log('Scanning directory:', absoluteDirPath);
      
      // Add to scan queue to prevent concurrent scans
      this.scanQueue.push(absoluteDirPath);
      if (this.isScanning) {
        return; // Already scanning, this will be processed in the queue
      }
      
      this.isScanning = true;
      
      while (this.scanQueue.length > 0) {
        const currentDir = this.scanQueue.shift();
        
        try {
          const items = await fs.readdir(currentDir, { withFileTypes: true });
          const scanPromises = [];
          
          for (const item of items) {
            const fullPath = path.join(currentDir, item.name);
            
            if (item.isDirectory()) {
              // Add subdirectory to scan queue
              this.scanQueue.push(fullPath);
              // For directories, update directory cache instead of file hash
              scanPromises.push(this.updateDirectoryCache(fullPath));
            } else {
              scanPromises.push(this.updateFileHash(fullPath));
            }
          }
          
          await Promise.all(scanPromises);
          await this.updateDirectoryCache(currentDir);
          
          console.log('Completed scan for:', currentDir);
        } catch (error) {
          if (error.code === 'EACCES') {
            console.warn(`Skipping directory scan for ${currentDir} due to permission error.`);
          } else {
            console.error('Error scanning directory:', currentDir, error);
          }
        }
      }
      
      this.isScanning = false;
    } catch (error) {
      console.error('Failed to scan directory:', error);
    }
  }

  /**
   * Refresh the entire cache
   */
  async refreshCache() {
    try {
      console.log('Refreshing entire file system cache...');
      
      // Clear existing cache
      await this.clearCache();
      
      // Re-scan root directory, ensuring it's absolute
      await this.scanDirectory(path.resolve(this.storagePath));
      
      console.log('Cache refresh completed');
    } catch (error) {
      console.error('Failed to refresh cache:', error);
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
      console.error('Failed to add/update path:', error);
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
      console.error('Failed to get cache info:', error);
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
    console.log('Redis cache closed');
  }

  /**
   * Clear all cache data
   */
  async clearCache() {
    if (!this.redisClient || !this.redisClient.isReady) {
      console.error('Cannot clear cache: Redis client is not connected.');
      return;
    }
    console.log('Clearing file system cache...');
    await this.redisClient.flushDb();
    console.log('Cache cleared successfully.');
    this.emit('clear');
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
      console.error('Failed to get files in directory:', error);
      return [];
    }
  }

  /**
   * Search files by performing a live, recursive walk of the filesystem.
   * This is used instead of the cache to ensure complete results, as the cache
   * is no longer guaranteed to be complete due to the on-demand watching strategy.
   */
  async searchFiles(query) {
    const results = [];
    const storageRoot = path.resolve(this.storagePath);
    const lowerCaseQuery = query.toLowerCase();

    // Helper to build file data to match frontend expectations
    const buildFileData = (itemPath, stats) => {
      const relativePath = path.relative(storageRoot, itemPath);
      return {
        path: relativePath,
        name: path.basename(itemPath),
        isDirectory: stats.isDirectory(),
        size: stats.size,
        modified: stats.mtime.getTime(),
      };
    };

    const walk = async (directory) => {
      let items;
      try {
        items = await fs.readdir(directory, { withFileTypes: true });
      } catch (err) {
        // Ignore directories we can't read (e.g., permission errors)
        console.warn(`Could not read directory ${directory}: ${err.message}`);
        return;
      }

      for (const item of items) {
        const fullPath = path.join(directory, item.name);
        
        // Check if the item name contains the query
        if (item.name.toLowerCase().includes(lowerCaseQuery)) {
          try {
            const stats = await fs.stat(fullPath);
            results.push(buildFileData(fullPath, stats));
          } catch (statErr) {
            console.warn(`Could not stat file ${fullPath}: ${statErr.message}`);
            continue; // Skip file if we can't get its stats
          }
        }

        // If it's a directory, recurse into it
        if (item.isDirectory()) {
          await walk(fullPath);
        }
      }
    };

    try {
      await walk(storageRoot);
      // The search result format for the frontend is { files: [...] }
      return { files: results };
    } catch (error) {
      console.error('Failed to search files during filesystem walk:', error);
      return { files: [] };
    }
  }
}

module.exports = RedisFileSystemCache;