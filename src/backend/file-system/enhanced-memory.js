/**
 * Enhanced File System Manager with Layered Cache Architecture
 * Uses layered cache system with metadata/content/directory tiers for optimal performance
 * Supports fast metadata scanning, time-sliced operations, and interruptible cache operations
 */

const { FileSystem } = require('./index');
const { LayeredFileSystemCache, CACHE_LAYERS, CACHE_PRIORITY } = require('./layered-cache');
const { IntelligentSearchEngine, SEARCH_MODE, SEARCH_CONTEXT } = require('./search-engine');
const { CacheScheduler, TASK_TYPE, TASK_PRIORITY, TASK_STATE } = require('./cache-scheduler');
const path = require('path');
const fs = require('fs').promises;

class EnhancedMemoryFileSystem extends FileSystem {
  constructor(storagePath) {
    super();
    this.storagePath = path.resolve(storagePath);
    this.cache = new LayeredFileSystemCache(storagePath);
    this.searchEngine = new IntelligentSearchEngine(this.cache);
    this.scheduler = new CacheScheduler(this.cache, this.searchEngine);
    this.initialized = false;
    this.operationQueue = [];
    this.isProcessingQueue = false;
    this.concurrentOperations = new Map(); // Track concurrent operations
    this.fastModeEnabled = true; // Enable fast metadata scanning by default
  }

  /**
   * Initialize the enhanced file system with layered cache, intelligent search, and scheduler
   */
  async initialize() {
    if (this.initialized) return;
    
    console.log('Initializing enhanced memory file system with layered cache, intelligent search, and scheduler...');
    
    // Initialize layered cache system
    await this.cache.initialize();
    
    // Initialize intelligent search engine
    await this.searchEngine.initialize();
    
    // Initialize cache scheduler
    await this.scheduler.initialize();
    
    // Listen for cache changes
    this.cache.on('change', (event) => {
      console.log(`File system change detected: ${event.operation} ${event.path} (layers: ${event.layers?.join(', ')})`);
    });
    
    // Listen for search progress updates
    this.searchEngine.on('searchProgress', (event) => {
      console.log(`Search progress: ${event.searchId} - ${event.progress.phase} (${event.progress.current}%)`);
    });
    
    // Listen for scheduler events
    this.scheduler.on('taskCompleted', (event) => {
      console.log(`Scheduler task completed: ${event.taskId} (${event.type}) in ${event.executionTime}ms`);
    });
    
    this.scheduler.on('resourceUsage', (usage) => {
      if (usage.memoryUsage > 0.8) {
        console.warn(`High memory usage: ${(usage.memoryUsage * 100).toFixed(1)}%`);
      }
    });
    
    this.initialized = true;
    console.log('Enhanced memory file system with full intelligent caching stack initialized');
  }

  /**
   * Get cache statistics
   */
  async getCacheStats() {
    return await this.cache.getStats();
  }

  /**
   * Get information for a single file from cache
   */
  async getFileInfo(filePath) {
    if (!this.initialized) {
      return null;
    }
    return await this.cache.getFileInfo(filePath);
  }

  /**
   * Search files using intelligent search engine (ultra-fast with analytics and context)
   */
  async searchFiles(query, options = {}) {
    if (!this.initialized) {
      // Return empty array if cache is not ready.
      return [];
    }

    // Default to instant mode for backwards compatibility, but provide access to all modes
    const searchOptions = {
      mode: this.fastModeEnabled ? SEARCH_MODE.INSTANT : SEARCH_MODE.PROGRESSIVE,
      limit: options.limit || 1000,
      sessionId: options.sessionId || null,
      includeContent: options.includeContent || false,
      fuzzyThreshold: options.fuzzyThreshold || 0.7,
      contextualSearch: options.contextualSearch !== false, // Default true
      onProgress: options.onProgress || null,
      ...options
    };

    const searchResult = await this.searchEngine.search(query, searchOptions);
    
    // Return results array for backwards compatibility, but full result object is available
    return searchResult.results;
  }

