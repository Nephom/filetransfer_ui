const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { SecretStore } = require('./secret-store');

const PUBLIC_COLUMNS = `
  id, displayName, host, port, username, authType,
  encryptedPrivateKey, encryptedPassword, encryptedPassphrase,
  hostKeyType, hostKeyFingerprint, createdAt, updatedAt, lastConnectedAt
`;
const SECRET_LIMITS = { privateKey: 128 * 1024, password: 4096, passphrase: 4096 };
const SECRET_COLUMNS = {
  privateKey: 'encryptedPrivateKey',
  password: 'encryptedPassword',
  passphrase: 'encryptedPassphrase'
};

const invalid = message => Object.assign(new Error(message), { statusCode: 400 });
const text = (value, label, maximum) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid(`${label} is invalid.`);
  return value.trim();
};

const validateTarget = (input = {}, { partial = false } = {}) => {
  const result = {};
  if (!partial || input.displayName !== undefined) result.displayName = text(input.displayName, 'Display name', 80);
  if (!partial || input.host !== undefined) {
    const host = text(input.host, 'Host', 253);
    if (!net.isIP(host) && !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u.test(host)) throw invalid('Host is invalid.');
    result.host = host;
  }
  if (!partial || input.port !== undefined) {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid('Port must be an integer between 1 and 65535.');
    result.port = port;
  }
  if (!partial || input.username !== undefined) result.username = text(input.username, 'Username', 128);
  if (!partial || input.authType !== undefined) {
    if (!['private-key', 'password'].includes(input.authType)) throw invalid('Authentication type is invalid.');
    result.authType = input.authType;
  }
  for (const [name, limit] of Object.entries(SECRET_LIMITS)) {
    if (input[name] === undefined) continue;
    if (input[name] === null || input[name] === '') throw invalid(`${name} must be omitted to keep the existing value or explicitly cleared.`);
    if (typeof input[name] !== 'string' || input[name].length > limit || !input[name].trim()) throw invalid(`${name} is invalid.`);
    result[name] = input[name];
  }
  for (const name of Object.keys(SECRET_COLUMNS)) {
    const clearName = `clear${name[0].toUpperCase()}${name.slice(1)}`;
    if (input[clearName] !== undefined && input[clearName] !== true && input[clearName] !== false) throw invalid(`${clearName} is invalid.`);
    if (input[clearName] === true) result[clearName] = true;
  }
  return result;
};

const publicTarget = row => ({
  id: row.id,
  displayName: row.displayName,
  host: row.host,
  port: row.port,
  username: row.username,
  authType: row.authType,
  hasPrivateKey: Boolean(row.encryptedPrivateKey),
  hasPassword: Boolean(row.encryptedPassword),
  hasPassphrase: Boolean(row.encryptedPassphrase),
  hasHostKey: Boolean(row.hostKeyFingerprint),
  hostKeyFingerprint: row.hostKeyFingerprint || null,
  lastConnectedAt: row.lastConnectedAt || null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

class TargetStore {
  constructor({ db, secretStore = new SecretStore() }) {
    this.db = db;
    this.secretStore = secretStore;
  }

  async list(userId) {
    const rows = await this.db.all(`SELECT ${PUBLIC_COLUMNS} FROM user_ssh_targets WHERE userId = ? ORDER BY displayName COLLATE NOCASE ASC, id ASC`, [String(userId)]);
    return rows.map(publicTarget);
  }

  async get(userId, id, { secrets = false } = {}) {
    if (typeof id !== 'string' || !id || id.length > 100) return null;
    const row = await this.db.get(`SELECT ${PUBLIC_COLUMNS} FROM user_ssh_targets WHERE id = ? AND userId = ?`, [id, String(userId)]);
    if (!row) return null;
    if (!secrets) return publicTarget(row);
    return {
      ...publicTarget(row),
      hostKeyType: row.hostKeyType || null,
      hostKeyData: row.hostKeyData || null,
      privateKey: this.secretStore.decrypt(row.encryptedPrivateKey),
      password: this.secretStore.decrypt(row.encryptedPassword),
      passphrase: this.secretStore.decrypt(row.encryptedPassphrase)
    };
  }

  async create(userId, input) {
    const values = validateTarget(input);
    const privateKey = values.privateKey;
    const password = values.password;
    if (values.authType === 'private-key' && !privateKey) throw invalid('A private key is required for private-key authentication.');
    if (values.authType === 'password' && !password) throw invalid('A password is required for password authentication.');
    const now = Date.now();
    const id = randomUUID();
    await this.db.run(`
      INSERT INTO user_ssh_targets
        (id, userId, displayName, host, port, username, authType, encryptedPrivateKey, encryptedPassword, encryptedPassphrase, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, String(userId), values.displayName, values.host, values.port, values.username, values.authType,
      privateKey ? this.secretStore.encrypt(privateKey) : null,
      password ? this.secretStore.encrypt(password) : null,
      values.passphrase ? this.secretStore.encrypt(values.passphrase) : null, now, now]);
    return this.get(userId, id);
  }

  async update(userId, id, input) {
    const current = await this.db.get(`SELECT ${PUBLIC_COLUMNS} FROM user_ssh_targets WHERE id = ? AND userId = ?`, [id, String(userId)]);
    if (!current) return null;
    const values = validateTarget(input, { partial: true });
    const metadata = {
      displayName: values.displayName ?? current.displayName,
      host: values.host ?? current.host,
      port: values.port ?? current.port,
      username: values.username ?? current.username,
      authType: values.authType ?? current.authType
    };
    const encrypted = {};
    for (const [name, column] of Object.entries(SECRET_COLUMNS)) {
      const clearName = `clear${name[0].toUpperCase()}${name.slice(1)}`;
      if (values[clearName]) encrypted[column] = null;
      else if (values[name] !== undefined) encrypted[column] = this.secretStore.encrypt(values[name]);
      else encrypted[column] = current[column] || null;
    }
    if (metadata.authType === 'private-key' && !encrypted.encryptedPrivateKey) throw invalid('A private key is required for private-key authentication.');
    if (metadata.authType === 'password' && !encrypted.encryptedPassword) throw invalid('A password is required for password authentication.');
    const now = Date.now();
    await this.db.run(`
      UPDATE user_ssh_targets
      SET displayName = ?, host = ?, port = ?, username = ?, authType = ?,
          encryptedPrivateKey = ?, encryptedPassword = ?, encryptedPassphrase = ?, updatedAt = ?
      WHERE id = ? AND userId = ?
    `, [metadata.displayName, metadata.host, metadata.port, metadata.username, metadata.authType,
      encrypted.encryptedPrivateKey, encrypted.encryptedPassword, encrypted.encryptedPassphrase, now, id, String(userId)]);
    return this.get(userId, id);
  }

  async remove(userId, id) {
    const result = await this.db.run('DELETE FROM user_ssh_targets WHERE id = ? AND userId = ?', [id, String(userId)]);
    return result.changes > 0;
  }

  async markConnected(userId, id) {
    await this.db.run('UPDATE user_ssh_targets SET lastConnectedAt = ? WHERE id = ? AND userId = ?', [Date.now(), id, String(userId)]);
  }
}

module.exports = { TargetStore, validateTarget, publicTarget };
