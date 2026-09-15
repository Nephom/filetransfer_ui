/**
 * Configuration Management System
 * Handles loading, validation, and management of application configuration
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { systemLogger } = require('../utils/logger');

class ConfigManager {
  /**
   * Initialize configuration manager
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.defaults = {
      meta: {
        configVersion: '3.2.0'
      },

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

      auth: {
        username: 'admin',
        password: '',
        passwordHashed: false
      },

      // Security configuration
      security: {
        jwtSecret: '',
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

      maintenance: {
        tempUploadRetentionDays: 7,
        tempUploadCleanupIntervalHours: 24
      },

      logging: {
        level: 'INFO'
      },

      // Share links configuration
      shareLinks: {
        enabled: true,
        defaultExpiration: 86400, // 24 hours
        maxExpiration: 2592000, // 30 days
        allowPasswordProtection: true,
        cleanupInterval: 86400, // daily
        maxDownloadsDefault: 0 // 0 = unlimited
      },

      ai: {
        enabled: false,
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: '',
        model: 'llama3.2',
        requestTimeoutMs: 600000,
        contextWindowTokens: 32768,
        maxOutputTokens: 8192,
        maxInputBytes: 52428800,
        maxArchiveFiles: 2000,
        maxArchiveExpandedBytes: 1073741824,
        maxSingleExpandedFileBytes: 104857600,
        maxNestedArchiveDepth: 2,
        maxChunkTokens: 22000,
        chunkOverlapLines: 200,
        maxRetries: 2,
        systemPrompt: '你是一名資深測試與除錯工程師，熟悉硬體、韌體、作業系統、驅動程式、網路、儲存裝置與應用軟體。請根據使用者提供的 Log 或相關檔案內容進行嚴謹分析。你可能會收到完整檔案，也可能只會收到同一份檔案的一部分；請依據本次實際提供的內容進行判斷，不要假設未提供的內容。請擷取重要事件、保留可追溯證據、依時間順序整理、區分事實與推論、排序可能根因、提出可執行的驗證步驟，並明確說明分析範圍、信心程度與缺少的資料。請使用繁體中文輸出。'
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

    // Admin credentials are deployment secrets and only come from .env.
    // Ignore legacy auth values in config.ini so the two sources cannot drift.
    delete fileConfig.auth;

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

          if (currentSection === 'locations' && key === 'definitions') {
            try {
              config.fileSystem = config.fileSystem || {};
              config.fileSystem.locations = JSON.parse(value);
            } catch (error) {
              throw new Error('locations.definitions must be valid JSON');
            }
          } else {
            config[sectionName] = config[sectionName] || {};
            config[sectionName][key] = parsedValue;
          }
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

    // Admin credentials are deployment secrets and are intentionally not tracked.
    if (process.env.AUTH_USERNAME) {
      env.auth = env.auth || {};
      env.auth.username = process.env.AUTH_USERNAME;
    }

    if (process.env.AUTH_PASSWORD !== undefined) {
      env.auth = env.auth || {};
      env.auth.password = process.env.AUTH_PASSWORD;
    }

    if (process.env.AUTH_PASSWORD_HASHED !== undefined) {
      env.auth = env.auth || {};
      env.auth.passwordHashed = process.env.AUTH_PASSWORD_HASHED.toLowerCase() === 'true';
    }

    // Security config
    if (process.env.JWT_SECRET) {
      env.security = env.security || {};
      env.security.jwtSecret = process.env.JWT_SECRET;
    }

    if (process.env.AI_ENABLED !== undefined) {
      env.ai = env.ai || {};
      env.ai.enabled = process.env.AI_ENABLED.toLowerCase() === 'true';
    }
    for (const [name, key] of [['AI_PROVIDER', 'provider'], ['AI_BASE_URL', 'baseUrl'], ['AI_MODEL', 'model'], ['AI_API_KEY', 'apiKey']]) {
      if (process.env[name] !== undefined) {
        env.ai = env.ai || {};
        env.ai[key] = process.env[name];
      }
    }
    for (const [name, key] of [['AI_REQUEST_TIMEOUT_MS', 'requestTimeoutMs'], ['AI_MAX_OUTPUT_TOKENS', 'maxOutputTokens']]) {
      if (process.env[name] !== undefined) {
        env.ai = env.ai || {};
        env.ai[key] = parseInt(process.env[name], 10);
      }
    }

    if (process.env.SSL_HTTPS_PORT || process.env.HTTPS_PORT) {
      env.ssl = env.ssl || {};
      env.ssl.httpsPort = parseInt(process.env.SSL_HTTPS_PORT || process.env.HTTPS_PORT);
    }

    if (process.env.SSL_ENABLE_HTTPS_REDIRECT !== undefined) {
      env.ssl = env.ssl || {};
      env.ssl.enableHttpsRedirect = process.env.SSL_ENABLE_HTTPS_REDIRECT.toLowerCase() === 'true';
    }

    if (process.env.SSL_AUTO_GENERATE_CERTS !== undefined) {
      env.ssl = env.ssl || {};
      env.ssl.autoGenerateCerts = process.env.SSL_AUTO_GENERATE_CERTS.toLowerCase() === 'true';
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
    // Do not fall back to a tracked secret. A setup-generated secret is preferred;
    // direct starts receive an ephemeral secret rather than a known credential.
    if (!this.config.security.jwtSecret || this.config.security.jwtSecret.trim() === '') {
      this.config.security.jwtSecret = crypto.randomBytes(32).toString('hex');
      systemLogger.logSystem('WARN', 'JWT_SECRET is not configured; generated an ephemeral secret for this process');
    }

    // Validate transfer configuration
    if (this.config.transfer.maxConcurrentTransfers <= 0) {
      throw new Error('maxConcurrentTransfers must be positive');
    }

    if (this.config.transfer.chunkSize <= 0) {
      throw new Error('chunkSize must be positive');
    }

    if (!Number.isInteger(this.config.maintenance.tempUploadRetentionDays) || this.config.maintenance.tempUploadRetentionDays < 1) {
      throw new Error('maintenance.tempUploadRetentionDays must be a positive integer');
    }

    if (!Number.isInteger(this.config.maintenance.tempUploadCleanupIntervalHours) || this.config.maintenance.tempUploadCleanupIntervalHours < 1) {
      throw new Error('maintenance.tempUploadCleanupIntervalHours must be a positive integer');
    }

    const logLevel = String(this.config.logging.level || '').toUpperCase();
    if (!['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(logLevel)) {
      throw new Error('logging.level must be DEBUG, INFO, WARN, or ERROR');
    }
    this.config.logging.level = logLevel;

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

    const ai = this.config.ai;
    if (!ai || !['ollama', 'vllm', 'omlx', 'openai', 'custom'].includes(String(ai.provider).toLowerCase())) {
      throw new Error('ai.provider must be ollama, vllm, omlx, openai, or custom');
    }
    if (typeof ai.baseUrl !== 'string' || !/^https?:\/\//i.test(ai.baseUrl)) throw new Error('ai.baseUrl must be an HTTP(S) URL');
    for (const [key, minimum] of [['requestTimeoutMs', 1000], ['maxOutputTokens', 1], ['maxInputBytes', 1], ['maxArchiveFiles', 1], ['maxArchiveExpandedBytes', 1], ['maxSingleExpandedFileBytes', 1], ['maxChunkTokens', 100], ['maxRetries', 0]]) {
      if (!Number.isSafeInteger(ai[key]) || ai[key] < minimum) throw new Error(`ai.${key} must be a valid integer`);
    }
    if (ai.contextWindowTokens !== 32768) throw new Error('ai.contextWindowTokens is fixed at 32768');
    if (!Number.isSafeInteger(ai.maxNestedArchiveDepth) || ai.maxNestedArchiveDepth < 0 || ai.maxNestedArchiveDepth > 5) throw new Error('ai.maxNestedArchiveDepth must be between 0 and 5');
    if (!Number.isSafeInteger(ai.chunkOverlapLines) || ai.chunkOverlapLines < 0) throw new Error('ai.chunkOverlapLines must be non-negative');

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
    let tempFile;
    try {
      const configFile = this.options.configFile || './src/config.ini';
      tempFile = `${configFile}.${process.pid}.tmp`;
      let content;

      if (configFile.endsWith('.ini')) {
        // Build INI content with proper formatting and comments
        // Only include fields that should be in config.ini
        let iniContent = '# File Transfer Application Configuration\n\n';

        // [meta] section
        iniContent += '[meta]\n';
        iniContent += `configVersion=${this.config.meta?.configVersion || '3.2.0'}\n\n`;

        // [server] section
        iniContent += '[server]\n';
        iniContent += `port=${this.config.server?.port || 9400}\n`;
        iniContent += `host=${this.config.server?.host || 'localhost'}\n\n`;

        // [fileSystem] section
        iniContent += '[fileSystem]\n';
        iniContent += '# storagePath is deprecated. Configure one or more roots in [locations].\n';
        iniContent += `# storagePath=${this.config.fileSystem?.storagePath || './storage'}\n\n`;
        iniContent += '# Maximum accepted file size in bytes.\n';
        iniContent += `maxFileSize=${this.config.fileSystem?.maxFileSize ?? 1024 * 1024 * 10000}\n\n`;

        const configuredLocations = Array.isArray(this.config.fileSystem?.locations)
          ? this.config.fileSystem.locations
          : this.config.fileSystem?.storagePath
            ? [{ id: 'default', displayName: 'Default', rootPath: this.config.fileSystem.storagePath, enabled: true, readOnly: false, order: 0 }]
            : [];
        if (configuredLocations.length > 0) {
          iniContent += '[locations]\n';
          iniContent += '# Each rootPath is resolved on the server, not on the browser client.\n';
          iniContent += '# For NFS, mount the share first and use the mounted directory here.\n';
          iniContent += '# id must remain stable after users receive permissions for this Location.\n';
          iniContent += `definitions=${JSON.stringify(configuredLocations)}\n\n`;
        }

        // [maintenance] section
        iniContent += '[maintenance]\n';
        iniContent += '# Remove interrupted Multer uploads from temp/uploads after this many days.\n';
        iniContent += `tempUploadRetentionDays=${this.config.maintenance?.tempUploadRetentionDays || 7}\n`;
        iniContent += '# Run the temporary-upload cleanup at this interval, in hours.\n';
        iniContent += `tempUploadCleanupIntervalHours=${this.config.maintenance?.tempUploadCleanupIntervalHours || 24}\n\n`;

        // [logging] section
        iniContent += '[logging]\n';
        iniContent += '# DEBUG, INFO, WARN, or ERROR. INFO hides verbose DEBUG entries.\n';
        iniContent += `level=${this.config.logging?.level || 'INFO'}\n\n`;

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
        iniContent += `defaultExpiration=${this.config.shareLinks?.defaultExpiration ?? 86400}\n`;
        iniContent += `maxExpiration=${this.config.shareLinks?.maxExpiration ?? 2592000}\n`;
        iniContent += `allowPasswordProtection=${this.config.shareLinks?.allowPasswordProtection === true ? 'true' : 'false'}\n`;
        iniContent += `cleanupInterval=${this.config.shareLinks?.cleanupInterval ?? 86400}\n`;
        iniContent += `maxDownloadsDefault=${this.config.shareLinks?.maxDownloadsDefault ?? 0}\n\n`;

        iniContent += '[ai]\n';
        iniContent += `enabled=${this.config.ai?.enabled === true ? 'true' : 'false'}\n`;
        iniContent += `provider=${this.config.ai?.provider || 'ollama'}\n`;
        iniContent += `baseUrl=${this.config.ai?.baseUrl || 'http://127.0.0.1:11434/v1'}\n`;
        iniContent += `apiKey=${this.config.ai?.apiKey || ''}\n`;
        iniContent += `model=${this.config.ai?.model || 'llama3.2'}\n`;
        iniContent += `requestTimeoutMs=${this.config.ai?.requestTimeoutMs ?? 600000}\n`;
        iniContent += '# contextWindowTokens is fixed at 32768.\n';
        iniContent += `contextWindowTokens=32768\n`;
        iniContent += `maxOutputTokens=${this.config.ai?.maxOutputTokens ?? 8192}\n`;
        iniContent += `maxInputBytes=${this.config.ai?.maxInputBytes ?? 52428800}\n`;
        iniContent += `maxArchiveFiles=${this.config.ai?.maxArchiveFiles ?? 2000}\n`;
        iniContent += `maxArchiveExpandedBytes=${this.config.ai?.maxArchiveExpandedBytes ?? 1073741824}\n`;
        iniContent += `maxSingleExpandedFileBytes=${this.config.ai?.maxSingleExpandedFileBytes ?? 104857600}\n`;
        iniContent += `maxNestedArchiveDepth=${this.config.ai?.maxNestedArchiveDepth ?? 2}\n`;
        iniContent += `maxChunkTokens=${this.config.ai?.maxChunkTokens ?? 22000}\n`;
        iniContent += `chunkOverlapLines=${this.config.ai?.chunkOverlapLines ?? 200}\n`;
        iniContent += `maxRetries=${this.config.ai?.maxRetries ?? 2}\n`;
        iniContent += `systemPrompt=${this.config.ai?.systemPrompt || ''}\n\n`;

        // [ssl] section
        iniContent += '[ssl]\n';
        iniContent += '# SSL/TLS configuration\n';
        iniContent += '# HTTPS server port (default: 9443)\n';
        iniContent += `httpsPort=${this.config.ssl?.httpsPort || 9443}\n`;
        iniContent += '# Enable HTTP to HTTPS redirect (default: true)\n';
        iniContent += `enableHttpsRedirect=${this.config.ssl?.enableHttpsRedirect === true ? 'true' : 'false'}\n`;
        iniContent += '# Automatically generate certificates on first run (default: false)\n';
        iniContent += `autoGenerateCerts=${this.config.ssl?.autoGenerateCerts === true ? 'true' : 'false'}\n`;

        content = iniContent;
      } else {
        // Save as JSON
        content = JSON.stringify(this.config, null, 2);
      }

      await fs.writeFile(tempFile, content, 'utf8');
      await fs.rename(tempFile, configFile);

      systemLogger.logSystem('INFO', `Configuration saved to ${configFile}`);
    } catch (error) {
      if (tempFile) await fs.rm(tempFile, { force: true }).catch(() => {});
      systemLogger.logSystem('ERROR', `Error saving configuration: ${error.message}`);
      throw new Error('Failed to save configuration');
    }
  }

  /**
   * Update deployment-managed Admin credentials in .env.
   * @param {{username?: string, password?: string, passwordHashed?: boolean}} credentials
   */
  async updateAdminCredentials(credentials) {
    const envPath = path.resolve(this.options.envFile || '.env');
    let content = '';
    try {
      content = await fs.readFile(envPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const updates = Object.entries(credentials)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [`AUTH_${key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}`, value]);
    for (const [key, value] of updates) {
      const serialized = JSON.stringify(String(value));
      const expression = new RegExp(`^${key}=.*$`, 'm');
      const line = `${key}=${serialized}`;
      content = expression.test(content) ? content.replace(expression, line) : `${content}${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`;
      process.env[key] = String(value);
    }

    await fs.writeFile(envPath, content, { mode: 0o600 });
    await fs.chmod(envPath, 0o600);
    for (const [key, value] of updates) {
      const configKey = key === 'AUTH_USERNAME' ? 'auth.username' : key === 'AUTH_PASSWORD' ? 'auth.password' : 'auth.passwordHashed';
      this.set(configKey, key === 'AUTH_PASSWORD_HASHED' ? String(value).toLowerCase() === 'true' : value);
    }
  }
}

module.exports = new ConfigManager();
