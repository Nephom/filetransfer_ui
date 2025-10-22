/**
 * Configuration Management System
 * Handles loading, validation, and management of application configuration
 */

const fs = require('fs').promises;
const path = require('path');
const { systemLogger } = require('../utils/logger');

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
        maxFileSize: 1024 * 1024 * 10000 // 10 GB default
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
      },

      // Share links configuration
      shareLinks: {
        enabled: true,
        defaultExpiration: 86400, // 24 hours
        maxExpiration: 2592000, // 30 days
        allowPasswordProtection: true,
        cleanupInterval: 86400, // daily
        maxDownloadsDefault: 0 // 0 = unlimited
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
      systemLogger.logSystem('WARN', 'No config file found, using defaults');
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
    let currentSection = null;

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Skip empty lines and comments
      if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.startsWith(';')) {
        continue;
      }

      // Check for section headers [sectionName]
      if (trimmedLine.startsWith('[') && trimmedLine.endsWith(']')) {
        currentSection = trimmedLine.substring(1, trimmedLine.length - 1).trim();
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

        // Handle section-based or legacy flat keys
        if (currentSection) {
          // Map section names to config structure
          let sectionName = currentSection;

          // Handle special section name mappings
          if (currentSection === 'fileSystem') {
            sectionName = 'fileSystem';
          } else if (currentSection === 'server') {
            sectionName = 'server';
          } else if (currentSection === 'auth') {
            sectionName = 'auth';
          } else if (currentSection === 'security') {
            sectionName = 'security';
          } else if (currentSection === 'shareLinks') {
            sectionName = 'shareLinks';
          } else if (currentSection === 'ssl') {
            sectionName = 'ssl';
          }

          config[sectionName] = config[sectionName] || {};
          config[sectionName][key] = parsedValue;
        } else {
          // Legacy flat keys (backwards compatibility)
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
    // jwtSecret can be empty in config file, will use default value
    if (!this.config.security.jwtSecret || this.config.security.jwtSecret.trim() === '') {
      this.config.security.jwtSecret = 'your-secret-key-here';
    }

    // Validate transfer configuration
    if (this.config.transfer.maxConcurrentTransfers <= 0) {
      throw new Error('maxConcurrentTransfers must be positive');
    }

    if (this.config.transfer.chunkSize <= 0) {
      throw new Error('chunkSize must be positive');
    }

    // Validate share links configuration
    if (this.config.shareLinks) {
      if (this.config.shareLinks.defaultExpiration <= 0) {
        throw new Error('shareLinks.defaultExpiration must be positive');
      }

      if (this.config.shareLinks.maxExpiration <= 0) {
        throw new Error('shareLinks.maxExpiration must be positive');
      }

      if (this.config.shareLinks.defaultExpiration > this.config.shareLinks.maxExpiration) {
        throw new Error('shareLinks.defaultExpiration cannot exceed shareLinks.maxExpiration');
      }

      if (this.config.shareLinks.cleanupInterval <= 0) {
        throw new Error('shareLinks.cleanupInterval must be positive');
      }

      if (this.config.shareLinks.maxDownloadsDefault < 0) {
        throw new Error('shareLinks.maxDownloadsDefault must be non-negative (0 = unlimited)');
      }
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
        // Build INI content with proper formatting and comments
        // Only include fields that should be in config.ini
        let iniContent = '# File Transfer Application Configuration\n\n';

        // [server] section
        iniContent += '[server]\n';
        iniContent += `port=${this.config.server?.port || 9400}\n\n`;

        // [fileSystem] section
        iniContent += '[fileSystem]\n';
        iniContent += '# Storage path for files - can be relative or absolute path\n';
        iniContent += '# Examples:\n';
        iniContent += '#   storagePath=./storage                    (relative path, default)\n';
        iniContent += '#   storagePath=/home/user/myfiles          (absolute path on Linux/Mac)\n';
        iniContent += '#   storagePath=C:\\Users\\User\\Documents     (absolute path on Windows)\n';
        iniContent += `storagePath=${this.config.fileSystem?.storagePath || './storage'}\n\n`;

        // [auth] section
        iniContent += '[auth]\n';
        iniContent += `username=${this.config.auth?.username || 'admin'}\n`;
        iniContent += `password=${this.config.auth?.password || 'password'}\n`;
        iniContent += `passwordHashed=${this.config.auth?.passwordHashed || false}\n\n`;

        // [security] section
        iniContent += '[security]\n';
        iniContent += '# Security features (true/false)\n';
        iniContent += '# Only authentication and data transmission security are always enabled\n';
        iniContent += `enableRateLimit=${this.config.security?.enableRateLimit === true ? 'true' : 'false'}\n`;
        iniContent += `enableSecurityHeaders=${this.config.security?.enableSecurityHeaders === true ? 'true' : 'false'}\n`;
        iniContent += `enableInputValidation=${this.config.security?.enableInputValidation === true ? 'true' : 'false'}\n`;
        iniContent += `enableFileUploadSecurity=${this.config.security?.enableFileUploadSecurity === true ? 'true' : 'false'}\n`;
        iniContent += `enableRequestLogging=${this.config.security?.enableRequestLogging === true ? 'true' : 'false'}\n\n`;
        iniContent += '# CSP (Content Security Policy) - set to false for development\n';
        iniContent += `enableCSP=${this.config.security?.enableCSP === true ? 'true' : 'false'}\n\n`;
        iniContent += '# JWT Secret (leave empty to use default)\n';
        iniContent += `jwtSecret=${this.config.security?.jwtSecret || ''}\n\n`;

        // [shareLinks] section
        iniContent += '[shareLinks]\n';
        iniContent += '# Share link feature configuration\n';
        iniContent += `enabled=${this.config.shareLinks?.enabled === true ? 'true' : 'false'}\n`;
        iniContent += `defaultExpiration=${this.config.shareLinks?.defaultExpiration || 86400}\n`;
        iniContent += `maxExpiration=${this.config.shareLinks?.maxExpiration || 2592000}\n`;
        iniContent += `allowPasswordProtection=${this.config.shareLinks?.allowPasswordProtection === true ? 'true' : 'false'}\n`;
        iniContent += `cleanupInterval=${this.config.shareLinks?.cleanupInterval || 86400}\n`;
        iniContent += `maxDownloadsDefault=${this.config.shareLinks?.maxDownloadsDefault || 0}\n\n`;

        // [ssl] section
        iniContent += '[ssl]\n';
        iniContent += '# SSL/TLS configuration\n';
        iniContent += '# HTTPS server port (default: 9443)\n';
        iniContent += `httpsPort=${this.config.ssl?.httpsPort || 9443}\n`;
        iniContent += '# Enable HTTP to HTTPS redirect (default: true)\n';
        iniContent += `enableHttpsRedirect=${this.config.ssl?.enableHttpsRedirect === true ? 'true' : 'false'}\n`;
        iniContent += '# Automatically generate certificates on first run (default: false)\n';
        iniContent += `autoGenerateCerts=${this.config.ssl?.autoGenerateCerts === true ? 'true' : 'false'}\n`;

        await fs.writeFile(configFile, iniContent, 'utf8');
      } else {
        // Save as JSON
        await fs.writeFile(configFile, JSON.stringify(this.config, null, 2), 'utf8');
      }

      systemLogger.logSystem('INFO', `Configuration saved to ${configFile}`);
    } catch (error) {
      systemLogger.logSystem('ERROR', `Error saving configuration: ${error.message}`);
      throw new Error('Failed to save configuration');
    }
  }
}

module.exports = new ConfigManager();
