/**
 * Configuration Management System
 * Handles loading, validation, and management of application configuration
 */

const fs = require('fs').promises;
const path = require('path');

class ConfigManager {
  /**
   * Initialize configuration manager
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.defaults = {
      // File system configuration
      fileSystem: {
        type: 'local',
        storagePath: './storage',
        maxFileSize: 1024 * 1024 * 100 // 100MB default
      },

      // Server configuration
      server: {
        port: 3000,
        host: 'localhost',
        ssl: false
      },

      // Security configuration
      security: {
        jwtSecret: 'your-secret-key-here',
        sessionTimeout: 3600, // 1 hour
        rateLimit: {
          maxAttempts: 5,
          windowMs: 15 * 60 * 1000 // 15 minutes
        }
      },

      // Transfer configuration
      transfer: {
        maxConcurrentTransfers: 3,
        chunkSize: 1024 * 1024, // 1MB chunks
        enableResume: true
      }
    };

    this.config = {};
    this.options = options;
  }

  /**
   * Load configuration from various sources
   * @returns {Promise<Object>} Loaded configuration
   */
  async load() {
    // Load from environment variables first (highest priority)
    const envConfig = this._loadFromEnvironment();

    // Load from config file if it exists
    let fileConfig = {};
    try {
      const configFile = this.options.configFile || './src/config.ini';
      const configContent = await fs.readFile(configFile, 'utf8');

      // Check if it's an INI file
      if (configFile.endsWith('.ini')) {
        fileConfig = this._parseIniFile(configContent);
      } else {
        fileConfig = JSON.parse(configContent);
      }
    } catch (error) {
      // If no config file, continue with defaults
      console.warn('No config file found, using defaults');
    }

    // Merge configurations with priority: env > file > defaults
    this.config = this._mergeConfig(this.defaults, fileConfig, envConfig);

    // Validate configuration
    await this._validate();

    return this.config;
  }

  /**
   * Parse INI file content
   * @private
   * @param {string} content - INI file content
   * @returns {Object} Parsed configuration
   */
  _parseIniFile(content) {
    const config = {};
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Skip empty lines and comments
      if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.startsWith(';')) {
        continue;
      }

      // Parse key=value pairs
      const equalIndex = trimmedLine.indexOf('=');
      if (equalIndex > 0) {
        const key = trimmedLine.substring(0, equalIndex).trim();
        const value = trimmedLine.substring(equalIndex + 1).trim();

        // Convert to appropriate type
        let parsedValue = value;
        if (value.toLowerCase() === 'true') {
          parsedValue = true;
        } else if (value.toLowerCase() === 'false') {
          parsedValue = false;
        } else if (!isNaN(value) && !isNaN(parseFloat(value))) {
          parsedValue = parseFloat(value);
        }

        // Map INI keys to nested config structure
        if (key === 'port') {
          config.server = config.server || {};
          config.server.port = parsedValue;
        } else if (key === 'storagePath') {
          config.fileSystem = config.fileSystem || {};
          config.fileSystem.storagePath = parsedValue;
        } else if (key === 'username' || key === 'password') {
          config.auth = config.auth || {};
          config.auth[key] = parsedValue;
        } else {
          config[key] = parsedValue;
        }
      }
    }

    return config;
  }

  /**
   * Load configuration from environment variables
   * @private
   */
  _loadFromEnvironment() {
    const env = {};

    // File system config
    if (process.env.FILESYSTEM_STORAGE_PATH) {
      env.fileSystem = env.fileSystem || {};
      env.fileSystem.storagePath = process.env.FILESYSTEM_STORAGE_PATH;
    }

    if (process.env.MAX_FILE_SIZE) {
      env.fileSystem = env.fileSystem || {};
      env.fileSystem.maxFileSize = parseInt(process.env.MAX_FILE_SIZE);
    }

    // Server config
    if (process.env.SERVER_PORT) {
      env.server = env.server || {};
      env.server.port = parseInt(process.env.SERVER_PORT);
    }

    if (process.env.SERVER_HOST) {
      env.server = env.server || {};
      env.server.host = process.env.SERVER_HOST;
    }

    // Security config
    if (process.env.JWT_SECRET) {
      env.security = env.security || {};
      env.security.jwtSecret = process.env.JWT_SECRET;
    }

    return env;
  }

  /**
   * Merge configuration objects with proper hierarchy
   * @private
   */
  _mergeConfig(...configs) {
    const result = {};

    for (const config of configs) {
      for (const [key, value] of Object.entries(config)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          result[key] = this._mergeConfig(result[key] || {}, value);
        } else {
          result[key] = value;
        }
      }
    }

    return result;
  }

  /**
   * Validate configuration values
   * @private
   */
  async _validate() {
    // Validate file system configuration
    if (this.config.fileSystem.maxFileSize <= 0) {
      throw new Error('maxFileSize must be positive');
    }

    // Validate server configuration
    if (this.config.server.port <= 0 || this.config.server.port > 65535) {
      throw new Error('server.port must be between 1 and 65535');
    }

    // Validate security configuration
    if (!this.config.security.jwtSecret) {
      throw new Error('jwtSecret is required');
    }

    // Validate transfer configuration
    if (this.config.transfer.maxConcurrentTransfers <= 0) {
      throw new Error('maxConcurrentTransfers must be positive');
    }

    if (this.config.transfer.chunkSize <= 0) {
      throw new Error('chunkSize must be positive');
    }

    // Validate file system storage path exists
    try {
      await fs.access(this.config.fileSystem.storagePath);
    } catch (error) {
      // If storage path doesn't exist, create it
      await fs.mkdir(this.config.fileSystem.storagePath, { recursive: true });
    }
  }

  /**
   * Get a configuration value
   * @param {string} key - Configuration key (dot notation)
   * @returns {*} Configuration value
   */
  get(key) {
    const keys = key.split('.');
    let result = this.config;

    for (const k of keys) {
      if (result && typeof result === 'object') {
        result = result[k];
      } else {
        return undefined;
      }
    }

    return result;
  }

  /**
   * Set a configuration value
   * @param {string} key - Configuration key (dot notation)
   * @param {*} value - Value to set
   */
  set(key, value) {
    const keys = key.split('.');
    let target = this.config;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!target[k] || typeof target[k] !== 'object') {
        target[k] = {};
      }
      target = target[k];
    }

    target[keys[keys.length - 1]] = value;
  }

  /**
   * Reload configuration
   * @returns {Promise<Object>} Reloaded configuration
   */
  async reload() {
    return await this.load();
  }

  /**
   * Get current configuration
   * @returns {Object} Current configuration
   */
  getConfig() {
    return this.config;
  }

  /**
   * Save current configuration to file
   * @returns {Promise<void>}
   */
  async save() {
    try {
      const configFile = this.options.configFile || './src/config.ini';

      if (configFile.endsWith('.ini')) {
        // Convert config object to INI format
        let iniContent = '';

        for (const [section, values] of Object.entries(this.config)) {
          if (typeof values === 'object' && values !== null) {
            iniContent += `[${section}]\n`;
            for (const [key, value] of Object.entries(values)) {
              iniContent += `${key}=${value}\n`;
            }
            iniContent += '\n';
          }
        }

        await fs.writeFile(configFile, iniContent.trim(), 'utf8');
      } else {
        // Save as JSON
        await fs.writeFile(configFile, JSON.stringify(this.config, null, 2), 'utf8');
      }

      console.log('Configuration saved to', configFile);
    } catch (error) {
      console.error('Error saving configuration:', error);
      throw new Error('Failed to save configuration');
    }
  }
}

module.exports = ConfigManager;