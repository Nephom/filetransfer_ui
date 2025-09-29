// Log formatters for different output formats and destinations
const util = require('util');

class LogFormatters {
  /**
   * Format log entry for console output with colors and icons
   */
  static formatConsole(logEntry) {
    const colors = {
      error: '\x1b[31m',   // Red
      warn: '\x1b[33m',    // Yellow
      info: '\x1b[36m',    // Cyan
      debug: '\x1b[90m'    // Gray
    };
    
    const categoryIcons = {
      request: '🌐',
      file: '📁',
      security: '🔒',
      performance: '⚡',
      system: '🔧',
      auth: '👤'
    };

    const color = colors[logEntry.level] || '';
    const icon = categoryIcons[logEntry.category] || '📋';
    const reset = '\x1b[0m';
    
    const timestamp = new Date(logEntry.timestamp).toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    let output = `${color}${icon} [${timestamp}] [${logEntry.level.toUpperCase()}] ${logEntry.category.toUpperCase()}${reset}: ${logEntry.message}`;
    
    // Add IP and user info if available
    if (logEntry.ip && logEntry.user) {
      output += ` | ${logEntry.ip} (${logEntry.user})`;
    }
    
    // Add duration for performance logs
    if (logEntry.duration) {
      output += ` | Duration: ${logEntry.duration}`;
    }
    
    // Add status code for request logs
    if (logEntry.statusCode) {
      const statusColor = logEntry.statusCode >= 400 ? '\x1b[31m' : '\x1b[32m';
      output += ` | Status: ${statusColor}${logEntry.statusCode}${reset}`;
    }

    return output;
  }

  /**
   * Format log entry for JSON output (file logging)
   */
  static formatJSON(logEntry) {
    return JSON.stringify(logEntry, null, 2);
  }

  /**
   * Format log entry for plain text file output
   */
  static formatPlainText(logEntry) {
    const timestamp = new Date(logEntry.timestamp).toISOString();
    let line = `[${timestamp}] ${logEntry.level.toUpperCase()} ${logEntry.category.toUpperCase()}: ${logEntry.message}`;
    
    if (logEntry.ip) {
      line += ` | IP: ${logEntry.ip}`;
    }
    
    if (logEntry.user) {
      line += ` | User: ${logEntry.user}`;
    }
    
    if (logEntry.statusCode) {
      line += ` | Status: ${logEntry.statusCode}`;
    }
    
    if (logEntry.duration) {
      line += ` | Duration: ${logEntry.duration}`;
    }
    
    if (logEntry.operation) {
      line += ` | Operation: ${logEntry.operation}`;
    }

    return line;
  }

  /**
   * Format security event for special attention
   */
  static formatSecurityEvent(logEntry) {
    const timestamp = new Date(logEntry.timestamp).toLocaleString('zh-TW');
    let output = `🚨 SECURITY ALERT [${timestamp}]: ${logEntry.message}`;
    
    if (logEntry.ip) {
      output += `\n   IP Address: ${logEntry.ip}`;
    }
    
    if (logEntry.user) {
      output += `\n   User: ${logEntry.user}`;
    }
    
    if (logEntry.userAgent) {
      output += `\n   User Agent: ${logEntry.userAgent}`;
    }
    
    if (logEntry.event) {
      output += `\n   Event Type: ${logEntry.event}`;
    }
    
    if (logEntry.details) {
      output += `\n   Details: ${util.inspect(logEntry.details, { depth: 2, colors: false })}`;
    }
    
    return output;
  }

  /**
   * Format file operation log with detailed information
   */
  static formatFileOperation(logEntry) {
    const timestamp = new Date(logEntry.timestamp).toLocaleString('zh-TW');
    let output = `📁 FILE OPERATION [${timestamp}]: ${logEntry.message}`;
    
    if (logEntry.user) {
      output += `\n   User: ${logEntry.user}`;
    }
    
    if (logEntry.operation) {
      output += `\n   Operation: ${logEntry.operation}`;
    }
    
    if (logEntry.filePath) {
      output += `\n   File Path: ${logEntry.filePath}`;
    }
    
    if (logEntry.fileSize) {
      output += `\n   File Size: ${this.formatFileSize(logEntry.fileSize)}`;
    }
    
    if (logEntry.result !== undefined) {
      output += `\n   Result: ${logEntry.result ? 'Success' : 'Failed'}`;
    }
    
    if (logEntry.error) {
      output += `\n   Error: ${logEntry.error}`;
    }
    
    return output;
  }

  /**
   * Format file size in human readable format
   */
  static formatFileSize(bytes) {
    if (typeof bytes !== 'number') return bytes;
    
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 B';
    
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const size = (bytes / Math.pow(1024, i)).toFixed(2);
    
    return `${size} ${sizes[i]}`;
  }

  /**
   * Format performance log with metrics
   */
  static formatPerformance(logEntry) {
    const timestamp = new Date(logEntry.timestamp).toLocaleString('zh-TW');
    let output = `⚡ PERFORMANCE [${timestamp}]: ${logEntry.message}`;
    
    if (logEntry.operation) {
      output += `\n   Operation: ${logEntry.operation}`;
    }
    
    if (logEntry.duration) {
      output += `\n   Duration: ${logEntry.duration}`;
    }
    
    if (logEntry.cacheHit !== undefined) {
      output += `\n   Cache Hit: ${logEntry.cacheHit ? 'Yes' : 'No'}`;
    }
    
    if (logEntry.fileCount) {
      output += `\n   Files Processed: ${logEntry.fileCount}`;
    }
    
    if (logEntry.memoryUsage) {
      output += `\n   Memory Usage: ${this.formatFileSize(logEntry.memoryUsage)}`;
    }
    
    return output;
  }

  /**
   * Create a structured summary for aggregated logs
   */
  static formatSummary(logs, timeWindow = '1 hour') {
    const summary = {
      timeWindow,
      totalLogs: logs.length,
      byLevel: {},
      byCategory: {},
      uniqueIPs: new Set(),
      uniqueUsers: new Set(),
      errors: []
    };

    logs.forEach(log => {
      // Count by level
      summary.byLevel[log.level] = (summary.byLevel[log.level] || 0) + 1;
      
      // Count by category
      summary.byCategory[log.category] = (summary.byCategory[log.category] || 0) + 1;
      
      // Track unique IPs and users
      if (log.ip) summary.uniqueIPs.add(log.ip);
      if (log.user && log.user !== 'anonymous') summary.uniqueUsers.add(log.user);
      
      // Collect errors
      if (log.level === 'error') {
        summary.errors.push({
          timestamp: log.timestamp,
          message: log.message,
          ip: log.ip,
          user: log.user
        });
      }
    });

    // Convert sets to counts
    summary.uniqueIPCount = summary.uniqueIPs.size;
    summary.uniqueUserCount = summary.uniqueUsers.size;
    delete summary.uniqueIPs;
    delete summary.uniqueUsers;

    return summary;
  }
}

module.exports = LogFormatters;