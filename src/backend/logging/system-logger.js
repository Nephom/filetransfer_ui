// Comprehensive system logger for file transfer application
const fs = require('fs').promises;
const path = require('path');

class SystemLogger {
  constructor(config = null) {
    this.config = config;
    this.logLevels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3
    };
  }

  /**
   * Get real IP address from request, considering proxies
   */
  getRealIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           req.connection?.socket?.remoteAddress ||
           req.ip ||
           'unknown';
  }

  /**
   * Get user identifier from request
   */
  getUserIdentifier(req) {
    if (req.user && req.user.username) {
      return req.user.username;
    }
    if (req.headers.authorization) {
      return 'authenticated_user';
    }
    return 'anonymous';
  }

  /**
   * Format log entry with consistent structure
   */
  formatLogEntry(level, category, message, details = {}, req = null) {
    const timestamp = new Date().toISOString();
    
    const logEntry = {
      timestamp,
      level,
      category,
      message,
      ...details
    };

    // Add request-specific information if available
    if (req) {
      logEntry.ip = this.getRealIP(req);
      logEntry.user = this.getUserIdentifier(req);
      logEntry.userAgent = req.get('User-Agent') || 'unknown';
      
      if (req.method && req.path) {
        logEntry.request = {
          method: req.method,
          path: req.path,
          query: req.query || {},
          headers: this.sanitizeHeaders(req.headers)
        };
      }
    }

    return logEntry;
  }

  /**
   * Sanitize headers to remove sensitive information
   */
  sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    delete sanitized.authorization;
    delete sanitized.cookie;
    delete sanitized['x-api-key'];
    return sanitized;
  }

  /**
   * Check if logging is enabled for this level and category
   */
  shouldLog(level, category) {
    if (!this.config) return true;
    
    const enableDetailedLogging = this.config.get('logging.enableDetailedLogging') !== false;
    if (!enableDetailedLogging) return level === 'error';

    const configLevel = this.config.get('logging.logLevel') || 'info';
    const configLevelNum = this.logLevels[configLevel] || this.logLevels.info;
    const currentLevelNum = this.logLevels[level] || this.logLevels.info;

    // Check category-specific settings
    const categoryEnabled = this.config.get(`logging.log${category.charAt(0).toUpperCase() + category.slice(1)}`) !== false;
    
    return currentLevelNum <= configLevelNum && categoryEnabled;
  }

  /**
   * Core logging method
   */
  log(level, category, message, details = {}, req = null) {
    if (!this.shouldLog(level, category)) return;

    const logEntry = this.formatLogEntry(level, category, message, details, req);
    const logString = JSON.stringify(logEntry, null, 2);

    // Console output with color coding
    const colors = {
      error: '\x1b[31m', // Red
      warn: '\x1b[33m',  // Yellow
      info: '\x1b[36m',  // Cyan
      debug: '\x1b[90m'  // Gray
    };
    
    const categoryIcons = {
      request: '🌐',
      file: '📁',
      security: '🔒',
      performance: '⚡',
      system: '🔧'
    };

    const color = colors[level] || '';
    const icon = categoryIcons[category] || '📋';
    const reset = '\x1b[0m';
    
    console.log(`${color}${icon} [${level.toUpperCase()}] ${category.toUpperCase()}${reset}: ${logString}`);

    // Write to log file
    this.writeToFile(logString);
  }

  /**
   * Asynchronously writes a log string to the system log file.
   * Ensures the log directory exists before writing.
   */
  async writeToFile(logString) {
    try {
      // Correctly resolve the project's root directory to place the 'logs' folder.
      const logDir = path.join(__dirname, '..', '..', '..', 'logs');
      const logFile = path.join(logDir, 'system.log');

      // Ensure log directory exists. The { recursive: true } option prevents errors if the directory already exists.
      await fs.mkdir(logDir, { recursive: true });

      // Append the JSON log string to the file, followed by a newline for better readability.
      await fs.appendFile(logFile, logString + '\n', 'utf8');
    } catch (error) {
      // If logging to the file fails for any reason (e.g., permissions), log this critical error to the console.
      console.error('CRITICAL: Failed to write to log file:', error);
    }
  }

  /**
   * Log HTTP requests with detailed information
   */
  logRequest(req, res, metadata = {}) {
    const startTime = metadata.startTime || Date.now();
    const duration = Date.now() - startTime;
    
    const details = {
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      responseSize: res.get('Content-Length') || 'unknown',
      ...metadata
    };

    const level = res.statusCode >= 400 ? 'error' : 'info';
    const message = `${req.method} ${req.path} - ${res.statusCode}`;
    
    this.log(level, 'request', message, details, req);
  }

  /**
   * Log file operations
   */
  logFileOperation(operation, user, filePath, result, metadata = {}) {
    const details = {
      operation,
      user,
      filePath,
      result: result.success || false,
      ...metadata
    };

    if (result.error) {
      details.error = result.error.message || result.error;
    }

    if (result.fileSize) {
      details.fileSize = result.fileSize;
    }

    const level = result.success ? 'info' : 'error';
    const message = `File ${operation}: ${filePath}`;
    
    this.log(level, 'file', message, details);
  }

  /**
   * Log security events
   */
  logSecurityEvent(event, details = {}, req = null) {
    const message = `Security Event: ${event}`;
    this.log('warn', 'security', message, { event, ...details }, req);
  }

  /**
   * Log performance metrics
   */
  logPerformance(operation, duration, metadata = {}) {
    const details = {
      operation,
      duration: typeof duration === 'number' ? `${duration}ms` : duration,
      ...metadata
    };

    const level = duration > 5000 ? 'warn' : 'info'; // Warn if operation takes > 5s
    const message = `Performance: ${operation}`;
    
    this.log(level, 'performance', message, details);
  }

  /**
   * Log authentication events
   */
  logAuth(event, username, success, details = {}, req = null) {
    const authDetails = {
      event,
      username,
      success,
      timestamp: new Date().toISOString(),
      ...details
    };

    const level = success ? 'info' : 'warn';
    const message = `Auth ${event}: ${username} - ${success ? 'Success' : 'Failed'}`;
    
    this.log(level, 'security', message, authDetails, req);
  }

  /**
   * Create enhanced request logger middleware
   */
  createRequestMiddleware() {
    return (req, res, next) => {
      const startTime = Date.now();
      
      // Log incoming request
      this.log('debug', 'request', `Incoming: ${req.method} ${req.path}`, {
        query: req.query,
        bodySize: req.get('Content-Length') || 'unknown'
      }, req);

      // Capture response
      res.on('finish', () => {
        this.logRequest(req, res, { startTime });
      });

      next();
    };
  }
}

module.exports = SystemLogger;