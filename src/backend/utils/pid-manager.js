const fs = require('fs').promises;
const path = require('path');
const { systemLogger } = require('./logger');

class PIDManager {
  constructor() {
    this.pidFile = path.join(__dirname, '../../../server.pid');
    this.lockFile = path.join(__dirname, '../../../server.lock');
    this.lockTimeout = 2 * 60 * 1000; // 2 minutes
  }

  /**
   * Write current process PID to server.pid
   */
  async writePID(pid = process.pid) {
    try {
      await fs.writeFile(this.pidFile, pid.toString(), 'utf8');
      systemLogger.logSystem('INFO', `Process PID ${pid} written to server.pid`);
      return true;
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to write PID: ${error.message}`);
      return false;
    }
  }

  /**
   * Read PID from server.pid
   * @returns {number|null} PID or null if file doesn't exist
   */
  async readPID() {
    try {
      const pidStr = await fs.readFile(this.pidFile, 'utf8');
      return parseInt(pidStr.trim(), 10);
    } catch (error) {
      return null;
    }
  }

  /**
   * Delete server.pid file
   */
  async deletePID() {
    try {
      await fs.unlink(this.pidFile);
      systemLogger.logSystem('INFO', 'PID file deleted');
      return true;
    } catch (error) {
      // File might not exist, that's ok
      return false;
    }
  }

  /**
   * Check if process with given PID is running
   * @param {number} pid - Process ID to check
   * @returns {boolean} True if process is running
   */
  isProcessRunning(pid) {
    try {
      // Send signal 0 to check if process exists (doesn't actually send a signal)
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Acquire restart lock
   * @param {string} initiator - Username or "shell"
   * @param {string} method - "web" or "shell"
   * @returns {Object} { success: boolean, message: string, lockData?: Object }
   */
  async acquireLock(initiator = 'unknown', method = 'unknown') {
    try {
      // Check if lock already exists
      const existingLock = await this.readLock();

      if (existingLock) {
        // Check if lock is stale
        const isStale = await this.checkStaleLock();

        if (!isStale) {
          // Lock is fresh, restart in progress
          return {
            success: false,
            message: '服務正在重啟中，請稍候',
            lockData: existingLock
          };
        }

        // Lock is stale, clean it up and continue
        systemLogger.logSystem('WARN', `Stale lock detected, cleaning up. Previous lock: ${JSON.stringify(existingLock)}`);
        await this.releaseLock();
      }

      // Create new lock
      const lockData = {
        pid: process.pid,
        timestamp: new Date().toISOString(),
        initiator: initiator,
        method: method
      };

      await fs.writeFile(this.lockFile, JSON.stringify(lockData, null, 2), 'utf8');
      systemLogger.logSystem('INFO', `Restart lock acquired by ${initiator} (${method})`);

      return {
        success: true,
        message: 'Lock acquired',
        lockData: lockData
      };
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to acquire lock: ${error.message}`);
      return {
        success: false,
        message: `無法獲取重啟鎖: ${error.message}`
      };
    }
  }

  /**
   * Release restart lock
   */
  async releaseLock() {
    try {
      await fs.unlink(this.lockFile);
      systemLogger.logSystem('INFO', 'Restart lock released');
      return true;
    } catch (error) {
      // Lock file might not exist, that's ok
      return false;
    }
  }

  /**
   * Check if restart lock exists
   * @returns {boolean} True if locked
   */
  async isLocked() {
    try {
      await fs.access(this.lockFile);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Read lock data
   * @returns {Object|null} Lock data or null if no lock
   */
  async readLock() {
    try {
      const lockStr = await fs.readFile(this.lockFile, 'utf8');
      return JSON.parse(lockStr);
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if lock is stale (older than 2 minutes)
   * @returns {boolean} True if lock is stale or doesn't exist
   */
  async checkStaleLock() {
    const lockData = await this.readLock();

    if (!lockData) {
      return true; // No lock = not stale, can proceed
    }

    try {
      const lockTime = new Date(lockData.timestamp);
      const lockAge = Date.now() - lockTime.getTime();

      if (lockAge > this.lockTimeout) {
        // Lock is stale
        return true;
      }

      // Lock is fresh
      return false;
    } catch (error) {
      // Invalid lock data, consider it stale
      systemLogger.logSystem('WARN', `Invalid lock data, considering stale: ${error.message}`);
      return true;
    }
  }

  /**
   * Get lock information for display
   * @returns {Object|null} Lock info or null
   */
  async getLockInfo() {
    const lockData = await this.readLock();

    if (!lockData) {
      return null;
    }

    const lockAge = Date.now() - new Date(lockData.timestamp).getTime();
    const isStale = lockAge > this.lockTimeout;

    return {
      ...lockData,
      lockAge: Math.floor(lockAge / 1000), // in seconds
      isStale: isStale
    };
  }
}

module.exports = new PIDManager();
