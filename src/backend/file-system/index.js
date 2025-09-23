/**
 * File System Abstraction Layer
 * Provides a unified interface for file operations across different storage backends
 */

const EnhancedMemoryFileSystem = require('./enhanced-memory');

const EnhancedMemoryFileSystem = require('./enhanced-memory');

class FileSystem {
  /**
   * Initialize the file system abstraction
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.options = options;
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

  /**
   * Rename a file or directory
   * @param {string} oldPath - Current path
   * @param {string} newPath - New path
   * @returns {Promise<void>}
   */
  async rename(oldPath, newPath) {
    return await this.backend.rename(oldPath, newPath);
  }

  /**
   * Copy a file or directory
   * @param {string} sourcePath - Source path
   * @param {string} destinationPath - Destination path
   * @returns {Promise<void>}
   */
  async copy(sourcePath, destinationPath) {
    return await this.backend.copy(sourcePath, destinationPath);
  }

  /**
   * Move a file or directory
   * @param {string} sourcePath - Source path
   * @param {string} destinationPath - Destination path
   * @returns {Promise<void>}
   */
  async move(sourcePath, destinationPath) {
    return await this.backend.move(sourcePath, destinationPath);
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
      const itemsWithStats = await Promise.all(
        items.map(async (item) => {
          const itemPath = `${path}/${item}`;
          try {
            const stats = await fs.stat(itemPath);
            return {
              name: item,
              path: itemPath,
              isDirectory: stats.isDirectory(),
              size: stats.size,
              modified: stats.mtime.toISOString()
            };
          } catch (error) {
            // If we can't get stats, assume it's a file
            return {
              name: item,
              path: itemPath,
              isDirectory: false,
              size: 0,
              modified: new Date().toISOString()
            };
          }
        })
      );
      return itemsWithStats;
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

  /**
   * Rename/move a file or directory
   * @param {string} oldPath - Current path
   * @param {string} newPath - New path
   * @returns {Promise<void>}
   */
  async rename(oldPath, newPath) {
    const fs = require('fs').promises;
    try {
      await fs.rename(oldPath, newPath);
    } catch (error) {
      throw new Error(`Failed to rename ${oldPath} to ${newPath}: ${error.message}`);
    }
  }

  /**
   * Copy a file or directory
   * @param {string} sourcePath - Source path
   * @param {string} destinationPath - Destination path
   * @returns {Promise<void>}
   */
  async copy(sourcePath, destinationPath) {
    const fs = require('fs').promises;
    const path = require('path');

    try {
      const stats = await fs.stat(sourcePath);

      if (stats.isDirectory()) {
        // Copy directory recursively
        await fs.mkdir(destinationPath, { recursive: true });
        const items = await fs.readdir(sourcePath);

        for (const item of items) {
          const srcPath = path.join(sourcePath, item);
          const destPath = path.join(destinationPath, item);
          await this.copy(srcPath, destPath);
        }
      } else {
        // Copy file
        await fs.copyFile(sourcePath, destinationPath);
      }
    } catch (error) {
      throw new Error(`Failed to copy ${sourcePath} to ${destinationPath}: ${error.message}`);
    }
  }

  /**
   * Move a file or directory
   * @param {string} sourcePath - Source path
   * @param {string} destinationPath - Destination path
   * @returns {Promise<void>}
   */
  async move(sourcePath, destinationPath) {
    try {
      await this.rename(sourcePath, destinationPath);
    } catch (error) {
      // If rename fails (e.g., across different filesystems), try copy + delete
      try {
        await this.copy(sourcePath, destinationPath);
        await this.delete(sourcePath);
      } catch (copyError) {
        throw new Error(`Failed to move ${sourcePath} to ${destinationPath}: ${error.message}`);
      }
    }
  }
}

module.exports = { FileSystem, LocalFileSystem, EnhancedMemoryFileSystem };