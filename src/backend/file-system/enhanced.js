/**
 * Enhanced File System Manager with Cache Integration
 * DEPRECATED: This file uses old SQLite cache - use memory-cache.js instead
 * TODO: Remove this file after confirming all references are updated
 */

const { FileSystem } = require('./index');
// DEPRECATED: Using old SQLite cache
const FileSystemCache = require('./cache');
const path = require('path');
const fs = require('fs').promises;

class EnhancedFileSystem extends FileSystem {
  constructor(storagePath) {
    super();
    this.storagePath = storagePath;
    this.cache = new FileSystemCache();
    this.initialized = false;
  }

  /**
   * Initialize the enhanced file system
   */
  async initialize() {
    if (this.initialized) return;
    
    await this.cache.initialize();
    await this.refreshCache();
    this.initialized = true;
    
    console.log('Enhanced file system initialized with cache');
  }

  /**
   * Refresh the entire cache
   */
  async refreshCache() {
    await this.cache.scanAndCache(this.storagePath);
  }

  /**
   * Search files using cache (much faster than filesystem traversal)
   */
  async searchFiles(query) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    return await this.cache.searchFiles(query);
  }

  /**
   * List files in directory using cache when possible
   */
  async list(dirPath) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Calculate relative path for cache lookup
      const fullPath = path.resolve(dirPath);
      const relativePath = path.relative(this.storagePath, fullPath);
      
      // Try to get from cache first
      const cachedFiles = await this.cache.getFilesInDirectory(relativePath);
      
      if (cachedFiles.length > 0) {
        return cachedFiles;
      }
      
      // Fallback to filesystem if cache is empty
      const files = await super.list(dirPath);
      
      // Update cache with new files
      for (const file of files) {
        const filePath = path.join(dirPath, file.name);
        const fileRelativePath = path.relative(this.storagePath, filePath);
        
        await this.cache.addFile({
          name: file.name,
          path: filePath,
          relativePath: fileRelativePath,
          isDirectory: file.isDirectory,
          size: file.size,
          modifiedTime: file.modified,
          parentPath: relativePath
        });
      }
      
      return files;
    } catch (error) {
      console.error('Error listing files:', error);
      // Fallback to regular filesystem operation
      return await super.list(dirPath);
    }
  }

  /**
   * Create directory and update cache
   */
  async mkdir(dirPath) {
    await super.mkdir(dirPath);
    
    if (this.initialized) {
      const relativePath = path.relative(this.storagePath, dirPath);
      const parentPath = path.dirname(relativePath);
      
      await this.cache.addFile({
        name: path.basename(dirPath),
        path: dirPath,
        relativePath: relativePath,
        isDirectory: true,
        size: 0,
        modifiedTime: new Date().toISOString(),
        parentPath: parentPath === '.' ? '' : parentPath
      });
    }
  }

  /**
   * Write file and update cache
   */
  async write(filePath, content, options = {}) {
    await super.write(filePath, content, options);
    
    if (this.initialized) {
      const stats = await fs.stat(filePath);
      const relativePath = path.relative(this.storagePath, filePath);
      const parentPath = path.dirname(relativePath);
      
      await this.cache.addFile({
        name: path.basename(filePath),
        path: filePath,
        relativePath: relativePath,
        isDirectory: false,
        size: stats.size,
        modifiedTime: stats.mtime.toISOString(),
        parentPath: parentPath === '.' ? '' : parentPath
      });
    }
  }

  /**
   * Delete file/directory and update cache
   */
  async delete(filePath) {
    await super.delete(filePath);
    
    if (this.initialized) {
      await this.cache.removeFile(filePath);
    }
  }

  /**
   * Copy file/directory and update cache
   */
  async copy(sourcePath, destinationPath) {
    await super.copy(sourcePath, destinationPath);
    
    if (this.initialized) {
      // Add destination to cache
      const stats = await fs.stat(destinationPath);
      const relativePath = path.relative(this.storagePath, destinationPath);
      const parentPath = path.dirname(relativePath);
      
      await this.cache.addFile({
        name: path.basename(destinationPath),
        path: destinationPath,
        relativePath: relativePath,
        isDirectory: stats.isDirectory(),
        size: stats.size,
        modifiedTime: stats.mtime.toISOString(),
        parentPath: parentPath === '.' ? '' : parentPath
      });
      
      // If it's a directory, refresh cache to get all subdirectories
      if (stats.isDirectory()) {
        await this.refreshCache();
      }
    }
  }

  /**
   * Move file/directory and update cache
   */
  async move(sourcePath, destinationPath) {
    await super.move(sourcePath, destinationPath);
    
    if (this.initialized) {
      // Remove source from cache
      await this.cache.removeFile(sourcePath);
      
      // Add destination to cache
      const stats = await fs.stat(destinationPath);
      const relativePath = path.relative(this.storagePath, destinationPath);
      const parentPath = path.dirname(relativePath);
      
      await this.cache.addFile({
        name: path.basename(destinationPath),
        path: destinationPath,
        relativePath: relativePath,
        isDirectory: stats.isDirectory(),
        size: stats.size,
        modifiedTime: stats.mtime.toISOString(),
        parentPath: parentPath === '.' ? '' : parentPath
      });
    }
  }

  /**
   * Rename file/directory and update cache
   */
  async rename(oldPath, newPath) {
    await super.rename(oldPath, newPath);
    
    if (this.initialized) {
      // Remove old path from cache
      await this.cache.removeFile(oldPath);
      
      // Add new path to cache
      const stats = await fs.stat(newPath);
      const relativePath = path.relative(this.storagePath, newPath);
      const parentPath = path.dirname(relativePath);
      
      await this.cache.addFile({
        name: path.basename(newPath),
        path: newPath,
        relativePath: relativePath,
        isDirectory: stats.isDirectory(),
        size: stats.size,
        modifiedTime: stats.mtime.toISOString(),
        parentPath: parentPath === '.' ? '' : parentPath
      });
    }
  }

  /**
   * Close cache connection
   */
  async close() {
    if (this.cache) {
      await this.cache.close();
    }
  }
}

module.exports = EnhancedFileSystem;