  /**
   * Advanced search with full intelligent search engine features
   */
  async intelligentSearch(query, options = {}) {
    if (!this.initialized) {
      return {
        searchId: null,
        query,
        results: [],
        mode: SEARCH_MODE.INSTANT,
        responseTime: 0,
        totalResults: 0,
        context: null
      };
    }

    return await this.searchEngine.search(query, options);
  }

  /**
   * Progressive search with real-time updates
   */
  async progressiveSearch(query, onProgress, options = {}) {
    if (!this.initialized) {
      return [];
    }

    const searchOptions = {
      ...options,
      mode: SEARCH_MODE.PROGRESSIVE,
      onProgress: onProgress
    };

    const result = await this.searchEngine.search(query, searchOptions);
    return result.results;
  }

  /**
   * List files in directory using layered cache (prioritizes fastest available layer)
   */
  async list(dirPath) {
    // If cache is ready, try to use it.
    if (this.initialized) {
      try {
        const relativePath = path.relative(this.storagePath, dirPath);
        const normalizedRelativePath = relativePath === '.' ? '' : relativePath;
        
        // Get files from the best available cache layer
        const cachedFiles = await this.cache.getFilesInDirectory(normalizedRelativePath);

        // If cache has the directory, return it.
        if (cachedFiles && cachedFiles.length > 0) {
          return cachedFiles;
        }
      } catch (error) {
        console.error('Layered cache list error:', error);
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
   * Refresh cache manually (supports interruptible operations and background scheduling)
   */
  async refreshCache(targetPath = null) {
    if (!this.initialized) {
      await this.initialize();
      return;
    }
    
    console.log('Manual cache refresh requested...');
    
    if (targetPath) {
      // Refresh specific path using scheduler for better resource management
      const taskId = this.scheduler.scheduleTask(
        TASK_TYPE.REFRESH_PATH,
        { path: targetPath },
        TASK_PRIORITY.HIGH,
        { cancelable: true }
      );
      console.log(`Scheduled targeted refresh for: ${targetPath} (Task: ${taskId})`);
      return { taskId, targetPath };
    } else {
      // Full refresh - restart the progressive scanning
      this.abortCurrentOperations();
      await this.cache.close();
      await this.initialize();
      console.log('Full manual cache refresh completed');
      return { full: true };
    }
  }

  /**
   * Fast metadata-only refresh (lightweight refresh that only updates metadata)
   */
  async refreshMetadataCache(targetPath = null) {
    if (!this.initialized) {
      await this.initialize();
      return;
    }
    
    console.log('Fast metadata refresh requested...');
    
    if (targetPath) {
      // Fast refresh for specific path - only metadata
      const taskId = this.scheduler.scheduleTask(
        TASK_TYPE.METADATA_SCAN,
        { path: targetPath, metadataOnly: true },
        TASK_PRIORITY.MEDIUM,
        { cancelable: true }
      );
      console.log(`Scheduled fast metadata refresh for: ${targetPath} (Task: ${taskId})`);
      return { taskId, targetPath, metadataOnly: true };
    } else {
      // Fast metadata refresh - lightweight scan without content indexing
      try {
        await this.cache.scanMetadataOnly(this.storagePath);
        console.log('Fast metadata refresh completed');
        return { metadataOnly: true, completed: true };
      } catch (error) {
        console.warn('Fast metadata refresh failed, falling back to regular refresh:', error);
        return await this.refreshCache();
      }
    }
  }

  /**
   * Abort current cache operations (scanning, etc.)
   */
  abortCurrentOperations() {
    if (this.cache) {
      this.cache.abortScanning();
    }
    
    // Cancel all running cache-related tasks in scheduler
    if (this.scheduler) {
      const cancelled = this.scheduler.cancelTasksByType(TASK_TYPE.SCAN_DIRECTORY, 'user_abort');
      console.log(`Aborted ${cancelled} scheduled cache operations`);
    }
  }

  /**
   * Schedule background cache operations
   */
  scheduleBackgroundScan(directories = [], priority = TASK_PRIORITY.LOW) {
    if (!this.initialized) {
      console.warn('System not initialized, cannot schedule background scan');
      return [];
    }

    const taskIds = [];
    for (const dir of directories) {
      const taskId = this.scheduler.scheduleTask(
        TASK_TYPE.SCAN_DIRECTORY,
        { path: dir, recursive: true },
        priority,
        { cancelable: true, timeout: 300000 } // 5 minute timeout
      );
      taskIds.push(taskId);
    }

    console.log(`Scheduled ${taskIds.length} background scan tasks`);
    return taskIds;
  }

  /**
   * Pre-cache specific directories using scheduler for better resource management
   */
  async preCacheDirectories(directories = []) {
    if (!this.initialized) {
      await this.initialize();
    }

    console.log(`Scheduling pre-cache for ${directories.length} directories...`);
    
    const taskIds = [];
    for (const dir of directories) {
      const taskId = this.scheduler.scheduleTask(
        TASK_TYPE.SCAN_DIRECTORY,
        { path: dir, recursive: false },
        TASK_PRIORITY.NORMAL,
        { cancelable: true }
      );
      taskIds.push(taskId);
    }
    
    return taskIds;
  }

  /**
   * Smart pre-caching based on search analytics using scheduler
   */
  async smartPreCache() {
    if (!this.initialized) {
      await this.initialize();
    }

    // Schedule smart preloading task
    const taskId = this.scheduler.scheduleTask(
      TASK_TYPE.SEARCH_PRELOAD,
      {},
      TASK_PRIORITY.LOW,
      { cancelable: true }
    );

    console.log(`Scheduled smart pre-cache task: ${taskId}`);
    return { taskId };
  }

  /**
   * Pause/Resume scheduler operations
   */
  pauseScheduler() {
    if (this.scheduler) {
      this.scheduler.pause();
      return { paused: true };
    }
    return { error: 'Scheduler not available' };
  }

  resumeScheduler() {
    if (this.scheduler) {
      this.scheduler.resume();
      return { resumed: true };
    }
    return { error: 'Scheduler not available' };
  }

  /**
   * Get scheduler task status
   */
  getTaskStatus(taskId) {
    if (!this.scheduler) {
      return null;
    }
    return this.scheduler.getTaskStatus(taskId);
  }

  /**
   * Cancel a scheduled task
   */
  cancelTask(taskId, reason = 'user_request') {
    if (!this.scheduler) {
      return false;
    }
    return this.scheduler.cancelTask(taskId, reason);
  }

  /**
   * Get scheduler queue status
   */
  getSchedulerQueue() {
    if (!this.scheduler) {
      return { error: 'Scheduler not available' };
    }
    return this.scheduler.getQueueStatus();
  }

  /**
   * Get scheduler statistics
   */
  getSchedulerStats() {
    if (!this.scheduler) {
      return { error: 'Scheduler not available' };
    }
    return this.scheduler.getSchedulerStats();
  }

  /**
   * Enable or disable fast mode (metadata layer priority)
   */
  setFastMode(enabled) {
    this.fastModeEnabled = enabled;
    console.log(`Fast mode ${enabled ? 'enabled' : 'disabled'} - using ${enabled ? 'metadata' : 'directory'} layer for searches`);
  }

  /**
   * Search with specific layer and priority filtering
   */
  async searchWithOptions(query, options = {}) {
    const {
      layer = CACHE_LAYERS.DIRECTORY,
      priorityFilter = null,
      limit = 1000,
      sortBy = 'priority' // 'priority', 'name', 'modified', 'size'
    } = options;

    if (!this.initialized) {
      return [];
    }

    const results = await this.cache.searchFiles(query, { layer, priorityFilter, limit });

    // Apply custom sorting if requested
    if (sortBy !== 'priority') {
      results.sort((a, b) => {
        switch (sortBy) {
          case 'name':
            return a.name.localeCompare(b.name);
          case 'modified':
            return new Date(b.modified || 0) - new Date(a.modified || 0);
          case 'size':
            return (b.size || 0) - (a.size || 0);
          default:
            return 0;
        }
      });
    }

    return results;
  }

  /**
   * Get files with high priority only (frequently accessed)
   */
  async getHighPriorityFiles(dirPath = '') {
    if (!this.initialized) {
      return [];
    }

    return await this.cache.getFilesInDirectory(dirPath).then(files =>
      files.filter(file => (file.priority || 0) >= CACHE_PRIORITY.HIGH)
    );
  }

  /**
   * Pre-cache specific directories (for performance optimization)
   */
  async preCacheDirectories(directories = []) {
    if (!this.initialized) {
      await this.initialize();
    }

    console.log(`Pre-caching ${directories.length} directories...`);
    
    for (const dir of directories) {
      try {
        await this.cache.refreshPath(dir);
        console.log(`Pre-cached: ${dir}`);
      } catch (error) {
        console.warn(`Failed to pre-cache ${dir}:`, error.message);
      }
    }
    
    console.log('Pre-caching completed');
  }

  /**
   * Smart pre-caching based on search analytics
   */
  async smartPreCache() {
    if (!this.initialized) {
      await this.initialize();
    }

    return await this.searchEngine.smartPreCache();
  }

  /**
   * Get search analytics and insights
   */
  async getSearchAnalytics() {
    if (!this.initialized) {
      return { analytics: null, message: 'Search engine not initialized' };
    }

    return this.searchEngine.getSearchAnalytics();
  }

  /**
   * Get search progress for active progressive searches
   */
  getSearchProgress(searchId) {
    if (!this.initialized) {
      return null;
    }

    return this.searchEngine.getSearchProgress(searchId);
  }

  /**
   * Search with specific context and mode
   */
  async contextualSearch(query, context = {}) {
    const { 
      previousQueries = [], 
      userSession = null, 
      preferredFileTypes = [], 
      recentPaths = [] 
    } = context;

    if (!this.initialized) {
      return [];
    }

    // Build search options based on context
    const searchOptions = {
      sessionId: userSession,
      mode: SEARCH_MODE.PROGRESSIVE,
      limit: 500,
      contextualSearch: true
    };

    // If user has preferred file types, boost those results
    if (preferredFileTypes.length > 0) {
      searchOptions.fileTypeBoost = preferredFileTypes;
    }

    // If user has recent paths, boost those areas
    if (recentPaths.length > 0) {
      searchOptions.pathBoost = recentPaths;
    }

    const result = await this.searchEngine.search(query, searchOptions);
    
    // Add context-aware suggestions
    result.contextSuggestions = {
      relatedQueries: result.context?.suggestedQueries || [],
      recentSearches: previousQueries.slice(0, 5),
      recommendedPaths: recentPaths.slice(0, 3)
    };

    return result;
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
   * Get detailed layered cache, search engine, and scheduler information
   */
  async getCacheInfo() {
    if (!this.initialized) {
      return { initialized: false };
    }
    
    const stats = await this.cache.getStats();
    const searchAnalytics = await this.getSearchAnalytics();
    const schedulerStats = this.getSchedulerStats();
    
    return {
      initialized: true,
      layered: true,
      intelligentSearch: true,
      scheduler: true,
      fastMode: this.fastModeEnabled,
      ...stats,
      concurrentOperations: this.concurrentOperations.size,
      storagePath: this.storagePath,
      layers: {
        metadata: stats[CACHE_LAYERS.METADATA],
        content: stats[CACHE_LAYERS.CONTENT],  
        directory: stats[CACHE_LAYERS.DIRECTORY]
      },
      searchEngine: searchAnalytics,
      scheduler: schedulerStats
    };
  }

  /**
   * Close cache and cleanup all components
   */
  async close() {
    if (this.scheduler) {
      await this.scheduler.close();
    }
    if (this.searchEngine) {
      await this.searchEngine.close();
    }
    if (this.cache) {
      await this.cache.close();
    }
    this.concurrentOperations.clear();
    this.initialized = false;
  }
}

module.exports = EnhancedMemoryFileSystem;
