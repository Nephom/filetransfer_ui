const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../../../logs');
fs.mkdir(logsDir, { recursive: true }).catch(console.error);

class SystemLogger {
  constructor() {
    this.logsDir = logsDir;
  }

  // Get client IP from request
  getClientIP(req) {
    return req.headers['x-forwarded-for'] || 
           req.headers['x-real-ip'] || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress ||
           (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
           'unknown';
  }

  // Format date for log entries
  getFormattedDate() {
    const now = new Date();
    return now.toISOString().replace('T', ' ').substring(0, 19);
  }

  // Log to IP-specific file
  async logToFile(ip, level, message, req = null) {
    try {
      const sanitizedIP = ip.replace(/[:.]/g, '_'); // Sanitize IP for filename
      const logFile = path.join(this.logsDir, `${sanitizedIP}.log`);
      
      let logEntry = `[${this.getFormattedDate()}] [${level}] ${message}`;
      
      // Add request details if available
      if (req) {
        logEntry += ` | URL: ${req.method} ${req.originalUrl}`;
        logEntry += ` | User-Agent: ${req.headers['user-agent'] || 'unknown'}`;
        if (req.user) {
          logEntry += ` | User: ${req.user.username}`;
        }
      }
      
      logEntry += '\n';
      
      await fs.appendFile(logFile, logEntry);
    } catch (error) {
      console.error('Failed to write log file:', error);
    }
  }

  // Log authentication events
  async logAuth(event, username, success, details = null, req = null) {
    const ip = this.getClientIP(req);
    const status = success ? 'SUCCESS' : 'FAILED';
    let message = `AUTH ${event} - User: ${username}, Status: ${status}`;
    
    if (details) {
      message += `, Details: ${JSON.stringify(details)}`;
    }
    
    await this.logToFile(ip, 'INFO', message, req);
  }

  // Log API operations
  async logAPI(operation, resource, success, req = null, details = null) {
    const ip = this.getClientIP(req);
    const status = success ? 'SUCCESS' : 'FAILED';
    let message = `API ${operation} - Resource: ${resource}, Status: ${status}`;
    
    if (details) {
      message += `, Details: ${JSON.stringify(details)}`;
    }
    
    await this.logToFile(ip, 'INFO', message, req);
  }

  // Log file operations
  async logFileOperation(operation, filePath, success, req = null, details = null) {
    const ip = this.getClientIP(req);
    const status = success ? 'SUCCESS' : 'FAILED';
    let message = `FILE ${operation} - Path: ${filePath}, Status: ${status}`;
    
    if (details) {
      message += `, Details: ${JSON.stringify(details)}`;
    }
    
    await this.logToFile(ip, 'INFO', message, req);
  }

  // Log general events
  async log(level, message, req = null) {
    const ip = req ? this.getClientIP(req) : 'unknown';
    await this.logToFile(ip, level, message, req);
  }

  // Log error
  async logError(message, req = null) {
    const ip = req ? this.getClientIP(req) : 'unknown';
    await this.logToFile(ip, 'ERROR', message, req);
  }
}

// Create and export a single instance
const systemLogger = new SystemLogger();
module.exports = { SystemLogger, systemLogger, createLogger: () => systemLogger };