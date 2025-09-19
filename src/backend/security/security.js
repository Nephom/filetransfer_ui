// Security utilities and configurations
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class SecurityManager {
  constructor() {
    this.encryptionKey = process.env.ENCRYPTION_KEY || this.generateEncryptionKey();
    this.algorithm = 'aes-256-gcm';
  }

  generateEncryptionKey() {
    // Generate a random 32-byte key for AES-256
    return crypto.randomBytes(32).toString('hex');
  }

  // Encrypt sensitive data
  encrypt(text) {
    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipher(this.algorithm, this.encryptionKey);
      
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      const authTag = cipher.getAuthTag();
      
      return {
        encrypted,
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex')
      };
    } catch (error) {
      console.error('Encryption error:', error);
      throw new Error('Failed to encrypt data');
    }
  }

  // Decrypt sensitive data
  decrypt(encryptedData) {
    try {
      const { encrypted, iv, authTag } = encryptedData;
      const decipher = crypto.createDecipher(this.algorithm, this.encryptionKey);
      
      decipher.setAuthTag(Buffer.from(authTag, 'hex'));
      
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      console.error('Decryption error:', error);
      throw new Error('Failed to decrypt data');
    }
  }

  // Generate secure random tokens
  generateSecureToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
  }

  // Hash sensitive data with salt
  hashWithSalt(data, salt = null) {
    if (!salt) {
      salt = crypto.randomBytes(16).toString('hex');
    }
    
    const hash = crypto.pbkdf2Sync(data, salt, 10000, 64, 'sha512').toString('hex');
    
    return {
      hash,
      salt
    };
  }

  // Verify hashed data
  verifyHash(data, hash, salt) {
    const { hash: newHash } = this.hashWithSalt(data, salt);
    return newHash === hash;
  }

  // Secure config file operations
  async secureWriteConfig(configPath, data) {
    try {
      // Create backup
      const backupPath = `${configPath}.backup.${Date.now()}`;
      try {
        await fs.copyFile(configPath, backupPath);
      } catch (error) {
        // File might not exist yet, that's okay
      }

      // Write with atomic operation
      const tempPath = `${configPath}.tmp`;
      await fs.writeFile(tempPath, data, { mode: 0o600 }); // Restrict permissions
      await fs.rename(tempPath, configPath);

      console.log('Config file updated securely');
    } catch (error) {
      console.error('Secure config write error:', error);
      throw new Error('Failed to update configuration securely');
    }
  }

  // Validate configuration security
  async validateConfigSecurity(configPath) {
    try {
      const stats = await fs.stat(configPath);
      const mode = stats.mode & parseInt('777', 8);
      
      // Check if file permissions are too permissive
      if (mode > parseInt('600', 8)) {
        console.warn(`⚠️  Config file ${configPath} has permissive permissions (${mode.toString(8)})`);
        console.warn('   Consider running: chmod 600 ' + configPath);
        return false;
      }
      
      return true;
    } catch (error) {
      console.error('Config security validation error:', error);
      return false;
    }
  }

  // Generate security recommendations
  getSecurityRecommendations() {
    const recommendations = [];

    // Check environment variables
    if (!process.env.JWT_SECRET) {
      recommendations.push({
        level: 'HIGH',
        message: 'Set JWT_SECRET environment variable for production',
        action: 'export JWT_SECRET="your-secure-random-string"'
      });
    }

    if (!process.env.ENCRYPTION_KEY) {
      recommendations.push({
        level: 'MEDIUM',
        message: 'Set ENCRYPTION_KEY environment variable for data encryption',
        action: 'export ENCRYPTION_KEY="' + this.generateEncryptionKey() + '"'
      });
    }

    if (!process.env.NODE_ENV || process.env.NODE_ENV !== 'production') {
      recommendations.push({
        level: 'MEDIUM',
        message: 'Set NODE_ENV=production for production deployment',
        action: 'export NODE_ENV=production'
      });
    }

    // Check HTTPS
    if (!process.env.HTTPS_ENABLED) {
      recommendations.push({
        level: 'HIGH',
        message: 'Enable HTTPS for production to protect data in transit',
        action: 'Use reverse proxy (nginx) or set HTTPS_ENABLED=true with SSL certificates'
      });
    }

    return recommendations;
  }

  // Log security event
  logSecurityEvent(event, details = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      event,
      details,
      ip: details.ip || 'unknown',
      userAgent: details.userAgent || 'unknown'
    };

    console.log('🔒 SECURITY EVENT:', JSON.stringify(logEntry, null, 2));
    
    // In production, you might want to send this to a security monitoring service
  }
}

module.exports = SecurityManager;
