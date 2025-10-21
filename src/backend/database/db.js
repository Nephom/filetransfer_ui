/**
 * Database Management System
 * Handles SQLite database initialization and migrations
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs').promises;
const { systemLogger } = require('../utils/logger');

class Database {
  constructor() {
    this.db = null;
    this.dbPath = path.join(__dirname, '../../data/app.db');
  }

  /**
   * Initialize database connection and run migrations
   * @returns {Promise<void>}
   */
  async initialize() {
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(this.dbPath);
      await fs.mkdir(dataDir, { recursive: true });

      // Open database connection
      await this.connect();

      // Run migrations
      await this.runMigrations();

      systemLogger.logSystem('INFO', 'Database initialized successfully');
    } catch (error) {
      systemLogger.logSystem('ERROR', `Database initialization failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Connect to SQLite database
   * @returns {Promise<void>}
   */
  async connect() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          reject(err);
        } else {
          systemLogger.logSystem('INFO', `Database connected at ${this.dbPath}`);
          resolve();
        }
      });
    });
  }

  /**
   * Run database migrations
   * @returns {Promise<void>}
   */
  async runMigrations() {
    // Enable foreign keys
    await this.run('PRAGMA foreign_keys = ON');

    // Create share_links table
    await this.run(`
      CREATE TABLE IF NOT EXISTS share_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shareToken TEXT UNIQUE NOT NULL,
        userId TEXT NOT NULL,
        filePath TEXT NOT NULL,
        fileName TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER,
        maxDownloads INTEGER DEFAULT 0,
        downloadCount INTEGER DEFAULT 0,
        password TEXT,
        isActive INTEGER DEFAULT 1,
        lastDownloadAt INTEGER
      )
    `);

    // Create indexes for performance
    await this.run('CREATE INDEX IF NOT EXISTS idx_share_token ON share_links(shareToken)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_user_id ON share_links(userId)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_expires_active ON share_links(expiresAt, isActive)');

    systemLogger.logSystem('INFO', 'Database migrations completed');
  }

  /**
   * Execute a SQL query
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<Object>}
   */
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) {
          reject(err);
        } else {
          resolve({ lastID: this.lastID, changes: this.changes });
        }
      });
    });
  }

  /**
   * Get single row from database
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<Object|undefined>}
   */
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  /**
   * Get all rows from database
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<Array>}
   */
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  /**
   * Close database connection
   * @returns {Promise<void>}
   */
  async close() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) {
            reject(err);
          } else {
            systemLogger.logSystem('INFO', 'Database connection closed');
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
}

// Export singleton instance
module.exports = new Database();
