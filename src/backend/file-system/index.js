/**
 * File System Abstraction Layer
 * Provides a unified interface for file operations across different storage backends
 */

class FileSystem {
  /**
   * Initialize the file system abstraction
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.options = options;
    this.backend = this._initializeBackend();
  }

  /**
   * Initialize the appropriate backend based on configuration
   * @private
   */
  _initializeBackend() {
    // For now, we'll default to local file system
    // In a real implementation, this would support multiple backends
    return new LocalFileSystem();
  }

  /**
   * Read a file from the file system
   * @param {string} path - Path to the file
   * @returns {Promise<Buffer|string>} File content
   */
  async read(path) {
    return await this.backend.read(path);
  }

  /**
   * Write content to a file
   * @param {string} path - Path to the file
   * @param {Buffer|string} content - Content to write
   * @param {Object} options - Write options
   * @returns {Promise<void>}
   */
  async write(path, content, options = {}) {
    return await this.backend.write(path, content, options);
  }

  /**
   * Delete a file or directory
   * @param {string} path - Path to delete
   * @returns {Promise<void>}
   */
  async delete(path) {
    return await this.backend.delete(path);
  }

  /**
   * List contents of a directory
   * @param {string} path - Path to directory
   * @returns {Promise<Array>} List of items in directory
   */
  async list(path) {
    return await this.backend.list(path);
  }

  /**
   * Create a directory
   * @param {string} path - Path to create
   * @returns {Promise<void>}
   */
  async mkdir(path) {
    return await this.backend.mkdir(path);
  }

  /**
   * Check if a file or directory exists
   * @param {string} path - Path to check
   * @returns {Promise<boolean>} True if exists
   */
  async exists(path) {
    return await this.backend.exists(path);
  }

  /**
   * Get file metadata
   * @param {string} path - Path to file
   * @returns {Promise<Object>} File metadata
   */
  async stat(path) {
    return await this.backend.stat(path);
  }
}

/**
 * Local File System Implementation
 */
class LocalFileSystem {
  /**
   * Read a file from the local file system
   * @param {string} path - Path to the file
   * @returns {Promise<Buffer|string>} File content
   */
  async read(path) {
    const fs = require('fs').promises;
    try {
      return await fs.readFile(path);
    } catch (error) {
      throw new Error(`Failed to read file ${path}: ${error.message}`);
    }
  }

  /**
   * Write content to a file
   * @param {string} path - Path to the file
   * @param {Buffer|string} content - Content to write
   * @param {Object} options - Write options
   * @returns {Promise<void>}
   */
  async write(path, content, options = {}) {
    const fs = require('fs').promises;
    try {
      await fs.writeFile(path, content, options);
    } catch (error) {
      throw new Error(`Failed to write file ${path}: ${error.message}`);
    }
  }

  /**
   * Delete a file or directory
   * @param {string} path - Path to delete
   * @returns {Promise<void>}
   */
  async delete(path) {
    const fs = require('fs').promises;
    try {
      await fs.rm(path, { recursive: true });
    } catch (error) {
      throw new Error(`Failed to delete ${path}: ${error.message}`);
    }
  }

  /**
   * List contents of a directory
   * @param {string} path - Path to directory
   * @returns {Promise<Array>} List of items in directory
   */
  async list(path) {
    const fs = require('fs').promises;
    try {
      const items = await fs.readdir(path);
      return items.map(item => ({
        name: item,
        path: `${path}/${item}`
      }));
    } catch (error) {
      throw new Error(`Failed to list directory ${path}: ${error.message}`);
    }
  }

  /**
   * Create a directory
   * @param {string} path - Path to create
   * @returns {Promise<void>}
   */
  async mkdir(path) {
    const fs = require('fs').promises;
    try {
      await fs.mkdir(path, { recursive: true });
    } catch (error) {
      throw new Error(`Failed to create directory ${path}: ${error.message}`);
    }
  }

  /**
   * Check if a file or directory exists
   * @param {string} path - Path to check
   * @returns {Promise<boolean>} True if exists
   */
  async exists(path) {
    const fs = require('fs').promises;
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file metadata
   * @param {string} path - Path to file
   * @returns {Promise<Object>} File metadata
   */
  async stat(path) {
    const fs = require('fs').promises;
    try {
      const stats = await fs.stat(path);
      return {
        size: stats.size,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        modified: stats.mtime,
        created: stats.birthtime
      };
    } catch (error) {
      throw new Error(`Failed to get stats for ${path}: ${error.message}`);
    }
  }
}

module.exports = { FileSystem, LocalFileSystem };