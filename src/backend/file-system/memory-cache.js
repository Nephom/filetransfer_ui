/**
 * Redis-based File System Cache with Real-time Watching
 * This implementation uses Redis to store file system metadata, allowing for greater scalability.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { createClient } = require('redis');
const { EventEmitter } = require('events');
const config = require('../config/config');

// Helper to create a Redis key for a directory
const dirKey = (relativePath) => `dir:${relativePath}`;

class RedisFileSystemCache extends EventEmitter {
  constructor(storagePath) {
    super();
    this.storagePath = path.resolve(storagePath);
    this.redisClient = null;
    this.watcher = null;
    this.initialized = false;
  }

  /**
   * Initialize the Redis client, connect, and start watching
   */
  async initialize() {
    if (this.initialized) return;

    console.log('Initializing Redis file system cache...');

    // 1. Connect to Redis
    try {
      const redisUrl = config.get('redisUrl');
      this.redisClient = createClient({ url: redisUrl });
      this.redisClient.on('error', (err) => console.error('Redis Client Error', err));
      await this.redisClient.connect();
      console.log('Connected to Redis successfully.');
    } catch (error) {
      console.error('Failed to connect to Redis:', error);
      // If Redis connection fails, we cannot proceed.
      throw new Error('Redis connection failed. Cache cannot be initialized.');
    }

    // 2. Initial scan and cache population
    console.log('Starting initial file system scan...');
    await this.redisClient.flushDb(); // Clear old cache before starting
    await this.scanDirectory(this.storagePath);

    // 3. Start watching for changes
    // this.startWatching();

    this.initialized = true;
    const keys = await this.redisClient.keys('*');
    console.log(`Cache initialized with ${keys.length} directory keys in Redis.`);
  }

  /**
   * Start watching the file system for changes
   */
  startWatching() {
    if (this.watcher) {
      this.watcher.close();
    }

    this.watcher = chokidar.watch(this.storagePath, {
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/*.log',
        '**/temp/**',
        '**/dist/**',
        /(^|[\/\\])\../, // Ignore dotfiles and dot-directories
      ],
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100
      }
    });

    this.watcher
      .on('add', (filePath) => this.updateFileInCache(filePath))
      .on('change', (filePath) => this.updateFileInCache(filePath))
      .on('unlink', (filePath) => this.removeFileFromCache(filePath))
      .on('addDir', (dirPath) => this.updateFileInCache(dirPath))
      .on('unlinkDir', (dirPath) => this.removeDirectoryFromCache(dirPath))
      .on('error', (error) => console.error('Watcher error:', error));

    console.log('File system watcher started');
  }

  /**
   * Scan directory recursively and build cache in Redis
   */
  async scanDirectory(dirPath) {
    try {
      const items = await fs.readdir(dirPath);
      const relativePath = path.relative(this.storagePath, dirPath) || '.';

      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        try {
          const stats = await fs.lstat(itemPath);

          // Skip symbolic links to avoid loops and other issues
          if (stats.isSymbolicLink()) {
              continue;
          }

          // Skip if not a file or directory (e.g., sockets, block devices)
          if (!stats.isFile() && !stats.isDirectory()) {
              console.warn(`Skipping ${itemPath}: Not a file or directory.`);
              continue;
          }

          // Check for read access before proceeding
          await fs.access(itemPath, fsSync.constants.R_OK);

          const fileInfo = {
            name: item,
            isDirectory: stats.isDirectory(),
            size: stats.size,
            modified: stats.mtime.toISOString(),
            created: stats.birthtime.toISOString(),
          };

          // Add to Redis Hash for the parent directory
          await this.redisClient.hSet(dirKey(relativePath), item, JSON.stringify(fileInfo));

          if (stats.isDirectory()) {
            await this.scanDirectory(itemPath);
          }
        } catch (statError) {
            if (statError.code !== 'EACCES') { // EACCES is expected for read-only, so we don't log it as a warning
                console.warn(`Skipping ${itemPath}:`, statError.message);
            }
        }
      }
    } catch (error) {
      console.error(`Error scanning directory ${dirPath}:`, error.message);
    }
  }

  /**
   * Add or update a file/directory in the Redis cache
   */
  async updateFileInCache(filePath) {
    try {
      const relativePath = path.relative(this.storagePath, filePath);
      const parentDir = path.dirname(relativePath);
      const itemName = path.basename(filePath);

      const lstat = await fs.lstat(filePath);
      if (lstat.isSymbolicLink()) return;

      const stats = await fs.stat(filePath);
      await fs.access(filePath, fsSync.constants.R_OK);

      const fileInfo = {
        name: itemName,
        isDirectory: stats.isDirectory(),
        size: stats.size,
        modified: stats.mtime.toISOString(),
        created: stats.birthtime.toISOString(),
      };

      await this.redisClient.hSet(dirKey(parentDir), itemName, JSON.stringify(fileInfo));
      this.emit('change', { operation: 'change', path: relativePath });
    } catch (error) {
      // If file is gone before we can stat it, it will be handled by the remove event
      if (error.code !== 'ENOENT') {
        console.warn(`Error updating file in cache ${filePath}:`, error.message);
      }
    }
  }

  /**
   * Remove a file from the Redis cache
   */
  async removeFileFromCache(filePath) {
    const relativePath = path.relative(this.storagePath, filePath);
    const parentDir = path.dirname(relativePath);
    const itemName = path.basename(filePath);

    await this.redisClient.hDel(dirKey(parentDir), itemName);
    this.emit('change', { operation: 'remove', path: relativePath });
  }

  /**
   * Remove a directory and all its contents from the Redis cache
   */
  async removeDirectoryFromCache(dirPath) {
    const relativePath = path.relative(this.storagePath, dirPath);
    const parentDir = path.dirname(relativePath);
    const itemName = path.basename(dirPath);

    // Delete the key for the directory itself
    await this.redisClient.del(dirKey(relativePath));
    // Delete the entry from its parent
    await this.redisClient.hDel(dirKey(parentDir), itemName);
    
    this.emit('change', { operation: 'removeDir', path: relativePath });
  }

  /**
   * Search files by name across the entire cache
   * PERFORMANCE FIX: Use SCAN instead of KEYS for better scalability
   */
  async searchFiles(query, options = {}) {
    if (!this.initialized) await this.initialize();
    const results = [];
    const lowerQuery = query.toLowerCase();
    const maxResults = options.limit || 1000; // Prevent memory overflow
    let totalProcessed = 0;
    
    // Use SCAN instead of KEYS to avoid blocking Redis
    let cursor = 0;
    do {
      const reply = await this.redisClient.scan(cursor, {
        MATCH: 'dir:*',
        COUNT: 100 // Process in chunks
      });
      cursor = reply.cursor;
      
      for (const key of reply.keys) {
        if (results.length >= maxResults) break;
        
        const items = await this.redisClient.hGetAll(key);
        for (const itemName in items) {
          if (results.length >= maxResults) break;
          
          if (itemName.toLowerCase().includes(lowerQuery)) {
            const fileInfo = JSON.parse(items[itemName]);
            const relativePath = key.substring(4); // remove 'dir:'
            results.push({
              name: fileInfo.name,
              path: path.join(relativePath, fileInfo.name),
              isDirectory: fileInfo.isDirectory,
              size: fileInfo.size,
              modified: fileInfo.modified,
            });
          }
        }
        totalProcessed++;
      }
    } while (cursor !== 0 && results.length < maxResults);
    
    console.log(`Search processed ${totalProcessed} directories, found ${results.length} results`);
    
    results.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return b.isDirectory - a.isDirectory;
      return a.name.localeCompare(b.name);
    });
    
    return results.slice(0, maxResults);
  }

  /**
   * Get files in a specific directory
   */
  async getFilesInDirectory(dirPath = '.') {
    if (!this.initialized) await this.initialize();
    const results = [];
    const items = await this.redisClient.hGetAll(dirKey(dirPath));

    for (const itemName in items) {
      const fileInfo = JSON.parse(items[itemName]);
      results.push({
        name: fileInfo.name,
        path: path.join(dirPath, fileInfo.name),
        isDirectory: fileInfo.isDirectory,
        size: fileInfo.size,
        modified: fileInfo.modified,
      });
    }

    results.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return b.isDirectory - a.isDirectory;
      return a.name.localeCompare(b.name);
    });

    return results;
  }

  /**
   * Get information for a single file
   */
  async getFileInfo(filePath) {
    if (!this.initialized) await this.initialize();
    const relativePath = path.relative(this.storagePath, filePath);
    const parentDir = path.dirname(relativePath);
    const itemName = path.basename(filePath);

    const fileInfoString = await this.redisClient.hGet(dirKey(parentDir), itemName);
    if (!fileInfoString) {
      return null;
    }

    return JSON.parse(fileInfoString);
  }

  /**
   * Get cache statistics
   */
  async getStats() {
    if (!this.initialized) await this.initialize();
    const keys = await this.redisClient.keys('dir:*');
    let totalFiles = 0;
    for (const key of keys) {
        totalFiles += await this.redisClient.hLen(key);
    }
    return {
      totalFiles: totalFiles,
      totalDirectories: keys.length,
      isWatching: this.watcher !== null,
    };
  }

  /**
   * Close the cache and disconnect from Redis
   */
  async close() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.redisClient) {
      await this.redisClient.quit();
      this.redisClient = null;
    }
    this.initialized = false;
    console.log('Redis cache closed');
  }
}

module.exports = RedisFileSystemCache;
