/**
 * Layered File System Cache Architecture
 * Implements a three-tier cache system: metadata -> content -> directory
 * Provides fast metadata scanning, time-sliced operations, and interruptible cache operations
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { createClient } = require('redis');
const { EventEmitter } = require('events');
const config = require('../config/config');

// Cache layer types
const CACHE_LAYERS = {
  METADATA: 'metadata',    // Quick file/folder existence and basic info
  CONTENT: 'content',      // File content metadata (size, dates, type)
  DIRECTORY: 'directory'   // Full directory structure and relationships
};

// Cache priority levels
const CACHE_PRIORITY = {
  CRITICAL: 4,    // Root directories, frequently accessed
  HIGH: 3,        // Recently accessed directories
  MEDIUM: 2,      // Standard directories
  LOW: 1          // Deep/rarely accessed directories
};

// Time slice configuration (ms)
const TIME_SLICE_CONFIG = {
  METADATA_SCAN: 50,     // 50ms slices for metadata scanning
  CONTENT_SCAN: 100,     // 100ms slices for content scanning
  DIRECTORY_SCAN: 200,   // 200ms slices for directory scanning
  MAX_CONTINUOUS: 1000   // Max 1s continuous operation before yielding
};

class LayeredFileSystemCache extends EventEmitter {
  constructor(storagePath) {
    super();
    this.storagePath = path.resolve(storagePath);
    this.redisClient = null;
    this.watcher = null;
    this.initialized = false;
    
    // Operation control
    this.isScanning = false;
    this.scanAbortController = null;
    this.operationQueue = [];
    this.isProcessingQueue = false;
    
    // Cache layer state
    this.cacheStats = {
      [CACHE_LAYERS.METADATA]: { files: 0, directories: 0, lastUpdate: null },
      [CACHE_LAYERS.CONTENT]: { files: 0, directories: 0, lastUpdate: null },
      [CACHE_LAYERS.DIRECTORY]: { files: 0, directories: 0, lastUpdate: null }
    };
    
    // Priority tracking
    this.accessFrequency = new Map(); // path -> { count, lastAccess, priority }
  }

  /**
   * Initialize the layered cache system
   */
  async initialize() {
    if (this.initialized) return;

    console.log('Initializing layered file system cache...');

    // 1. Connect to Redis
    try {
      const redisUrl = config.get('redisUrl');
      this.redisClient = createClient({ url: redisUrl });
      this.redisClient.on('error', (err) => console.error('Redis Client Error', err));
      await this.redisClient.connect();
      console.log('Connected to Redis successfully.');
    } catch (error) {
      console.error('Failed to connect to Redis:', error);
      throw new Error('Redis connection failed. Layered cache cannot be initialized.');
    }

    // 2. Initialize cache layers
    await this.initializeCacheLayers();

    // 3. Start progressive scanning (interruptible)
    this.startProgressiveScanning();

    this.initialized = true;
    console.log('Layered cache system initialized successfully.');
  }

  /**
   * Initialize cache layer structures in Redis
   */
  async initializeCacheLayers() {
    const layers = Object.values(CACHE_LAYERS);
    
    for (const layer of layers) {
      // Clear existing layer data
      const keys = await this.redisClient.keys(`${layer}:*`);
      if (keys.length > 0) {
        await this.redisClient.del(keys);
      }
      
      // Initialize layer metadata
      await this.redisClient.hSet(`${layer}:meta`, {
        created: new Date().toISOString(),
        version: '1.0.0',
        totalItems: '0'
      });
    }
    
    console.log('Cache layers initialized');
  }

  /**
   * Start progressive, interruptible scanning
   */
  async startProgressiveScanning() {
    if (this.isScanning) {
      console.log('Scanning already in progress');
      return;
    }

    this.isScanning = true;
    this.scanAbortController = new AbortController();

    try {
      // Phase 1: Fast metadata scan (< 1 second target)
      console.log('Phase 1: Starting fast metadata scan...');
      const metadataStartTime = Date.now();
      await this.scanMetadataLayer();
      const metadataTime = Date.now() - metadataStartTime;
      console.log(`Phase 1: Metadata scan completed in ${metadataTime}ms`);

      // Check if we should continue
      if (this.scanAbortController.signal.aborted) {
        console.log('Scanning aborted after metadata phase');
        return;
      }

      // Phase 2: Content scanning with time slices
      console.log('Phase 2: Starting content scan...');
      await this.scanContentLayer();
      console.log('Phase 2: Content scan completed');

      // Check if we should continue
      if (this.scanAbortController.signal.aborted) {
        console.log('Scanning aborted after content phase');
        return;
      }

      // Phase 3: Full directory structure scanning
      console.log('Phase 3: Starting directory structure scan...');
      await this.scanDirectoryLayer();
      console.log('Phase 3: Directory structure scan completed');

      // Phase 4: Start file system watching
      // this.startWatching();

    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('Scanning was aborted');
      } else {
        console.error('Error during progressive scanning:', error);
      }
    } finally {
      this.isScanning = false;
      this.scanAbortController = null;
    }
  }

  /**
   * Fast metadata-only scan (for fast refresh strategy)
   * Only runs Phase 1 (metadata) without content or directory structure
   */
  async scanMetadataOnly(targetPath = null) {
    const scanPath = targetPath || this.storagePath;
    console.log(`Starting fast metadata-only scan for: ${scanPath}`);
    
    if (this.isScanning) {
      console.log('Another scan is in progress, aborting it first');
      this.abortScanning();
      // Wait a bit for the abort to take effect
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.isScanning = true;
    this.scanAbortController = new AbortController();

    try {
      // Only run Phase 1: Fast metadata scan
      console.log('Fast metadata scan started...');
      const startTime = Date.now();
      await this.scanMetadataLayer();
      const scanTime = Date.now() - startTime;
      console.log(`Fast metadata scan completed in ${scanTime}ms`);
      
      return {
        success: true,
        scanTime,
        metadataOnly: true,
        scanPath
      };
    } catch (error) {
      console.error('Fast metadata scan failed:', error);
      throw error;
    } finally {
      this.isScanning = false;
      this.scanAbortController = null;
    }
  }

  /**
   * Fast metadata layer scan - only basic file/directory existence
   */
  async scanMetadataLayer() {
    const startTime = Date.now();
    let processedItems = 0;
    
    await this.scanDirectoryWithTimeSlicing(
      this.storagePath,
      CACHE_LAYERS.METADATA,
      TIME_SLICE_CONFIG.METADATA_SCAN,
      async (itemPath, stats, relativePath) => {
        // Only store basic metadata for fast access
        const metadata = {
          name: path.basename(itemPath),
          isDirectory: stats.isDirectory(),
          exists: true,
          priority: this.calculatePriority(relativePath),
          lastAccess: Date.now()
        };

        const key = `${CACHE_LAYERS.METADATA}:${relativePath}`;
        await this.redisClient.hSet(key, metadata);
        processedItems++;

        // Quick abort check every 100 items
        if (processedItems % 100 === 0) {
          this.checkAbortSignal();
        }
      }
    );

    this.cacheStats[CACHE_LAYERS.METADATA].lastUpdate = new Date().toISOString();
    this.cacheStats[CACHE_LAYERS.METADATA].files = processedItems;
    
    console.log(`Metadata layer: processed ${processedItems} items in ${Date.now() - startTime}ms`);
  }

  /**
   * Content layer scan - file sizes, dates, and content metadata
   */
  async scanContentLayer() {
    let processedItems = 0;
    
    await this.scanDirectoryWithTimeSlicing(
      this.storagePath,
      CACHE_LAYERS.CONTENT,
      TIME_SLICE_CONFIG.CONTENT_SCAN,
      async (itemPath, stats, relativePath) => {
        const contentInfo = {
          name: path.basename(itemPath),
          isDirectory: stats.isDirectory(),
          size: stats.size,
          modified: stats.mtime.toISOString(),
          created: stats.birthtime.toISOString(),
          priority: this.calculatePriority(relativePath),
          contentHash: null // Will be populated on demand
        };

        // Add file type information for non-directories
        if (!stats.isDirectory()) {
          contentInfo.extension = path.extname(itemPath).toLowerCase();
          contentInfo.mimeType = this.getMimeType(contentInfo.extension);
        }

        const key = `${CACHE_LAYERS.CONTENT}:${relativePath}`;
        await this.redisClient.hSet(key, contentInfo);
        processedItems++;

        // Check abort signal every 50 items
        if (processedItems % 50 === 0) {
          this.checkAbortSignal();
        }
      }
    );

    this.cacheStats[CACHE_LAYERS.CONTENT].lastUpdate = new Date().toISOString();
    this.cacheStats[CACHE_LAYERS.CONTENT].files = processedItems;
    
    console.log(`Content layer: processed ${processedItems} items`);
  }

  /**
   * Directory layer scan - full directory structure and relationships
   */
  async scanDirectoryLayer() {
    let processedItems = 0;
    
    await this.scanDirectoryWithTimeSlicing(
      this.storagePath,
      CACHE_LAYERS.DIRECTORY,
      TIME_SLICE_CONFIG.DIRECTORY_SCAN,
      async (itemPath, stats, relativePath) => {
        const parentDir = path.dirname(relativePath);
        const itemName = path.basename(itemPath);
        
        const directoryInfo = {
          name: itemName,
          isDirectory: stats.isDirectory(),
          size: stats.size,
          modified: stats.mtime.toISOString(),
          created: stats.birthtime.toISOString(),
          parentPath: parentDir === '.' ? '' : parentDir,
          fullPath: relativePath,
          priority: this.calculatePriority(relativePath)
        };

        // Store in parent directory hash
        const parentKey = `${CACHE_LAYERS.DIRECTORY}:${parentDir}`;
        await this.redisClient.hSet(parentKey, itemName, JSON.stringify(directoryInfo));
        processedItems++;

        // Check abort signal every 25 items
        if (processedItems % 25 === 0) {
          this.checkAbortSignal();
        }
      }
    );

    this.cacheStats[CACHE_LAYERS.DIRECTORY].lastUpdate = new Date().toISOString();
    this.cacheStats[CACHE_LAYERS.DIRECTORY].files = processedItems;
    
    console.log(`Directory layer: processed ${processedItems} items`);
  }

  /**
   * Scan directory with time slicing to prevent blocking
   */
  async scanDirectoryWithTimeSlicing(dirPath, layer, timeSlice, itemProcessor) {
    const scanStartTime = Date.now();
    
    const scanRecursive = async (currentDir) => {
      try {
        const items = await fs.readdir(currentDir);
        const sliceStartTime = Date.now();
        
        for (const item of items) {
          const itemPath = path.join(currentDir, item);
          const relativePath = path.relative(this.storagePath, itemPath);
          
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

            // Process the item
            await itemProcessor(itemPath, stats, relativePath);

            // Time slice management
            const elapsed = Date.now() - sliceStartTime;
            if (elapsed > timeSlice) {
              // Yield control to prevent blocking
              await this.yield();
              this.checkAbortSignal();
              return; // Exit current slice, will be resumed
            }

            // Recursively scan subdirectories
            if (stats.isDirectory()) {
              await scanRecursive(itemPath);
            }

          } catch (statError) {
            if (statError.code !== 'EACCES') { // EACCES is expected for read-only, so we don't log it as a warning
                console.warn(`Skipping ${itemPath}:`, statError.message);
            }
          }
        }
      } catch (error) {
        console.error(`Error scanning directory ${currentDir}:`, error.message);
      }
    };

    await scanRecursive(dirPath);
  }

  /**
   * Calculate cache priority based on path characteristics
   */
  calculatePriority(relativePath) {
    // Root level gets critical priority
    if (!relativePath || relativePath === '.' || relativePath.split(path.sep).length <= 1) {
      return CACHE_PRIORITY.CRITICAL;
    }

    // Check access frequency
    const accessInfo = this.accessFrequency.get(relativePath);
    if (accessInfo) {
      const daysSinceAccess = (Date.now() - accessInfo.lastAccess) / (1000 * 60 * 60 * 24);
      
      if (accessInfo.count > 10 && daysSinceAccess < 1) return CACHE_PRIORITY.HIGH;
      if (accessInfo.count > 5 && daysSinceAccess < 7) return CACHE_PRIORITY.MEDIUM;
    }

    // Deep directories get lower priority
    const depth = relativePath.split(path.sep).length;
    if (depth > 5) return CACHE_PRIORITY.LOW;
    if (depth > 3) return CACHE_PRIORITY.MEDIUM;
    
    return CACHE_PRIORITY.MEDIUM;
  }

  /**
   * Get MIME type based on file extension
   */
  getMimeType(extension) {
    const mimeTypes = {
      '.txt': 'text/plain',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.html': 'text/html',
      '.css': 'text/css',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip'
    };
    
    return mimeTypes[extension] || 'application/octet-stream';
  }

  /**
   * Yield control to prevent blocking the event loop
   */
  async yield() {
    return new Promise(resolve => setImmediate(resolve));
  }

  /**
   * Check if scanning should be aborted
   */
  checkAbortSignal() {
    if (this.scanAbortController && this.scanAbortController.signal.aborted) {
      throw new Error('AbortError: Scanning was aborted');
    }
  }

  /**
   * Abort current scanning operations
   */
  abortScanning() {
    if (this.scanAbortController) {
      this.scanAbortController.abort();
      console.log('Cache scanning aborted');
    }
  }

  /**
   * Fast file search across all cache layers (prioritized)
   */
  async searchFiles(query, options = {}) {
    const { layer = CACHE_LAYERS.DIRECTORY, limit = 1000, priorityFilter = null } = options;
    
    if (!this.initialized) {
      // Return basic metadata if available
      return await this.searchInLayer(CACHE_LAYERS.METADATA, query, { limit });
    }

    return await this.searchInLayer(layer, query, { limit, priorityFilter });
  }

  /**
   * Search in specific cache layer
   */
  async searchInLayer(layer, query, options = {}) {
    const { limit = 1000, priorityFilter = null } = options;
    const results = [];
    const lowerQuery = query.toLowerCase();
    
    let cursor = 0;
    do {
      const reply = await this.redisClient.scan(cursor, {
        MATCH: `${layer}:*`,
        COUNT: 100
      });
      cursor = reply.cursor;
      
      for (const key of reply.keys) {
        if (results.length >= limit) break;
        
        if (layer === CACHE_LAYERS.DIRECTORY) {
          // Directory layer has nested structure
          const items = await this.redisClient.hGetAll(key);
          for (const itemName in items) {
            if (results.length >= limit) break;
            
            if (itemName.toLowerCase().includes(lowerQuery)) {
              const fileInfo = JSON.parse(items[itemName]);
              
              // Apply priority filter if specified
              if (priorityFilter && fileInfo.priority < priorityFilter) continue;
              
              results.push({
                name: fileInfo.name,
                path: fileInfo.fullPath,
                isDirectory: fileInfo.isDirectory,
                size: fileInfo.size,
                modified: fileInfo.modified,
                priority: fileInfo.priority,
                layer: layer
              });
              
              // Update access frequency
              this.updateAccessFrequency(fileInfo.fullPath);
            }
          }
        } else {
          // Metadata and content layers have direct key mapping
          const relativePath = key.substring(layer.length + 1);
          const itemName = path.basename(relativePath);
          
          if (itemName.toLowerCase().includes(lowerQuery)) {
            const fileInfo = await this.redisClient.hGetAll(key);
            
            // Apply priority filter if specified
            if (priorityFilter && fileInfo.priority < priorityFilter) continue;
            
            results.push({
              name: fileInfo.name,
              path: relativePath,
              isDirectory: fileInfo.isDirectory === 'true',
              size: fileInfo.size ? parseInt(fileInfo.size) : 0,
              modified: fileInfo.modified,
              priority: parseInt(fileInfo.priority) || CACHE_PRIORITY.MEDIUM,
              layer: layer
            });
            
            // Update access frequency
            this.updateAccessFrequency(relativePath);
          }
        }
      }
    } while (cursor !== 0 && results.length < limit);
    
    // Sort by priority and name
    results.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      if (a.isDirectory !== b.isDirectory) return b.isDirectory - a.isDirectory;
      return a.name.localeCompare(b.name);
    });
    
    return results;
  }

  /**
   * Get files in directory (uses best available layer)
   */
  async getFilesInDirectory(dirPath = '.') {
    // Try directory layer first (most complete)
    try {
      return await this.getFilesFromLayer(CACHE_LAYERS.DIRECTORY, dirPath);
    } catch (error) {
      // Fallback to content layer
      try {
        return await this.getFilesFromLayer(CACHE_LAYERS.CONTENT, dirPath);
      } catch (error) {
        // Final fallback to metadata layer
        return await this.getFilesFromLayer(CACHE_LAYERS.METADATA, dirPath);
      }
    }
  }

  /**
   * Get files from specific layer
   */
  async getFilesFromLayer(layer, dirPath) {
    const key = `${layer}:${dirPath}`;
    
    if (layer === CACHE_LAYERS.DIRECTORY) {
      const items = await this.redisClient.hGetAll(key);
      const results = [];
      
      for (const itemName in items) {
        const fileInfo = JSON.parse(items[itemName]);
        results.push({
          name: fileInfo.name,
          path: fileInfo.fullPath,
          isDirectory: fileInfo.isDirectory,
          size: fileInfo.size || 0,
          modified: fileInfo.modified,
          priority: fileInfo.priority
        });
        
        // Update access frequency
        this.updateAccessFrequency(fileInfo.fullPath);
      }
      
      return this.sortResults(results);
    } else {
      // For metadata and content layers, we need to scan for children
      const results = [];
      const searchPrefix = dirPath === '.' ? '' : dirPath + '/';
      
      let cursor = 0;
      do {
        const reply = await this.redisClient.scan(cursor, {
          MATCH: `${layer}:${searchPrefix}*`,
          COUNT: 100
        });
        cursor = reply.cursor;
        
        for (const key of reply.keys) {
          const relativePath = key.substring(layer.length + 1);
          
          // Only get direct children, not deep descendants
          const remainingPath = relativePath.substring(searchPrefix.length);
          if (remainingPath && !remainingPath.includes('/')) {
            const fileInfo = await this.redisClient.hGetAll(key);
            results.push({
              name: fileInfo.name,
              path: relativePath,
              isDirectory: fileInfo.isDirectory === 'true',
              size: fileInfo.size ? parseInt(fileInfo.size) : 0,
              modified: fileInfo.modified,
              priority: parseInt(fileInfo.priority) || CACHE_PRIORITY.MEDIUM
            });
            
            // Update access frequency
            this.updateAccessFrequency(relativePath);
          }
        }
      } while (cursor !== 0);
      
      return this.sortResults(results);
    }
  }

  /**
   * Update access frequency for priority calculation
   */
  updateAccessFrequency(filePath) {
    const current = this.accessFrequency.get(filePath) || { count: 0, lastAccess: 0, priority: CACHE_PRIORITY.MEDIUM };
    
    current.count += 1;
    current.lastAccess = Date.now();
    current.priority = this.calculatePriority(filePath);
    
    this.accessFrequency.set(filePath, current);
  }

  /**
   * Sort results by priority and type
   */
  sortResults(results) {
    return results.sort((a, b) => {
      if (a.priority !== b.priority) return (b.priority || 0) - (a.priority || 0);
      if (a.isDirectory !== b.isDirectory) return b.isDirectory - a.isDirectory;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Start file system watching
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
        /(^|[\/\\])\../, // Ignore dotfiles
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
      .on('add', (filePath) => this.updateFileInAllLayers(filePath))
      .on('change', (filePath) => this.updateFileInAllLayers(filePath))
      .on('unlink', (filePath) => this.removeFileFromAllLayers(filePath))
      .on('addDir', (dirPath) => this.updateFileInAllLayers(dirPath))
      .on('unlinkDir', (dirPath) => this.removeDirectoryFromAllLayers(dirPath))
      .on('error', (error) => console.error('Watcher error:', error));

    console.log('Layered file system watcher started');
  }

  /**
   * Update file in all cache layers
   */
  async updateFileInAllLayers(filePath) {
    try {
      const relativePath = path.relative(this.storagePath, filePath);
      const lstat = await fs.lstat(filePath);
      if (lstat.isSymbolicLink()) return;

      const stats = await fs.stat(filePath);
      await fs.access(filePath, fsSync.constants.R_OK);

      const priority = this.calculatePriority(relativePath);

      // Update metadata layer
      const metadata = {
        name: path.basename(filePath),
        isDirectory: stats.isDirectory(),
        exists: true,
        priority: priority,
        lastAccess: Date.now()
      };
      await this.redisClient.hSet(`${CACHE_LAYERS.METADATA}:${relativePath}`, metadata);

      // Update content layer
      const contentInfo = {
        name: path.basename(filePath),
        isDirectory: stats.isDirectory(),
        size: stats.size,
        modified: stats.mtime.toISOString(),
        created: stats.birthtime.toISOString(),
        priority: priority
      };
      
      if (!stats.isDirectory()) {
        contentInfo.extension = path.extname(filePath).toLowerCase();
        contentInfo.mimeType = this.getMimeType(contentInfo.extension);
      }
      
      await this.redisClient.hSet(`${CACHE_LAYERS.CONTENT}:${relativePath}`, contentInfo);

      // Update directory layer
      const parentDir = path.dirname(relativePath);
      const itemName = path.basename(filePath);
      
      const directoryInfo = {
        name: itemName,
        isDirectory: stats.isDirectory(),
        size: stats.size,
        modified: stats.mtime.toISOString(),
        created: stats.birthtime.toISOString(),
        parentPath: parentDir === '.' ? '' : parentDir,
        fullPath: relativePath,
        priority: priority
      };

      const parentKey = `${CACHE_LAYERS.DIRECTORY}:${parentDir}`;
      await this.redisClient.hSet(parentKey, itemName, JSON.stringify(directoryInfo));

      this.emit('change', { operation: 'update', path: relativePath, layers: Object.values(CACHE_LAYERS) });

    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Error updating file in layers ${filePath}:`, error.message);
      }
    }
  }

  /**
   * Remove file from all cache layers
   */
  async removeFileFromAllLayers(filePath) {
    const relativePath = path.relative(this.storagePath, filePath);
    const parentDir = path.dirname(relativePath);
    const itemName = path.basename(filePath);

    // Remove from metadata layer
    await this.redisClient.del(`${CACHE_LAYERS.METADATA}:${relativePath}`);

    // Remove from content layer  
    await this.redisClient.del(`${CACHE_LAYERS.CONTENT}:${relativePath}`);

    // Remove from directory layer
    await this.redisClient.hDel(`${CACHE_LAYERS.DIRECTORY}:${parentDir}`, itemName);

    // Remove from access frequency tracking
    this.accessFrequency.delete(relativePath);

    this.emit('change', { operation: 'remove', path: relativePath, layers: Object.values(CACHE_LAYERS) });
  }

  /**
   * Remove directory from all cache layers
   */
  async removeDirectoryFromAllLayers(dirPath) {
    const relativePath = path.relative(this.storagePath, dirPath);
    
    // Remove the directory itself and all descendants from all layers
    const layers = Object.values(CACHE_LAYERS);
    
    for (const layer of layers) {
      // Remove the directory key
      await this.redisClient.del(`${layer}:${relativePath}`);
      
      // Remove all descendant keys
      const keys = await this.redisClient.keys(`${layer}:${relativePath}/*`);
      if (keys.length > 0) {
        await this.redisClient.del(keys);
      }
    }

    // Remove from parent directory in directory layer
    const parentDir = path.dirname(relativePath);
    const itemName = path.basename(dirPath);
    await this.redisClient.hDel(`${CACHE_LAYERS.DIRECTORY}:${parentDir}`, itemName);

    // Clean up access frequency tracking for directory and descendants
    for (const [path] of this.accessFrequency) {
      if (path.startsWith(relativePath)) {
        this.accessFrequency.delete(path);
      }
    }

    this.emit('change', { operation: 'removeDir', path: relativePath, layers: Object.values(CACHE_LAYERS) });
  }

  /**
   * Get detailed cache statistics
   */
  async getStats() {
    const stats = { ...this.cacheStats };
    
    // Get current counts from Redis
    for (const layer of Object.values(CACHE_LAYERS)) {
      const keys = await this.redisClient.keys(`${layer}:*`);
      let totalItems = 0;
      
      for (const key of keys) {
        if (key.endsWith(':meta')) continue; // Skip metadata keys
        
        if (layer === CACHE_LAYERS.DIRECTORY) {
          totalItems += await this.redisClient.hLen(key);
        } else {
          totalItems += 1;
        }
      }
      
      stats[layer].totalItems = totalItems;
      stats[layer].keys = keys.length;
    }

    stats.isScanning = this.isScanning;
    stats.isWatching = this.watcher !== null;
    stats.accessFrequencyEntries = this.accessFrequency.size;
    
    return stats;
  }

  /**
   * Get file info from the best available layer
   */
  async getFileInfo(filePath) {
    const relativePath = path.relative(this.storagePath, filePath);
    
    // Try content layer first (most detailed)
    try {
      const contentInfo = await this.redisClient.hGetAll(`${CACHE_LAYERS.CONTENT}:${relativePath}`);
      if (contentInfo && Object.keys(contentInfo).length > 0) {
        this.updateAccessFrequency(relativePath);
        return {
          ...contentInfo,
          isDirectory: contentInfo.isDirectory === 'true',
          size: contentInfo.size ? parseInt(contentInfo.size) : 0,
          priority: parseInt(contentInfo.priority) || CACHE_PRIORITY.MEDIUM,
          layer: CACHE_LAYERS.CONTENT
        };
      }
    } catch (error) {
      console.warn('Content layer lookup failed:', error.message);
    }

    // Fallback to metadata layer
    try {
      const metadataInfo = await this.redisClient.hGetAll(`${CACHE_LAYERS.METADATA}:${relativePath}`);
      if (metadataInfo && Object.keys(metadataInfo).length > 0) {
        this.updateAccessFrequency(relativePath);
        return {
          ...metadataInfo,
          isDirectory: metadataInfo.isDirectory === 'true',
          priority: parseInt(metadataInfo.priority) || CACHE_PRIORITY.MEDIUM,
          layer: CACHE_LAYERS.METADATA
        };
      }
    } catch (error) {
      console.warn('Metadata layer lookup failed:', error.message);
    }

    return null;
  }

  /**
   * Force refresh of specific directory or file
   */
  async refreshPath(targetPath) {
    const fullPath = path.resolve(this.storagePath, targetPath);
    
    try {
      const stats = await fs.stat(fullPath);
      
      if (stats.isDirectory()) {
        // Re-scan directory in all layers
        await this.scanDirectoryWithTimeSlicing(
          fullPath,
          'refresh',
          TIME_SLICE_CONFIG.DIRECTORY_SCAN,
          async (itemPath, itemStats, relativePath) => {
            await this.updateFileInAllLayers(itemPath);
          }
        );
      } else {
        // Re-cache single file
        await this.updateFileInAllLayers(fullPath);
      }
      
      console.log(`Refreshed cache for: ${targetPath}`);
    } catch (error) {
      console.error(`Error refreshing path ${targetPath}:`, error.message);
      throw error;
    }
  }

  /**
   * Close the layered cache system
   */
  async close() {
    // Abort any ongoing scanning
    this.abortScanning();
    
    // Close watcher
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    
    // Close Redis connection
    if (this.redisClient) {
      await this.redisClient.quit();
      this.redisClient = null;
    }
    
    // Clean up state
    this.accessFrequency.clear();
    this.initialized = false;
    
    console.log('Layered cache system closed');
  }
}

module.exports = {
  LayeredFileSystemCache,
  CACHE_LAYERS,
  CACHE_PRIORITY,
  TIME_SLICE_CONFIG
};