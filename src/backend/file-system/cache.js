/**
 * DEPRECATED: File System Cache Manager using SQLite
 * DEPRECATED: This file is no longer used - replaced by memory-cache.js (Redis)
 * TODO: Remove this file after confirming no dependencies
 */

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs').promises;
const path = require('path');

class FileSystemCache {
  constructor(dbPath = './filesystem_cache.db') {
    this.dbPath = dbPath;
    this.db = null;
  }

  /**
   * Initialize the database and create tables
   */
  async initialize() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          reject(err);
          return;
        }
        
        // Create files table
        this.db.run(`
          CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            relative_path TEXT NOT NULL,
            is_directory BOOLEAN NOT NULL,
            size INTEGER DEFAULT 0,
            modified_time TEXT,
            created_time TEXT DEFAULT CURRENT_TIMESTAMP,
            parent_path TEXT
          )
        `, (err) => {
          if (err) {
            reject(err);
            return;
          }

          // Create indexes separately
          const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_files_name ON files(name)',
            'CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)',
            'CREATE INDEX IF NOT EXISTS idx_files_relative_path ON files(relative_path)',
            'CREATE INDEX IF NOT EXISTS idx_files_parent_path ON files(parent_path)',
            'CREATE INDEX IF NOT EXISTS idx_files_is_directory ON files(is_directory)'
          ];

          let indexCount = 0;
          const createNextIndex = () => {
            if (indexCount >= indexes.length) {
              resolve();
              return;
            }

            this.db.run(indexes[indexCount], (indexErr) => {
              if (indexErr) {
                console.warn('Warning: Could not create index:', indexErr.message);
              }
              indexCount++;
              createNextIndex();
            });
          };

          createNextIndex();
        });
      });
    });
  }

  /**
   * Scan and cache the entire file system
   */
  async scanAndCache(storagePath) {
    console.log('Scanning file system for cache...');
    
    // Clear existing cache
    await this.clearCache();
    
    // Recursively scan directories
    await this._scanDirectory(storagePath, storagePath);
    
    console.log('File system cache updated successfully');
  }

  /**
   * Recursively scan a directory and add to cache
   */
  async _scanDirectory(dirPath, basePath, parentPath = '') {
    try {
      const items = await fs.readdir(dirPath);
      
      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const relativePath = path.relative(basePath, itemPath);
        
        try {
          const stats = await fs.stat(itemPath);
          
          await this.addFile({
            name: item,
            path: itemPath,
            relativePath: relativePath,
            isDirectory: stats.isDirectory(),
            size: stats.size,
            modifiedTime: stats.mtime.toISOString(),
            parentPath: parentPath
          });
          
          // If it's a directory, scan recursively
          if (stats.isDirectory()) {
            await this._scanDirectory(itemPath, basePath, relativePath);
          }
        } catch (statError) {
          console.error('Error getting stats for:', itemPath, statError);
        }
      }
    } catch (error) {
      console.error('Error scanning directory:', dirPath, error);
    }
  }

  /**
   * Add a file to the cache
   */
  async addFile(fileInfo) {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO files 
        (name, path, relative_path, is_directory, size, modified_time, parent_path)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      
      stmt.run([
        fileInfo.name,
        fileInfo.path,
        fileInfo.relativePath,
        fileInfo.isDirectory ? 1 : 0,
        fileInfo.size,
        fileInfo.modifiedTime,
        fileInfo.parentPath
      ], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
      
      stmt.finalize();
    });
  }

  /**
   * Remove a file from cache
   */
  async removeFile(filePath) {
    return new Promise((resolve, reject) => {
      this.db.run('DELETE FROM files WHERE path = ? OR path LIKE ?', 
        [filePath, filePath + '/%'], 
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes);
          }
        }
      );
    });
  }

  /**
   * Search files by name (supports partial matching)
   */
  async searchFiles(query) {
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT name, relative_path as path, is_directory, size, modified_time
        FROM files 
        WHERE name LIKE ? 
        ORDER BY is_directory DESC, name ASC
      `;
      
      this.db.all(sql, [`%${query}%`], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const results = rows.map(row => ({
            name: row.name,
            path: row.path,
            isDirectory: Boolean(row.is_directory),
            size: row.size,
            modified: row.modified_time
          }));
          resolve(results);
        }
      });
    });
  }

  /**
   * Get files in a specific directory
   */
  async getFilesInDirectory(dirPath = '') {
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT name, relative_path as path, is_directory, size, modified_time
        FROM files 
        WHERE parent_path = ?
        ORDER BY is_directory DESC, name ASC
      `;
      
      this.db.all(sql, [dirPath], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const results = rows.map(row => ({
            name: row.name,
            path: row.path,
            isDirectory: Boolean(row.is_directory),
            size: row.size,
            modified: row.modified_time
          }));
          resolve(results);
        }
      });
    });
  }

  /**
   * Clear all cache
   */
  async clearCache() {
    return new Promise((resolve, reject) => {
      this.db.run('DELETE FROM files', (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Update file in cache after modification
   */
  async updateFile(filePath, updates) {
    return new Promise((resolve, reject) => {
      const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
      const values = Object.values(updates);
      values.push(filePath);
      
      this.db.run(`UPDATE files SET ${setClause} WHERE path = ?`, values, function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });
    });
  }

  /**
   * Close database connection
   */
  async close() {
    return new Promise((resolve) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) {
            console.error('Error closing database:', err);
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = FileSystemCache;
