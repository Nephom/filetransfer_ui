const fs = require('fs').promises;
const path = require('path');

// Create logs directory if it doesn't exist (for IP-specific logs)
const logsDir = path.join(__dirname, '../../../logs');
fs.mkdir(logsDir, { recursive: true }).catch(console.error);

// Server log is in root directory (used by start.sh/status.sh/stop.sh)
const serverLogFile = path.join(__dirname, '../../../server.log');

class SystemLogger {
  constructor() {
    this.logsDir = logsDir;
    this.serverLogFile = serverLogFile;
  }

  // Get client IPv4 address from request
  getClientIP(req) {
    if (!req) return 'system';

    // Safety check: ensure req has headers property
    if (!req.headers) {
      // If req doesn't have headers, it's likely a metadata object (e.g., { user })
      // Return 'system' or extract username if available
      if (req.user && req.user.username) {
        return `user:${req.user.username}`;
      }
      return 'system';
    }

    let ip = req.headers['x-forwarded-for'] ||
             req.headers['x-real-ip'] ||
             req.connection?.remoteAddress ||
             req.socket?.remoteAddress ||
             (req.connection?.socket ? req.connection.socket.remoteAddress : null) ||
             'unknown';

    // Extract IPv4 from IPv6-mapped IPv4 (::ffff:192.168.1.1 -> 192.168.1.1)
    if (ip.includes('::ffff:')) {
      ip = ip.replace('::ffff:', '');
    }

    // Remove port if present (192.168.1.1:12345 -> 192.168.1.1)
    if (ip.includes(':') && !ip.includes('::')) {
      ip = ip.split(':')[0];
    }

    return ip;
  }

  // Format date for log entries (using system timezone)
  getFormattedDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  // Log to IP-specific file (user operations)
  async logToIPFile(ip, level, message, req = null) {
    try {
      const sanitizedIP = ip.replace(/[:.]/g, '_'); // Sanitize IP for filename
      const logFile = path.join(this.logsDir, `${sanitizedIP}.log`);

      let logEntry = `[${this.getFormattedDate()}] [${level}] ${message}`;

      // Add request details if available
      if (req) {
        // Only add URL if req has method and originalUrl (full Express request)
        if (req.method && req.originalUrl) {
          logEntry += ` | URL: ${req.method} ${req.originalUrl}`;
        }

        // Only add user agent if req has headers (full Express request)
        if (req.headers && req.headers['user-agent']) {
          const userAgent = req.headers['user-agent'];
          if (userAgent !== 'unknown') {
            logEntry += ` | User-Agent: ${userAgent.substring(0, 100)}`; // Truncate long user agents
          }
        }

        // Add user info if available
        if (req.user) {
          logEntry += ` | User: ${req.user.username}`;
          if (req.user.role) {
            logEntry += ` (${req.user.role})`;
          }
        }
      }

      logEntry += '\n';

      await fs.appendFile(logFile, logEntry);
    } catch (error) {
      console.error('Failed to write IP log file:', error);
    }
  }

  // Log to server.log (system events only)
  async logToServerFile(level, message) {
    try {
      const logEntry = `[${this.getFormattedDate()}] [${level}] ${message}\n`;
      await fs.appendFile(this.serverLogFile, logEntry);
    } catch (error) {
      console.error('Failed to write server log file:', error);
    }
  }

  // Log system events (server.log only)
  async logSystem(level, message) {
    await this.logToServerFile(level, message);
    // Also output to console for immediate visibility
    const prefix = level === 'ERROR' ? '❌' : level === 'WARN' ? '⚠️' : 'ℹ️';
    console.log(`${prefix} [SYSTEM] ${message}`);
  }

  // Log authentication events (IP-specific log only)
  async logAuth(event, username, success, details = null, req = null) {
    const ip = this.getClientIP(req);
    const status = success ? 'SUCCESS' : 'FAILED';
    let message = `AUTH ${event.toUpperCase()} - User: ${username}, Status: ${status}`;

    if (details) {
      message += `, Details: ${JSON.stringify(details)}`;
    }

    await this.logToIPFile(ip, success ? 'INFO' : 'WARN', message, req);
  }

  // Log API operations (IP-specific log only)
  async logAPI(operation, resource, success, req = null, details = null) {
    const ip = this.getClientIP(req);
    const status = success ? 'SUCCESS' : 'FAILED';
    let message = `API ${operation.toUpperCase()} - Resource: ${resource}, Status: ${status}`;

    if (details) {
      message += `, Details: ${JSON.stringify(details)}`;
    }

    await this.logToIPFile(ip, success ? 'INFO' : 'WARN', message, req);
  }

  // Log file operations (IP-specific log only)
  async logFileOperation(operation, filePath, success, req = null, details = null) {
    const ip = this.getClientIP(req);
    const status = success ? 'SUCCESS' : 'FAILED';
    let message = `FILE ${operation.toUpperCase()} - Path: ${filePath}, Status: ${status}`;

    if (details) {
      message += `, Details: ${JSON.stringify(details)}`;
    }

    await this.logToIPFile(ip, success ? 'INFO' : 'WARN', message, req);
  }

