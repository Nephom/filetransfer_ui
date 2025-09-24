/**
 * Enhanced File System Manager with In-Memory Cache
 * Uses in-memory cache with real-time file watching for optimal performance
 */

const { FileSystem } = require('./index');
const MemoryFileSystemCache = require('./memory-cache');
const path = require('path');
const fs = require('fs').promises;

class EnhancedMemoryFileSystem extends FileSystem {
  constructor(storagePath) {
    super();
    this.storagePath = path.resolve(storagePath);
    this.cache = new MemoryFileSystemCache(storagePath);
    this.initialized = false;
    this.operationQueue = [];
    this.isProcessingQueue = false;
    this.concurrentOperations = new Map(); // Track concurrent operations
  }

  /**
   * Initialize the enhanced file system
   */
  async initialize() {
    if (this.initialized) return;
    
    console.log('Initializing enhanced memory file system...');
    
    // Initialize cache
    await this.cache.initialize();
    
    // Listen for cache changes
    this.cache.on('change', (event) => {
      console.log(`File system change detected: ${event.operation} ${event.path}`);
    });
    
    this.initialized = true;
    console.log('Enhanced memory file system initialized');
  }

  /**
   * Get cache statistics
   */
  async getCacheStats() {
    return await this.cache.getStats();
  }

  /**
   * Search files using in-memory cache (very fast)
   */
  async searchFiles(query) {
    if (!this.initialized) {
      // Return empty array if cache is not ready.
      return [];
    }
    return await this.cache.searchFiles(query);
  }

  /**
   * List files in directory using cache when possible
   */
  async list(dirPath) {
    // If cache is ready, try to use it.
    if (this.initialized) {
      try {
        const relativePath = path.relative(this.storagePath, dirPath);
        const normalizedRelativePath = relativePath === '.' ? '' : relativePath;
        const cachedFiles = await this.cache.getFilesInDirectory(normalizedRelativePath);

        // If cache has the directory, return it.
        if (cachedFiles && cachedFiles.length > 0) {
          return cachedFiles;
        }
      } catch (error) {
        console.error('Cache list error:', error);
        // Fallthrough to filesystem if cache fails
      }
    }

    // Fallback to filesystem if cache is not ready or directory not in cache.
    return await super.list(dirPath);
  }

  /**
   * Create directory with concurrency control
   */
  async mkdir(dirPath) {
    return await this.executeWithLock(dirPath, async () => {
      await super.mkdir(dirPath);
      
      // The watcher will automatically update the cache
    });
  }

  /**
   * Write file with concurrency control
   */
  async write(filePath, content, options = {}) {
    return await this.executeWithLock(filePath, async () => {
      await super.write(filePath, content, options);
      
      // The watcher will automatically update the cache
    });
  }

  /**
   * Delete file/directory with concurrency control
   */
  async delete(filePath) {
    return await this.executeWithLock(filePath, async () => {
      // Get relative path before deletion
      const relativePath = path.relative(this.storagePath, filePath);
      
      await super.delete(filePath);
      
      // The watcher will automatically update the cache
    });
  }

  /**
   * Copy file/directory with concurrency control
   */
  async copy(sourcePath, destinationPath) {
    const lockPaths = [sourcePath, destinationPath];
    return await this.executeWithMultipleLocks(lockPaths, async () => {
      await super.copy(sourcePath, destinationPath);
      
      // The watcher will automatically update the cache for the destination
      // Manual cache update is not needed as the watcher is more reliable
    });
  }

  /**
   * Move file/directory with concurrency control
   */
  async move(sourcePath, destinationPath) {
    const lockPaths = [sourcePath, destinationPath];
    return await this.executeWithMultipleLocks(lockPaths, async () => {
      await super.move(sourcePath, destinationPath);
      
      // The watcher will automatically handle both removal and addition
    });
  }

  /**
   * Rename file/directory with concurrency control
   */
  async rename(oldPath, newPath) {
    const lockPaths = [oldPath, newPath];
    return await this.executeWithMultipleLocks(lockPaths, async () => {
      await super.rename(oldPath, newPath);
      
      // The watcher will automatically handle both removal and addition
    });
  }

  /**
   * Execute operation with single path lock
   */
  async executeWithLock(filePath, operation) {
    const normalizedPath = path.resolve(filePath);
    
    // Wait for any existing operation on this path
    while (this.concurrentOperations.has(normalizedPath)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    // Lock the path
    this.concurrentOperations.set(normalizedPath, true);
    
    try {
      return await operation();
    } finally {
      // Unlock the path
      this.concurrentOperations.delete(normalizedPath);
    }
  }

  /**
   * Execute operation with multiple path locks
   */
  async executeWithMultipleLocks(filePaths, operation) {
    const normalizedPaths = filePaths.map(p => path.resolve(p));
    
    // Wait for any existing operations on these paths
    let allClear = false;
    while (!allClear) {
      allClear = normalizedPaths.every(p => !this.concurrentOperations.has(p));
      if (!allClear) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    
    // Lock all paths
    normalizedPaths.forEach(p => this.concurrentOperations.set(p, true));
    
    try {
      return await operation();
    } finally {
      // Unlock all paths
      normalizedPaths.forEach(p => this.concurrentOperations.delete(p));
    }
  }

  /**
   * Refresh cache manually (for compatibility)
   */
  async refreshCache() {
    if (!this.initialized) {
      await this.initialize();
      return;
    }
    
    console.log('Manual cache refresh requested - clearing and rescanning...');
    // In Redis implementation, re-scan is handled by initialize which includes a flush
    await this.cache.close();
    await this.initialize();
    console.log('Manual cache refresh completed');
  }

  /**
   * Check if a file exists (uses filesystem)
   */
  async exists(filePath) {
    return await super.exists(filePath);
  }

  /**
   * Get file stats (uses filesystem)
   */
  async stat(filePath) {
    return await super.stat(filePath);
  }

  /**
   * Get detailed cache information
   */
  async getCacheInfo() {
    if (!this.initialized) {
      return { initialized: false };
    }
    
    const stats = await this.cache.getStats();
    return {
      initialized: true,
      ...stats,
      concurrentOperations: this.concurrentOperations.size,
      storagePath: this.storagePath
    };
  }

  /**
   * Close cache and cleanup
   */
  async close() {
    if (this.cache) {
      await this.cache.close();
    }
    this.concurrentOperations.clear();
    this.initialized = false;
  }
}

module.exports = EnhancedMemoryFileSystem;
