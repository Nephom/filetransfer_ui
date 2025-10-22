const os = require('os');
const fs = require('fs').promises;
const path = require('path');
const { systemLogger } = require('../utils/logger');

class SANManager {
  constructor() {
    this.configPath = path.join(__dirname, '../../../src/data/ssl-config.json');
    this.defaultConfig = {
      sans: {
        ips: ['10.6.66.40', '127.0.0.1'],
        hostnames: ['localhost']
      },
      autoDetectIPs: true
    };
  }

  /**
   * Load SAN configuration from file
   * @returns {Object} SAN configuration
   */
  async loadConfig() {
    try {
      const data = await fs.readFile(this.configPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      // If file doesn't exist, return default config
      return { ...this.defaultConfig };
    }
  }

  /**
   * Save SAN configuration to file
   * @param {Object} config - SAN configuration
   */
  async saveConfig(config) {
    try {
      // Create data directory if it doesn't exist
      const dataDir = path.dirname(this.configPath);
      await fs.mkdir(dataDir, { recursive: true });

      // Create backup of existing config
      await this.backupConfig();

      await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf8');
      systemLogger.logSystem('INFO', 'SAN configuration saved');
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to save SAN config: ${error.message}`);
      throw error;
    }
  }

  /**
   * Backup current configuration
   */
  async backupConfig() {
    try {
      const exists = await fs.access(this.configPath).then(() => true).catch(() => false);
      if (!exists) return;

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const backupPath = path.join(
        path.dirname(this.configPath),
        'cert',
        `ssl-config.backup.${timestamp}.json`
      );

      // Ensure backup directory exists
      await fs.mkdir(path.dirname(backupPath), { recursive: true });

      const data = await fs.readFile(this.configPath, 'utf8');
      await fs.writeFile(backupPath, data, 'utf8');

      // Clean old backups (keep last 5)
      await this.cleanOldBackups();
    } catch (error) {
      // Non-critical error, just log it
      systemLogger.logSystem('WARN', `Failed to backup SAN config: ${error.message}`);
    }
  }

  /**
   * Clean old backup files (keep last 5)
   */
  async cleanOldBackups() {
    try {
      const backupDir = path.join(path.dirname(this.configPath), 'cert');
      const files = await fs.readdir(backupDir);
      const backupFiles = files
        .filter(f => f.startsWith('ssl-config.backup.'))
        .sort()
        .reverse();

      // Delete all but the 5 most recent
      for (let i = 5; i < backupFiles.length; i++) {
        await fs.unlink(path.join(backupDir, backupFiles[i]));
      }
    } catch (error) {
      // Non-critical error
    }
  }

  /**
   * Detect network interfaces and extract IP addresses
   * @returns {Array<string>} List of detected IP addresses
   */
  detectNetworkIPs() {
    const interfaces = os.networkInterfaces();
    const detectedIPs = [];

    Object.values(interfaces).flat().forEach(iface => {
      // Only include IPv4, non-internal addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        // Filter for 192.x.x.x subnet
        if (iface.address.startsWith('192.')) {
          detectedIPs.push(iface.address);
        }
      }
    });

    return detectedIPs;
  }

  /**
   * Get complete SAN list (auto-detected + configured)
   * @returns {Object} { ips: Array<string>, hostnames: Array<string>, autoDetected: Array<string> }
   */
  async getSANs() {
    const config = await this.loadConfig();
    const autoDetectedIPs = config.autoDetectIPs ? this.detectNetworkIPs() : [];

    // Combine and deduplicate IPs
    const allIPs = [...new Set([...config.sans.ips, ...autoDetectedIPs])];

    return {
      ips: allIPs,
      hostnames: config.sans.hostnames || [],
      autoDetected: autoDetectedIPs
    };
  }

  /**
   * Get complete SAN list as flat array (for certificate generation)
   * @returns {Array<string>} All SANs (IPs and hostnames)
   */
  async getSANList() {
    const sans = await this.getSANs();
    return [...sans.ips, ...sans.hostnames];
  }

  /**
   * Validate IP address format
   * @param {string} ip - IP address to validate
   * @returns {boolean} True if valid IPv4 or IPv6
   */
  validateIP(ip) {
    // IPv4 regex
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    // IPv6 regex (simplified)
    const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

    if (ipv4Regex.test(ip)) {
      // Validate IPv4 octets are 0-255
      const octets = ip.split('.');
      return octets.every(octet => {
        const num = parseInt(octet, 10);
        return num >= 0 && num <= 255;
      });
    }

    return ipv6Regex.test(ip);
  }

  /**
   * Validate hostname format
   * @param {string} hostname - Hostname to validate
   * @returns {boolean} True if valid hostname
   */
  validateHostname(hostname) {
    // Hostname regex (RFC 1123)
    const hostnameRegex = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
    return hostnameRegex.test(hostname) && hostname.length <= 253;
  }

  /**
   * Validate SAN entry (IP or hostname)
   * @param {string} san - SAN to validate
   * @returns {Object} { valid: boolean, type: 'ip'|'hostname'|null, error: string|null }
   */
  validateSAN(san) {
    if (!san || typeof san !== 'string') {
      return { valid: false, type: null, error: 'SAN不能為空' };
    }

    san = san.trim();

    if (this.validateIP(san)) {
      return { valid: true, type: 'ip', error: null };
    }

    if (this.validateHostname(san)) {
      return { valid: true, type: 'hostname', error: null };
    }

    return { valid: false, type: null, error: '無效的IP地址或主機名格式' };
  }

  /**
   * Update SAN configuration
   * @param {Object} newSANs - { ips: Array, hostnames: Array, autoDetectIPs: boolean }
   * @param {Object} req - Express request for logging
   * @returns {Object} { success: boolean, message: string }
   */
  async updateSANs(newSANs, req = null) {
    try {
      const config = await this.loadConfig();

      // Log previous configuration
      const oldSANs = await this.getSANList();

      // Validate all IPs
      if (newSANs.ips) {
        for (const ip of newSANs.ips) {
          const validation = this.validateSAN(ip);
          if (!validation.valid || validation.type !== 'ip') {
            return {
              success: false,
              message: `無效的IP地址: ${ip}`
            };
          }
        }
        config.sans.ips = [...new Set(newSANs.ips)]; // Deduplicate
      }

      // Validate all hostnames
      if (newSANs.hostnames) {
        for (const hostname of newSANs.hostnames) {
          const validation = this.validateSAN(hostname);
          if (!validation.valid || validation.type !== 'hostname') {
            return {
              success: false,
              message: `無效的主機名: ${hostname}`
            };
          }
        }
        config.sans.hostnames = [...new Set(newSANs.hostnames)]; // Deduplicate
      }

      // Update auto-detect setting
      if (typeof newSANs.autoDetectIPs === 'boolean') {
        config.autoDetectIPs = newSANs.autoDetectIPs;
      }

      await this.saveConfig(config);

      // Log configuration change
      const newSANList = await this.getSANList();
      if (req) {
        await systemLogger.log('INFO', `SAN configuration updated - Previous: ${oldSANs.join(', ')}, New: ${newSANList.join(', ')}`, req);
      }

      return {
        success: true,
        message: 'SAN配置已更新'
      };
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to update SANs: ${error.message}`);
      return {
        success: false,
        message: `SAN配置更新失敗: ${error.message}`
      };
    }
  }

