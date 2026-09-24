const crypto = require('node:crypto');

const KEY_ENVIRONMENT_VARIABLE = 'SSH_TARGET_ENCRYPTION_KEY';
const SECRET_VERSION = 1;

const encryptionKeyError = () => Object.assign(
    new Error(`SSH encryption key (${KEY_ENVIRONMENT_VARIABLE}) is not configured. Please set it to a 32-byte hex or base64 key.`),
    { code: 'SSH_ENCRYPTION_KEY_MISSING', statusCode: 400 }
);

const resolveEncryptionKey = (value = process.env[KEY_ENVIRONMENT_VARIABLE]) => {
  if (Buffer.isBuffer(value) && value.length === 32) return Buffer.from(value);
  if (typeof value !== 'string' || !value.trim()) throw encryptionKeyError();

  const candidate = value.trim();
  if (/^[a-f0-9]{64}$/i.test(candidate)) return Buffer.from(candidate, 'hex');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(candidate) && candidate.length % 4 === 0) {
    const decoded = Buffer.from(candidate, 'base64');
    if (decoded.length === 32) return decoded;
  }
  throw encryptionKeyError();
};

class SecretStore {
  constructor({ keyProvider = () => process.env[KEY_ENVIRONMENT_VARIABLE] } = {}) {
    this.keyProvider = keyProvider;
  }

  getKey() {
    return resolveEncryptionKey(this.keyProvider());
  }

  encrypt(value) {
    if (typeof value !== 'string' || !value.trim()) {
      throw Object.assign(new Error('SSH credential must be a non-empty string.'), { statusCode: 400 });
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return JSON.stringify({
      version: SECRET_VERSION,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64')
    });
  }

  decrypt(payload) {
    if (payload === null || payload === undefined || payload === '') return null;
    let record;
    try { record = JSON.parse(String(payload)); }
    catch { throw new Error('Stored SSH credential is invalid.'); }
    if (record?.version !== SECRET_VERSION || typeof record.iv !== 'string' || typeof record.tag !== 'string' || typeof record.data !== 'string') {
      throw new Error('Stored SSH credential is invalid.');
    }

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.getKey(), Buffer.from(record.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Stored SSH credential could not be decrypted.');
    }
  }
}

module.exports = {
  KEY_ENVIRONMENT_VARIABLE,
  SecretStore,
  resolveEncryptionKey
};
