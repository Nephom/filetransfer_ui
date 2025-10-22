const forge = require('node-forge');
const fs = require('fs').promises;
const path = require('path');
const { systemLogger } = require('../utils/logger');

class CertificateManager {
  constructor() {
    this.certDir = path.join(__dirname, '../../../src/data/cert');
    this.caKeyPath = path.join(this.certDir, 'ca.key');
    this.caCertPath = path.join(this.certDir, 'ca.crt');
    this.serverKeyPath = path.join(this.certDir, 'server.key');
    this.serverCertPath = path.join(this.certDir, 'server.crt');
  }

  /**
   * Generate CA (Certificate Authority) certificate and private key
   * @param {number} validityYears - Certificate validity in years (default: 10)
   * @returns {Object} { cert: PEM certificate, key: PEM private key }
   */
  generateCA(validityYears = 10) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + validityYears);

    const attrs = [
      { name: 'commonName', value: 'File Transfer CA' },
      { name: 'countryName', value: 'TW' },
      { name: 'organizationName', value: 'File Transfer System' },
      { shortName: 'OU', value: 'Certificate Authority' }
    ];

    cert.setSubject(attrs);
    cert.setIssuer(attrs);

    cert.setExtensions([
      {
        name: 'basicConstraints',
        cA: true,
        critical: true
      },
      {
        name: 'keyUsage',
        keyCertSign: true,
        cRLSign: true,
        critical: true
      },
      {
        name: 'subjectKeyIdentifier'
      }
    ]);

    cert.sign(keys.privateKey, forge.md.sha256.create());

    return {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey),
      certObj: cert,
      keyObj: keys.privateKey
    };
  }

  /**
   * Generate server certificate signed by CA
   * @param {Object} caData - CA certificate and key objects
   * @param {Array<string>} sans - Subject Alternative Names (IPs and hostnames)
   * @param {number} validityYears - Certificate validity in years (default: 10)
   * @returns {Object} { cert: PEM certificate, key: PEM private key }
   */
  generateServerCertificate(caData, sans = [], validityYears = 10) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = Math.floor(Math.random() * 1000000).toString();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + validityYears);

    const attrs = [
      { name: 'commonName', value: 'File Transfer Server' },
      { name: 'countryName', value: 'TW' },
      { name: 'organizationName', value: 'File Transfer System' },
      { shortName: 'OU', value: 'Server Certificate' }
    ];

    cert.setSubject(attrs);
    cert.setIssuer(caData.certObj.subject.attributes);

    // Build Subject Alternative Names
    const altNames = [];
    sans.forEach(san => {
      // Check if it's an IP address
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(san) || /^([0-9a-fA-F:]+)$/.test(san)) {
        altNames.push({ type: 7, ip: san }); // type 7 = IP address
      } else {
        altNames.push({ type: 2, value: san }); // type 2 = DNS name
      }
    });

    cert.setExtensions([
      {
        name: 'basicConstraints',
        cA: false,
        critical: true
      },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
        critical: true
      },
      {
        name: 'extKeyUsage',
        serverAuth: true,
        clientAuth: true
      },
      {
        name: 'subjectAltName',
        altNames: altNames
      },
      {
        name: 'subjectKeyIdentifier'
      },
      {
        name: 'authorityKeyIdentifier',
        keyIdentifier: caData.certObj.generateSubjectKeyIdentifier().getBytes()
      }
    ]);

    cert.sign(caData.keyObj, forge.md.sha256.create());

    return {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey)
    };
  }

  /**
   * Save certificate and key files to disk
   * @param {string} certPath - Path to save certificate
   * @param {string} keyPath - Path to save private key
   * @param {string} cert - PEM certificate
   * @param {string} key - PEM private key
   */
  async saveCertificate(certPath, keyPath, cert, key) {
    await fs.writeFile(certPath, cert, { mode: 0o644 });
    await fs.writeFile(keyPath, key, { mode: 0o600 });
  }

  /**
   * Load certificate from file
   * @param {string} certPath - Path to certificate file
   * @returns {Object} forge certificate object
   */
  async loadCertificate(certPath) {
    const certPem = await fs.readFile(certPath, 'utf8');
    return forge.pki.certificateFromPem(certPem);
  }

  /**
   * Load private key from file
   * @param {string} keyPath - Path to private key file
   * @returns {Object} forge private key object
   */
  async loadPrivateKey(keyPath) {
    const keyPem = await fs.readFile(keyPath, 'utf8');
    return forge.pki.privateKeyFromPem(keyPem);
  }

  /**
   * Check if certificates exist
   * @returns {Object} { ca: boolean, server: boolean }
   */
  async certificatesExist() {
    try {
      const [caKeyExists, caCertExists, serverKeyExists, serverCertExists] = await Promise.all([
        fs.access(this.caKeyPath).then(() => true).catch(() => false),
        fs.access(this.caCertPath).then(() => true).catch(() => false),
        fs.access(this.serverKeyPath).then(() => true).catch(() => false),
        fs.access(this.serverCertPath).then(() => true).catch(() => false)
      ]);

      return {
        ca: caKeyExists && caCertExists,
        server: serverKeyExists && serverCertExists
      };
    } catch (error) {
      return { ca: false, server: false };
    }
  }

  /**
   * Get certificate expiration date
   * @param {string} certPath - Path to certificate file
   * @returns {Date|null} Expiration date or null if file doesn't exist
   */
  async getCertificateExpiration(certPath) {
    try {
      const cert = await this.loadCertificate(certPath);
      return cert.validity.notAfter;
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if certificate is expiring soon
   * @param {Date} expirationDate - Certificate expiration date
   * @param {number} daysWarning - Number of days before expiration to warn (default: 90)
   * @returns {boolean} True if expiring within warning period
   */
  isExpiringSoon(expirationDate, daysWarning = 90) {
    if (!expirationDate) return false;
    const warningDate = new Date();
    warningDate.setDate(warningDate.getDate() + daysWarning);
    return expirationDate <= warningDate;
  }

  /**
   * Check if certificate is expired
   * @param {Date} expirationDate - Certificate expiration date
   * @returns {boolean} True if expired
   */
  isExpired(expirationDate) {
    if (!expirationDate) return false;
    return expirationDate <= new Date();
  }

  /**
   * Generate complete SSL infrastructure (CA + Server cert)
   * @param {Array<string>} sans - Subject Alternative Names
   * @param {Object} req - Express request object for logging
   * @returns {Object} { success: boolean, message: string, expirationDates: Object }
   */
  async generateFullCertificateSet(sans = [], req = null) {
    try {
      // Ensure cert directory exists
      await fs.mkdir(this.certDir, { recursive: true, mode: 0o700 });

      // Generate CA
      systemLogger.logSystem('INFO', 'Generating CA certificate...');
      const caData = this.generateCA(10);
      await this.saveCertificate(this.caCertPath, this.caKeyPath, caData.cert, caData.key);

      // Generate Server certificate
      systemLogger.logSystem('INFO', `Generating server certificate with SANs: ${sans.join(', ')}`);
      const serverData = this.generateServerCertificate(caData, sans, 10);
      await this.saveCertificate(this.serverCertPath, this.serverKeyPath, serverData.cert, serverData.key);

      const caExpiration = await this.getCertificateExpiration(this.caCertPath);
      const serverExpiration = await this.getCertificateExpiration(this.serverCertPath);

      // Log to audit trail
      if (req) {
        await systemLogger.log('INFO', `SSL certificates generated - CA expires: ${caExpiration}, Server expires: ${serverExpiration}, SANs: ${sans.join(', ')}`, req);
      }

      systemLogger.logSystem('INFO', 'SSL certificates generated successfully');

      return {
        success: true,
        message: 'SSL證書生成成功',
        expirationDates: {
          ca: caExpiration,
          server: serverExpiration
        }
      };
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to generate certificates: ${error.message}`);
      if (req) {
        await systemLogger.logError(`Certificate generation failed: ${error.message}`, req);
      }
      return {
        success: false,
        message: `證書生成失敗: ${error.message}`
      };
    }
  }

  /**
   * Renew server certificate (keep existing CA)
   * @param {Array<string>} sans - Subject Alternative Names
   * @param {Object} req - Express request object for logging
   * @returns {Object} { success: boolean, message: string, expirationDate: Date }
   */
  async renewServerCertificate(sans = [], req = null) {
    try {
      // Load existing CA
      const caCert = await this.loadCertificate(this.caCertPath);
      const caKey = await this.loadPrivateKey(this.caKeyPath);

      const caData = {
        certObj: caCert,
        keyObj: caKey
      };

      // Generate new server certificate
      systemLogger.logSystem('INFO', `Renewing server certificate with SANs: ${sans.join(', ')}`);
      const serverData = this.generateServerCertificate(caData, sans, 10);
      await this.saveCertificate(this.serverCertPath, this.serverKeyPath, serverData.cert, serverData.key);

      const serverExpiration = await this.getCertificateExpiration(this.serverCertPath);

      // Log to audit trail
      if (req) {
        await systemLogger.log('INFO', `Server certificate renewed - Expires: ${serverExpiration}, SANs: ${sans.join(', ')}`, req);
      }

      systemLogger.logSystem('INFO', 'Server certificate renewed successfully');

      return {
        success: true,
        message: 'SSL證書已更新，請重啟服務',
        expirationDate: serverExpiration
      };
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to renew certificate: ${error.message}`);
      if (req) {
        await systemLogger.logError(`Certificate renewal failed: ${error.message}`, req);
      }
      return {
        success: false,
        message: `證書更新失敗: ${error.message}`
      };
    }
  }

  /**
   * Extract SANs from certificate
   * @param {string} certPath - Path to certificate file
   * @returns {Array<string>} List of SANs
   */
  async extractSANs(certPath) {
    try {
      const cert = await this.loadCertificate(certPath);
      const sans = [];

      const altNameExt = cert.getExtension('subjectAltName');
      if (altNameExt && altNameExt.altNames) {
        altNameExt.altNames.forEach(altName => {
          if (altName.type === 7) {
            // IP address
            sans.push(altName.ip);
          } else if (altName.type === 2) {
            // DNS name
            sans.push(altName.value);
          }
        });
      }

      return sans;
    } catch (error) {
      return [];
    }
  }
}

module.exports = new CertificateManager();