  // Log general user events (IP-specific log only)
  async log(level, message, req = null) {
    const ip = req ? this.getClientIP(req) : 'system';

    if (ip === 'system') {
      // System events go to server.log
      await this.logSystem(level, message);
    } else {
      // User operations go to IP log
      await this.logToIPFile(ip, level, message, req);
    }
  }

  // Log error (both IP-specific and server.log for system errors)
  async logError(message, req = null) {
    const ip = req ? this.getClientIP(req) : 'system';

    if (ip === 'system') {
      // System errors go to server.log
      await this.logSystem('ERROR', message);
    } else {
      // User errors go to IP log
      await this.logToIPFile(ip, 'ERROR', message, req);
    }
  }

  // Log user session start
  async logSessionStart(username, req) {
    const ip = this.getClientIP(req);
    const message = `SESSION START - User: ${username}, IP: ${ip}`;
    await this.logToIPFile(ip, 'INFO', message, req);
  }

  // Log user session end
  async logSessionEnd(username, req) {
    const ip = this.getClientIP(req);
    const message = `SESSION END - User: ${username}, IP: ${ip}`;
    await this.logToIPFile(ip, 'INFO', message, req);
  }

  // Log cache operations (IP-specific if from user request)
  async logCacheOperation(operation, details, req = null) {
    if (req) {
      const ip = this.getClientIP(req);
      const message = `CACHE ${operation.toUpperCase()} - ${JSON.stringify(details)}`;
      await this.logToIPFile(ip, 'INFO', message, req);
    }
  }

  // Log security events (IP-specific)
  async logSecurity(event, details, req) {
    const ip = this.getClientIP(req);
    const message = `SECURITY ${event.toUpperCase()} - ${JSON.stringify(details)}`;
    await this.logToIPFile(ip, 'WARN', message, req);
  }

  // Log file upload operations (IP-specific)
  async logUpload(fileName, success, req, details = null) {
    const ip = this.getClientIP(req);
    const status = success ? 'SUCCESS' : 'FAILED';
    let message = `UPLOAD - File: ${fileName}, Status: ${status}`;

    if (details) {
      if (details.transferId) {
        message += `, TransferID: ${details.transferId}`;
      }
      if (details.batchId) {
        message += `, BatchID: ${details.batchId}`;
      }
      if (details.size !== undefined) {
        message += `, Size: ${details.size} bytes`;
      }
      if (details.error) {
        message += `, Error: ${details.error}`;
      }
    }

    await this.logToIPFile(ip, success ? 'INFO' : 'WARN', message, req);
  }

  // Log file download operations (IP-specific)
  async logDownload(fileName, downloadType, success, req, details = null) {
    const ip = this.getClientIP(req);
    const status = success ? 'SUCCESS' : 'FAILED';
    let message = `DOWNLOAD - File: ${fileName}, Type: ${downloadType}, Status: ${status}`;

    if (details) {
      if (details.size !== undefined) {
        message += `, Size: ${details.size} bytes`;
      }
      if (details.shareToken) {
        message += `, ShareToken: ${details.shareToken}`;
      }
      if (details.fileCount !== undefined) {
        message += `, Files: ${details.fileCount}`;
      }
      if (details.error) {
        message += `, Error: ${details.error}`;
      }
    }

    await this.logToIPFile(ip, success ? 'INFO' : 'WARN', message, req);
  }

  // Log batch upload summary (system-level, server.log only)
  async logBatchSummary(batchId, stats) {
    let message = `BATCH UPLOAD SUMMARY - BatchID: ${batchId}`;

    if (stats.totalFiles !== undefined) {
      message += `, Total Files: ${stats.totalFiles}`;
    }
    if (stats.successCount !== undefined) {
      message += `, Success: ${stats.successCount}`;
    }
    if (stats.failedCount !== undefined) {
      message += `, Failed: ${stats.failedCount}`;
    }
    if (stats.totalBytes !== undefined) {
      message += `, Total Size: ${stats.totalBytes} bytes`;
    }
    if (stats.duration !== undefined) {
      message += `, Duration: ${stats.duration}ms`;
    }

    await this.logSystem('INFO', message);
  }
}

// Create and export a single instance
const systemLogger = new SystemLogger();

// Handle SIGUSR1 for logrotate compatibility
// When logrotate rotates the log file, it sends SIGUSR1 to the process
// We need to close and reopen the log file handles
process.on('SIGUSR1', () => {
  systemLogger.logSystem('INFO', 'Received SIGUSR1 signal - reopening log files for logrotate');
  console.log('ℹ️  SIGUSR1 received - log files will be reopened on next write');
  // Note: Since we use fs.appendFile for each log entry, file handles are automatically
  // reopened on each write. No explicit action needed for Node.js append operations.
  systemLogger.logSystem('INFO', 'Log rotation complete');
});

module.exports = { SystemLogger, systemLogger, createLogger: () => systemLogger };
