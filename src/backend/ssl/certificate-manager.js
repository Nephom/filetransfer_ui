// @peculiar/x509 relies on tsyringe, which needs a Reflect polyfill loaded first.
require('reflect-metadata');
const crypto = require('crypto');
const net = require('net');
const { promisify } = require('util');
const x509 = require('@peculiar/x509');
const fs = require('fs').promises;
const path = require('path');
const { systemLogger } = require('../utils/logger');

const generateKeyPair = promisify(crypto.generateKeyPair);
const RSA_ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

x509.cryptoProvider.set(crypto.webcrypto);

// Positive 128-bit random serial. The top bit is cleared so the DER INTEGER is
// never negative (Go TLS rejects negative serials) and re-issued certificates
// with the same issuer name never collide on (issuer, serial).
const randomSerialNumber = () => {
  const bytes = crypto.randomBytes(16);
  bytes[0] = (bytes[0] & 0x7f) | 0x01;
  return bytes.toString('hex');
};

const addYears = (date, years) => {
  const result = new Date(date.getTime());
  result.setFullYear(result.getFullYear() + years);
  return result;
};

class CertificateManager {
  constructor() {
    this.certDir = path.join(__dirname, '../../../src/data/cert');
    this.caKeyPath = path.join(this.certDir, 'ca.key');
    this.caCertPath = path.join(this.certDir, 'ca.crt');
    this.serverKeyPath = path.join(this.certDir, 'server.key');
    this.serverCertPath = path.join(this.certDir, 'server.crt');
  }

  /**
   * Generate a 2048-bit RSA key pair with Node's native crypto.
   * @returns {Promise<Object>} { privateKey, publicKey (CryptoKey), keyPem (PKCS#1 PEM) }
   */
  async generateRsaKeyPair() {
    const { publicKey, privateKey } = await generateKeyPair('rsa', {
      modulusLength: 2048,
      publicExponent: 0x10001
    });
    return {
      privateKey: await this.importPrivateKey(privateKey),
      publicKey: await crypto.webcrypto.subtle.importKey(
        'spki', publicKey.export({ type: 'spki', format: 'der' }), RSA_ALGORITHM, true, ['verify']
      ),
      // Same PEM flavour (PKCS#1 "RSA PRIVATE KEY") as the previous implementation.
      keyPem: privateKey.export({ type: 'pkcs1', format: 'pem' })
    };
  }

  /**
   * Convert a Node KeyObject into a WebCrypto signing key.
   * @param {crypto.KeyObject} keyObject - RSA private key
   * @returns {Promise<CryptoKey>}
   */
  importPrivateKey(keyObject) {
    return crypto.webcrypto.subtle.importKey(
      'pkcs8', keyObject.export({ type: 'pkcs8', format: 'der' }), RSA_ALGORITHM, true, ['sign']
    );
  }

  /**
   * Generate CA (Certificate Authority) certificate and private key
   * @param {number} validityYears - Certificate validity in years (default: 10)
   * @returns {Promise<Object>} { cert: PEM certificate, key: PEM private key, certObj, keyObj }
   */
  async generateCA(validityYears = 10) {
    const keys = await this.generateRsaKeyPair();
    const notBefore = new Date();

    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: randomSerialNumber(),
      name: 'CN=File Transfer CA, C=TW, O=File Transfer System, OU=Certificate Authority',
      notBefore,
      notAfter: addYears(notBefore, validityYears),
      signingAlgorithm: RSA_ALGORITHM,
      keys: { privateKey: keys.privateKey, publicKey: keys.publicKey },
      extensions: [
        new x509.BasicConstraintsExtension(true, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey)
      ]
    });

    return {
      cert: cert.toString('pem'),
      key: keys.keyPem,
      certObj: cert,
      keyObj: keys.privateKey
    };
  }

  /**
   * Generate server certificate signed by CA
   * @param {Object} caData - CA certificate (x509.X509Certificate) and signing key (CryptoKey)
   * @param {Array<string>} sans - Subject Alternative Names (IPs and hostnames)
   * @param {number} validityYears - Certificate validity in years (default: 10)
   * @returns {Promise<Object>} { cert: PEM certificate, key: PEM private key }
   */
  async generateServerCertificate(caData, sans = [], validityYears = 10) {
    const keys = await this.generateRsaKeyPair();
    const notBefore = new Date();

    // Build Subject Alternative Names. net.isIP is authoritative; a regex would
    // also classify hex-only host names (e.g. "beef") as IP addresses.
    const altNames = sans.map(san => ({ type: net.isIP(san) ? 'ip' : 'dns', value: san }));

    const extensions = [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth, x509.ExtendedKeyUsage.clientAuth]),
      ...(altNames.length ? [new x509.SubjectAlternativeNameExtension(altNames)] : []),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(caData.certObj)
    ];

    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerialNumber(),
      subject: 'CN=File Transfer Server, C=TW, O=File Transfer System, OU=Server Certificate',
      issuer: caData.certObj.subjectName,
      notBefore,
      notAfter: addYears(notBefore, validityYears),
      signingAlgorithm: RSA_ALGORITHM,
      publicKey: keys.publicKey,
      signingKey: caData.keyObj,
      extensions
    });

    return {
      cert: cert.toString('pem'),
      key: keys.keyPem
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
   * @returns {Promise<x509.X509Certificate>} parsed certificate
   */
  async loadCertificate(certPath) {
    const certPem = await fs.readFile(certPath, 'utf8');
    return new x509.X509Certificate(certPem);
  }

  /**
   * Load private key from file
   * @param {string} keyPath - Path to private key file
   * @returns {Promise<CryptoKey>} RSA signing key (PKCS#1 and PKCS#8 PEM are both accepted)
   */
  async loadPrivateKey(keyPath) {
    const keyPem = await fs.readFile(keyPath, 'utf8');
    return this.importPrivateKey(crypto.createPrivateKey(keyPem));
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
      return cert.notAfter;
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
      const caData = await this.generateCA(10);
      await this.saveCertificate(this.caCertPath, this.caKeyPath, caData.cert, caData.key);

      // Generate Server certificate
      systemLogger.logSystem('INFO', `Generating server certificate with SANs: ${sans.join(', ')}`);
      const serverData = await this.generateServerCertificate(caData, sans, 10);
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
      const serverData = await this.generateServerCertificate(caData, sans, 10);
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

      const altNameExt = cert.getExtension(x509.SubjectAlternativeNameExtension);
      if (altNameExt) {
        for (const altName of altNameExt.names.items) {
          if (altName.type === 'ip' || altName.type === 'dns') sans.push(altName.value);
        }
      }

      return sans;
    } catch (error) {
      return [];
    }
  }
}

module.exports = new CertificateManager();
