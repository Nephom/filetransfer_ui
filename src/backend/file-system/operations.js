/**
 * File System Operations
 * Implements core file operations with proper error handling and validation
 */

const { FileSystem } = require('./index');
const fs = require('fs').promises;
const path = require('path');

class FileOperations {
  /**
   * Initialize file operations manager
   * @param {FileSystem} fileSystem - Instance of FileSystem
   */
  constructor(fileSystem) {
    this.fileSystem = fileSystem || new FileSystem();
  }

  /**
   * Rename a file or directory
   * @param {string} oldPath - Current path of the file/directory
   * @param {string} newPath - New path for the file/directory
   * @returns {Promise<Object>} Operation result
   */
  async rename(oldPath, newPath) {
    try {
      // Validate paths
      if (!oldPath || !newPath) {
        throw new Error('Both oldPath and newPath are required');
      }

      // Check if source exists
      const exists = await this.fileSystem.exists(oldPath);
      if (!exists) {
        throw new Error(`Source path does not exist: ${oldPath}`);
      }

      // Check if destination already exists
      const destExists = await this.fileSystem.exists(newPath);
      if (destExists) {
        throw new Error(`Destination already exists: ${newPath}`);
      }

      // Perform rename operation
      await this.fileSystem.move(oldPath, newPath);

      return {
        success: true,
        operation: 'rename',
        oldPath,
        newPath
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        operation: 'rename',
        oldPath,
        newPath
      };
    }
  }

  /**
   * Move a file or directory
   * @param {string} sourcePath - Source path of the file/directory
   * @param {string} destinationPath - Destination path
   * @returns {Promise<Object>} Operation result
   */
  async move(sourcePath, destinationPath) {
    try {
      // Validate paths
      if (!sourcePath || !destinationPath) {
        throw new Error('Both sourcePath and destinationPath are required');
      }

      // Check if source exists
      const exists = await this.fileSystem.exists(sourcePath);
      if (!exists) {
        throw new Error(`Source path does not exist: ${sourcePath}`);
      }

      // Check if destination already exists
      const destExists = await this.fileSystem.exists(destinationPath);
      if (destExists) {
        throw new Error(`Destination already exists: ${destinationPath}`);
      }

      // Perform move operation
      await this.fileSystem.move(sourcePath, destinationPath);

      return {
        success: true,
        operation: 'move',
        sourcePath,
        destinationPath
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        operation: 'move',
        sourcePath,
        destinationPath
      };
    }
  }

  /**
   * Delete a file or directory
   * @param {string} path - Path to delete
   * @param {Object} options - Delete options
   * @param {boolean} options.recursive - Whether to delete directories recursively
   * @returns {Promise<Object>} Operation result
   */
  async delete(path, options = {}) {
    try {
      // Validate path
      if (!path) {
        throw new Error('Path is required for deletion');
      }

      // Check if path exists
      const exists = await this.fileSystem.exists(path);
      if (!exists) {
        throw new Error(`Path does not exist: ${path}`);
      }

      // Perform delete operation
      await this.fileSystem.delete(path);

      return {
        success: true,
        operation: 'delete',
        path,
        recursive: options.recursive || false
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        operation: 'delete',
        path
      };
    }
  }

  /**
   * Copy a file or directory
   * @param {string} sourcePath - Source path of the file/directory
   * @param {string} destinationPath - Destination path
   * @returns {Promise<Object>} Operation result
   */
  async copy(sourcePath, destinationPath) {
    try {
      // Validate paths
      if (!sourcePath || !destinationPath) {
        throw new Error('Both sourcePath and destinationPath are required');
      }

      // Check if source exists
      const exists = await this.fileSystem.exists(sourcePath);
      if (!exists) {
        throw new Error(`Source path does not exist: ${sourcePath}`);
      }

      // Check if destination already exists
      const destExists = await this.fileSystem.exists(destinationPath);
      if (destExists) {
        throw new Error(`Destination already exists: ${destinationPath}`);
      }

      // Perform copy operation
      await this.fileSystem.copy(sourcePath, destinationPath);

      return {
        success: true,
        operation: 'copy',
        sourcePath,
        destinationPath
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        operation: 'copy',
        sourcePath,
        destinationPath
      };
    }
  }

  /**
   * Create a new directory
   * @param {string} path - Path of the directory to create
   * @returns {Promise<Object>} Operation result
   */
  async createDirectory(path) {
    try {
      // Validate path
      if (!path) {
        throw new Error('Path is required for directory creation');
      }

      // Check if directory already exists
      const exists = await this.fileSystem.exists(path);
      if (exists) {
        throw new Error(`Directory already exists: ${path}`);
      }

      // Create directory
      await this.fileSystem.mkdir(path);

      return {
        success: true,
        operation: 'mkdir',
        path
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        operation: 'mkdir',
        path
      };
    }
  }

  /**
   * Get file information
   * @param {string} path - Path to get info for
   * @returns {Promise<Object>} File information
   */
  async fileInfo(path) {
    try {
      // Validate path
      if (!path) {
        throw new Error('Path is required');
      }

      // Check if path exists
      const exists = await this.fileSystem.exists(path);
      if (!exists) {
        throw new Error(`Path does not exist: ${path}`);
      }

      // Get file stats
      const stats = await this.fileSystem.stat(path);

      return {
        success: true,
        path,
        stats
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        path
      };
    }
  }

  /**
   * List directory contents
   * @param {string} path - Path to list
   * @returns {Promise<Object>} Directory contents
   */
  async listDirectory(path) {
    try {
      // Validate path
      if (!path) {
        throw new Error('Path is required');
      }

      // Check if path exists and is a directory
      const exists = await this.fileSystem.exists(path);
      if (!exists) {
        throw new Error(`Path does not exist: ${path}`);
      }

      // Get directory listing
      const items = await this.fileSystem.list(path);

      return {
        success: true,
        path,
        items
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        path
      };
    }
  }
}

module.exports = FileOperations;