  /**
   * Add custom SAN entry
   * @param {string} san - SAN to add (IP or hostname)
   * @param {Object} req - Express request for logging
   * @returns {Object} { success: boolean, message: string }
   */
  async addSAN(san, req = null) {
    try {
      const validation = this.validateSAN(san);
      if (!validation.valid) {
        return {
          success: false,
          message: validation.error
        };
      }

      const config = await this.loadConfig();
      const targetArray = validation.type === 'ip' ? config.sans.ips : config.sans.hostnames;

      if (targetArray.includes(san)) {
        return {
          success: false,
          message: 'SAN已存在'
        };
      }

      targetArray.push(san);
      await this.saveConfig(config);

      if (req) {
        await systemLogger.log('INFO', `SAN added: ${san} (${validation.type})`, req);
      }

      return {
        success: true,
        message: `SAN已添加: ${san}`
      };
    } catch (error) {
      return {
        success: false,
        message: `添加SAN失敗: ${error.message}`
      };
    }
  }

  /**
   * Remove custom SAN entry
   * @param {string} san - SAN to remove
   * @param {Object} req - Express request for logging
   * @returns {Object} { success: boolean, message: string }
   */
  async removeSAN(san, req = null) {
    try {
      const config = await this.loadConfig();

      // Check if it's in IPs
      const ipIndex = config.sans.ips.indexOf(san);
      if (ipIndex !== -1) {
        config.sans.ips.splice(ipIndex, 1);
        await this.saveConfig(config);

        if (req) {
          await systemLogger.log('INFO', `SAN removed: ${san} (ip)`, req);
        }

        return {
          success: true,
          message: `SAN已移除: ${san}`
        };
      }

      // Check if it's in hostnames
      const hostnameIndex = config.sans.hostnames.indexOf(san);
      if (hostnameIndex !== -1) {
        config.sans.hostnames.splice(hostnameIndex, 1);
        await this.saveConfig(config);

        if (req) {
          await systemLogger.log('INFO', `SAN removed: ${san} (hostname)`, req);
        }

        return {
          success: true,
          message: `SAN已移除: ${san}`
        };
      }

      return {
        success: false,
        message: 'SAN不存在'
      };
    } catch (error) {
      return {
        success: false,
        message: `移除SAN失敗: ${error.message}`
      };
    }
  }
}

module.exports = new SANManager();
