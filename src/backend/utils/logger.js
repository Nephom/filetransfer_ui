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

    let ip = req.headers['x-forwarded-for'] ||
             req.headers['x-real-ip'] ||
             req.connection.remoteAddress ||
             req.socket.remoteAddress ||
             (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
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
        logEntry += ` | URL: ${req.method} ${req.originalUrl}`;
        const userAgent = req.headers['user-agent'];
        if (userAgent && userAgent !== 'unknown') {
          logEntry += ` | User-Agent: ${userAgent.substring(0, 100)}`; // Truncate long user agents
        }
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
}

// Create and export a single instance
const systemLogger = new SystemLogger();
module.exports = { SystemLogger, systemLogger, createLogger: () => systemLogger };
