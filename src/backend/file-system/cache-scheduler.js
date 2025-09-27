/**
 * Cache Scheduler - Manages time-sliced and background cache operations
 * Provides task scheduling, priority queues, and resource optimization
 */

const { EventEmitter } = require('events');
const path = require('path');

// Task types
const TASK_TYPE = {
  SCAN_DIRECTORY: 'scan_directory',
  REFRESH_PATH: 'refresh_path',
  SEARCH_PRELOAD: 'search_preload',
  CLEANUP: 'cleanup',
  ANALYTICS_SAVE: 'analytics_save',
  MEMORY_OPTIMIZE: 'memory_optimize'
};

// Task priorities (higher number = higher priority)
const TASK_PRIORITY = {
  CRITICAL: 5,    // User-initiated operations
  HIGH: 4,        // Recently accessed directories
  NORMAL: 3,      // Regular background tasks
  LOW: 2,         // Cleanup and optimization
  IDLE: 1         // Analytics and maintenance
};

// Task states
const TASK_STATE = {
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

// Scheduler configuration
const SCHEDULER_CONFIG = {
  MAX_CONCURRENT_TASKS: 3,        // Maximum concurrent background tasks
  TIME_SLICE_MS: 100,             // Time slice for task execution
  YIELD_THRESHOLD_MS: 50,         // Yield if task runs longer than this
  MAX_QUEUE_SIZE: 1000,           // Maximum pending tasks
  RESOURCE_CHECK_INTERVAL: 5000,  // Check system resources every 5s
  CLEANUP_INTERVAL: 30000,        // Cleanup completed tasks every 30s
  ANALYTICS_SAVE_INTERVAL: 300000 // Save analytics every 5 minutes
};

class CacheScheduler extends EventEmitter {
  constructor(layeredCache, searchEngine) {
    super();
    this.layeredCache = layeredCache;
    this.searchEngine = searchEngine;
    
    // Task management
    this.taskQueue = [];           // Priority queue of pending tasks
    this.runningTasks = new Map(); // taskId -> task object
    this.completedTasks = new Map(); // taskId -> result (limited size)
    this.taskIdCounter = 1;
    
    // Scheduler state
    this.isRunning = false;
    this.isPaused = false;
    this.resourceUsage = {
      cpuUsage: 0,
      memoryUsage: 0,
      activeOperations: 0,
      lastCheck: Date.now()
    };
    
    // Intervals
    this.schedulerInterval = null;
    this.resourceCheckInterval = null;
    this.cleanupInterval = null;
    this.analyticsInterval = null;
    
    // Performance tracking
    this.stats = {
      tasksCompleted: 0,
      tasksFailled: 0,
      totalExecutionTime: 0,
      averageTaskTime: 0,
      resourceOptimizations: 0
    };
  }

  /**
   * Initialize the cache scheduler
   */
  async initialize() {
    console.log('Initializing cache scheduler...');
    
    this.isRunning = true;
    
    // Start the main scheduler loop
    this.schedulerInterval = setInterval(() => {
      this.processTaskQueue();
    }, SCHEDULER_CONFIG.TIME_SLICE_MS);
    
    // Start resource monitoring
    this.resourceCheckInterval = setInterval(() => {
      this.checkResourceUsage();
    }, SCHEDULER_CONFIG.RESOURCE_CHECK_INTERVAL);
    
    // Start cleanup tasks
    this.cleanupInterval = setInterval(() => {
      this.cleanupCompletedTasks();
    }, SCHEDULER_CONFIG.CLEANUP_INTERVAL);
    
    // Start periodic analytics saving
    this.analyticsInterval = setInterval(() => {
      this.scheduleTask(TASK_TYPE.ANALYTICS_SAVE, {}, TASK_PRIORITY.IDLE);
    }, SCHEDULER_CONFIG.ANALYTICS_SAVE_INTERVAL);
    
    // Schedule initial background tasks
    this.scheduleInitialTasks();
    
    console.log('Cache scheduler initialized');
  }

  /**
   * Schedule initial background tasks
   */
  scheduleInitialTasks() {
    // Schedule periodic cleanup
    this.scheduleTask(TASK_TYPE.CLEANUP, { type: 'memory' }, TASK_PRIORITY.LOW);
    
    // Schedule analytics save
    this.scheduleTask(TASK_TYPE.ANALYTICS_SAVE, {}, TASK_PRIORITY.IDLE);
    
    console.log('Initial background tasks scheduled');
  }

  /**
   * Schedule a new task
   */
  scheduleTask(type, parameters = {}, priority = TASK_PRIORITY.NORMAL, options = {}) {
    if (this.taskQueue.length >= SCHEDULER_CONFIG.MAX_QUEUE_SIZE) {
      console.warn('Task queue is full, dropping oldest low-priority task');
      this.dropLowPriorityTask();
    }

    const taskId = `task_${this.taskIdCounter++}`;
    const task = {
      id: taskId,
      type,
      parameters,
      priority,
      state: TASK_STATE.PENDING,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      error: null,
      result: null,
      retryCount: 0,
      maxRetries: options.maxRetries || 3,
      timeout: options.timeout || 30000, // 30 second timeout
      cancelable: options.cancelable !== false,
      progress: { current: 0, total: 100, phase: 'pending' }
    };

    // Insert task in priority order
    this.insertTaskByPriority(task);
    
    this.emit('taskScheduled', { taskId, type, priority });
    
    return taskId;
  }

  /**
   * Insert task into queue maintaining priority order
   */
  insertTaskByPriority(task) {
    let insertIndex = this.taskQueue.length;
    
    for (let i = 0; i < this.taskQueue.length; i++) {
      if (this.taskQueue[i].priority < task.priority) {
        insertIndex = i;
        break;
      }
    }
    
    this.taskQueue.splice(insertIndex, 0, task);
  }

  /**
   * Drop lowest priority task when queue is full
   */
  dropLowPriorityTask() {
    // Find lowest priority task
    let lowestPriority = TASK_PRIORITY.CRITICAL;
    let lowestIndex = -1;
    
    for (let i = 0; i < this.taskQueue.length; i++) {
      if (this.taskQueue[i].priority < lowestPriority) {
        lowestPriority = this.taskQueue[i].priority;
        lowestIndex = i;
      }
    }
    
    if (lowestIndex >= 0) {
      const droppedTask = this.taskQueue.splice(lowestIndex, 1)[0];
      console.warn(`Dropped task ${droppedTask.id} (priority: ${droppedTask.priority})`);
      this.emit('taskDropped', { taskId: droppedTask.id, reason: 'queue_full' });
    }
  }

  /**
   * Process the task queue (main scheduler loop)
   */
  async processTaskQueue() {
    if (!this.isRunning || this.isPaused) {
      return;
    }

    // Check if we can start new tasks
    if (this.runningTasks.size >= SCHEDULER_CONFIG.MAX_CONCURRENT_TASKS) {
      return;
    }

    // Check resource constraints
    if (this.isResourceConstrained()) {
      return;
    }

    // Get next task to execute
    const task = this.getNextTask();
    if (!task) {
      return;
    }

    // Start task execution
    await this.executeTask(task);
  }

  /**
   * Get next task from queue considering priorities and dependencies
   */
  getNextTask() {
    if (this.taskQueue.length === 0) {
      return null;
    }

    // For now, just return highest priority task
    // In future, could add dependency checking
    return this.taskQueue.shift();
  }

  /**
   * Execute a task with time slicing and progress tracking
   */
  async executeTask(task) {
    task.state = TASK_STATE.RUNNING;
    task.startedAt = Date.now();
    this.runningTasks.set(task.id, task);

    this.emit('taskStarted', { taskId: task.id, type: task.type });

    const executionStartTime = Date.now();
    let timeoutHandle = null;

    try {
      // Set up timeout if specified
      if (task.timeout) {
        timeoutHandle = setTimeout(() => {
          this.cancelTask(task.id, 'timeout');
        }, task.timeout);
      }

      // Execute the task based on its type
      let result;
      switch (task.type) {
        case TASK_TYPE.SCAN_DIRECTORY:
          result = await this.executeScanDirectory(task);
          break;
        case TASK_TYPE.REFRESH_PATH:
          result = await this.executeRefreshPath(task);
          break;
        case TASK_TYPE.SEARCH_PRELOAD:
          result = await this.executeSearchPreload(task);
          break;
        case TASK_TYPE.CLEANUP:
          result = await this.executeCleanup(task);
          break;
        case TASK_TYPE.ANALYTICS_SAVE:
          result = await this.executeAnalyticsSave(task);
          break;
        case TASK_TYPE.MEMORY_OPTIMIZE:
          result = await this.executeMemoryOptimize(task);
          break;
        default:
          throw new Error(`Unknown task type: ${task.type}`);
      }

      // Task completed successfully
      task.state = TASK_STATE.COMPLETED;
      task.completedAt = Date.now();
      task.result = result;

      const executionTime = task.completedAt - executionStartTime;
      this.stats.tasksCompleted++;
      this.stats.totalExecutionTime += executionTime;
      this.stats.averageTaskTime = this.stats.totalExecutionTime / this.stats.tasksCompleted;

      this.emit('taskCompleted', { 
        taskId: task.id, 
        type: task.type, 
        result, 
        executionTime 
      });

    } catch (error) {
      // Task failed
      task.error = error.message;
      task.retryCount++;

      if (task.retryCount <= task.maxRetries && error.message !== 'cancelled') {
        // Retry the task
        console.log(`Task ${task.id} failed, retrying (${task.retryCount}/${task.maxRetries})`);
        task.state = TASK_STATE.PENDING;
        task.startedAt = null;
        this.insertTaskByPriority(task); // Re-queue for retry
      } else {
        // Task permanently failed
        task.state = TASK_STATE.FAILED;
        task.completedAt = Date.now();
        this.stats.tasksFailled++;

        this.emit('taskFailed', { 
          taskId: task.id, 
          type: task.type, 
          error: error.message,
          retryCount: task.retryCount
        });
      }
    } finally {
      // Clean up
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      this.runningTasks.delete(task.id);
      
      // Store in completed tasks for reference (with size limit)
      this.storeCompletedTask(task);
    }
  }

  /**
   * Execute scan directory task with time slicing
   */
  async executeScanDirectory(task) {
    const { path: scanPath, recursive = true } = task.parameters;
    
    task.progress = { current: 0, total: 100, phase: 'starting' };
    this.updateTaskProgress(task.id, task.progress);

    if (!this.layeredCache) {
      throw new Error('Layered cache not available');
    }

    // Use the layered cache's time-sliced scanning
    await this.layeredCache.refreshPath(scanPath);
    
    task.progress = { current: 100, total: 100, phase: 'completed' };
    this.updateTaskProgress(task.id, task.progress);

    return { path: scanPath, scanned: true };
  }

  /**
   * Execute refresh path task
   */
  async executeRefreshPath(task) {
    const { path: refreshPath } = task.parameters;
    
    task.progress = { current: 0, total: 100, phase: 'refreshing' };
    this.updateTaskProgress(task.id, task.progress);

    if (!this.layeredCache) {
      throw new Error('Layered cache not available');
    }

    await this.layeredCache.refreshPath(refreshPath);
    
    task.progress = { current: 100, total: 100, phase: 'completed' };
    this.updateTaskProgress(task.id, task.progress);

    return { path: refreshPath, refreshed: true };
  }

  /**
   * Execute search preload task
   */
  async executeSearchPreload(task) {
    const { queries = [] } = task.parameters;
    
    task.progress = { current: 0, total: queries.length || 1, phase: 'preloading' };
    this.updateTaskProgress(task.id, task.progress);

    if (!this.searchEngine) {
      throw new Error('Search engine not available');
    }

    const results = [];
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      
      try {
        const searchResult = await this.searchEngine.search(query, {
          mode: 'instant',
          limit: 100
        });
        results.push({ query, success: true, count: searchResult.results.length });
      } catch (error) {
        results.push({ query, success: false, error: error.message });
      }
      
      task.progress.current = i + 1;
      this.updateTaskProgress(task.id, task.progress);
      
      // Yield occasionally
      if (i % 10 === 0) {
        await this.yield();
      }
    }
    
    task.progress = { current: queries.length, total: queries.length, phase: 'completed' };
    this.updateTaskProgress(task.id, task.progress);

    return { preloadedQueries: queries.length, results };
  }

  /**
   * Execute cleanup task
   */
  async executeCleanup(task) {
    const { type = 'memory' } = task.parameters;
    
    task.progress = { current: 0, total: 100, phase: 'cleaning' };
    this.updateTaskProgress(task.id, task.progress);

    let cleanedItems = 0;

    switch (type) {
      case 'memory':
        // Clean up completed tasks
        const beforeSize = this.completedTasks.size;
        this.cleanupCompletedTasks();
        cleanedItems = beforeSize - this.completedTasks.size;
        break;
        
      case 'cache':
        // Clean up old cache entries (would need to be implemented in cache layers)
        cleanedItems = 0; // placeholder
        break;
        
      case 'analytics':
        // Clean up old analytics data (would need to be implemented in search engine)
        cleanedItems = 0; // placeholder
        break;
    }
    
    task.progress = { current: 100, total: 100, phase: 'completed' };
    this.updateTaskProgress(task.id, task.progress);

    this.stats.resourceOptimizations++;

    return { type, cleanedItems };
  }

  /**
   * Execute analytics save task
   */
  async executeAnalyticsSave(task) {
    task.progress = { current: 0, total: 100, phase: 'saving' };
    this.updateTaskProgress(task.id, task.progress);

    if (this.searchEngine && typeof this.searchEngine.saveSearchAnalytics === 'function') {
      await this.searchEngine.saveSearchAnalytics();
    }
    
    task.progress = { current: 100, total: 100, phase: 'completed' };
    this.updateTaskProgress(task.id, task.progress);

    return { saved: true, timestamp: new Date().toISOString() };
  }

  /**
   * Execute memory optimization task
   */
  async executeMemoryOptimize(task) {
    task.progress = { current: 0, total: 100, phase: 'optimizing' };
    this.updateTaskProgress(task.id, task.progress);

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
    
    // Clean up various caches
    this.cleanupCompletedTasks();
    
    task.progress = { current: 100, total: 100, phase: 'completed' };
    this.updateTaskProgress(task.id, task.progress);

    this.stats.resourceOptimizations++;

    return { optimized: true, memoryUsage: process.memoryUsage() };
  }

  /**
   * Update task progress and emit events
   */
  updateTaskProgress(taskId, progress) {
    const task = this.runningTasks.get(taskId);
    if (task) {
      task.progress = progress;
      this.emit('taskProgress', { taskId, progress });
    }
  }

  /**
   * Yield control to prevent blocking
   */
  async yield() {
    return new Promise(resolve => setImmediate(resolve));
  }

  /**
   * Check system resource usage
   */
  checkResourceUsage() {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    this.resourceUsage = {
      cpuUsage: cpuUsage.user + cpuUsage.system,
      memoryUsage: memUsage.heapUsed / memUsage.heapTotal,
      activeOperations: this.runningTasks.size,
      lastCheck: Date.now()
    };

    // Emit resource usage for monitoring
    this.emit('resourceUsage', this.resourceUsage);

    // Auto-optimization if resources are constrained
    if (this.resourceUsage.memoryUsage > 0.9) {
      console.log('High memory usage detected, scheduling optimization');
      this.scheduleTask(TASK_TYPE.MEMORY_OPTIMIZE, {}, TASK_PRIORITY.HIGH);
    }
  }

  /**
   * Check if system is resource constrained
   */
  isResourceConstrained() {
    // Simple resource constraint check
    return this.resourceUsage.memoryUsage > 0.85 || 
           this.runningTasks.size >= SCHEDULER_CONFIG.MAX_CONCURRENT_TASKS;
  }

  /**
   * Store completed task with size limiting
   */
  storeCompletedTask(task) {
    const MAX_COMPLETED_TASKS = 100;
    
    this.completedTasks.set(task.id, {
      id: task.id,
      type: task.type,
      state: task.state,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
      error: task.error,
      result: task.result,
      executionTime: task.completedAt - task.startedAt
    });

    // Remove oldest completed tasks if we exceed limit
    if (this.completedTasks.size > MAX_COMPLETED_TASKS) {
      const oldestEntry = Array.from(this.completedTasks.entries())
        .sort((a, b) => a[1].completedAt - b[1].completedAt)[0];
      
      this.completedTasks.delete(oldestEntry[0]);
    }
  }

  /**
   * Clean up completed tasks periodically
   */
  cleanupCompletedTasks() {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago
    
    for (const [taskId, task] of this.completedTasks) {
      if (task.completedAt < cutoff) {
        this.completedTasks.delete(taskId);
      }
    }
  }

  /**
   * Pause the scheduler
   */
  pause() {
    this.isPaused = true;
    console.log('Cache scheduler paused');
    this.emit('schedulerPaused');
  }

  /**
   * Resume the scheduler
   */
  resume() {
    this.isPaused = false;
    console.log('Cache scheduler resumed');
    this.emit('schedulerResumed');
  }

  /**
   * Cancel a specific task
   */
  cancelTask(taskId, reason = 'user_cancelled') {
    // Check if task is running
    const runningTask = this.runningTasks.get(taskId);
    if (runningTask && runningTask.cancelable) {
      runningTask.state = TASK_STATE.CANCELLED;
      runningTask.error = `Cancelled: ${reason}`;
      runningTask.completedAt = Date.now();
      this.runningTasks.delete(taskId);
      this.storeCompletedTask(runningTask);
      
      console.log(`Task ${taskId} cancelled: ${reason}`);
      this.emit('taskCancelled', { taskId, reason });
      return true;
    }

    // Check if task is pending
    const pendingIndex = this.taskQueue.findIndex(task => task.id === taskId);
    if (pendingIndex >= 0) {
      const pendingTask = this.taskQueue.splice(pendingIndex, 1)[0];
      pendingTask.state = TASK_STATE.CANCELLED;
      pendingTask.error = `Cancelled: ${reason}`;
      pendingTask.completedAt = Date.now();
      this.storeCompletedTask(pendingTask);
      
      console.log(`Pending task ${taskId} cancelled: ${reason}`);
      this.emit('taskCancelled', { taskId, reason });
      return true;
    }

    return false; // Task not found
  }

  /**
   * Cancel all tasks of a specific type
   */
  cancelTasksByType(taskType, reason = 'bulk_cancellation') {
    let cancelledCount = 0;

    // Cancel running tasks
    for (const [taskId, task] of this.runningTasks) {
      if (task.type === taskType && task.cancelable) {
        if (this.cancelTask(taskId, reason)) {
          cancelledCount++;
        }
      }
    }

    // Cancel pending tasks
    const pendingTasksToCancel = this.taskQueue
      .filter(task => task.type === taskType)
      .map(task => task.id);

    for (const taskId of pendingTasksToCancel) {
      if (this.cancelTask(taskId, reason)) {
        cancelledCount++;
      }
    }

    console.log(`Cancelled ${cancelledCount} tasks of type ${taskType}`);
    return cancelledCount;
  }

  /**
   * Get task status
   */
  getTaskStatus(taskId) {
    // Check running tasks
    const runningTask = this.runningTasks.get(taskId);
    if (runningTask) {
      return {
        id: runningTask.id,
        type: runningTask.type,
        state: runningTask.state,
        progress: runningTask.progress,
        createdAt: runningTask.createdAt,
        startedAt: runningTask.startedAt,
        error: runningTask.error
      };
    }

    // Check completed tasks
    const completedTask = this.completedTasks.get(taskId);
    if (completedTask) {
      return completedTask;
    }

    // Check pending tasks
    const pendingTask = this.taskQueue.find(task => task.id === taskId);
    if (pendingTask) {
      return {
        id: pendingTask.id,
        type: pendingTask.type,
        state: pendingTask.state,
        priority: pendingTask.priority,
        createdAt: pendingTask.createdAt,
        position: this.taskQueue.indexOf(pendingTask) + 1
      };
    }

    return null; // Task not found
  }

  /**
   * Get scheduler statistics
   */
  getSchedulerStats() {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      queue: {
        pending: this.taskQueue.length,
        running: this.runningTasks.size,
        completed: this.completedTasks.size
      },
      performance: {
        tasksCompleted: this.stats.tasksCompleted,
        tasksFailled: this.stats.tasksFailled,
        averageTaskTime: Math.round(this.stats.averageTaskTime),
        resourceOptimizations: this.stats.resourceOptimizations
      },
      resources: this.resourceUsage,
      configuration: SCHEDULER_CONFIG
    };
  }

  /**
   * Get queue status with priorities
   */
  getQueueStatus() {
    const queueByPriority = {};
    
    for (const task of this.taskQueue) {
      const priorityName = Object.keys(TASK_PRIORITY).find(
        key => TASK_PRIORITY[key] === task.priority
      ) || 'UNKNOWN';
      
      if (!queueByPriority[priorityName]) {
        queueByPriority[priorityName] = [];
      }
      
      queueByPriority[priorityName].push({
        id: task.id,
        type: task.type,
        createdAt: task.createdAt,
        retryCount: task.retryCount
      });
    }

    const runningTasks = Array.from(this.runningTasks.values()).map(task => ({
      id: task.id,
      type: task.type,
      progress: task.progress,
      startedAt: task.startedAt,
      runningTime: Date.now() - task.startedAt
    }));

    return {
      pending: queueByPriority,
      running: runningTasks,
      totalPending: this.taskQueue.length,
      totalRunning: this.runningTasks.size
    };
  }

  /**
   * Close the scheduler and cleanup
   */
  async close() {
    console.log('Closing cache scheduler...');
    
    this.isRunning = false;
    
    // Clear intervals
    if (this.schedulerInterval) clearInterval(this.schedulerInterval);
    if (this.resourceCheckInterval) clearInterval(this.resourceCheckInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.analyticsInterval) clearInterval(this.analyticsInterval);
    
    // Cancel all running tasks
    const runningTaskIds = Array.from(this.runningTasks.keys());
    for (const taskId of runningTaskIds) {
      this.cancelTask(taskId, 'scheduler_shutdown');
    }
    
    // Clear all queues
    this.taskQueue = [];
    this.runningTasks.clear();
    this.completedTasks.clear();
    
    console.log('Cache scheduler closed');
    this.emit('schedulerClosed');
  }
}

module.exports = {
  CacheScheduler,
  TASK_TYPE,
  TASK_PRIORITY,
  TASK_STATE,
  SCHEDULER_CONFIG
};