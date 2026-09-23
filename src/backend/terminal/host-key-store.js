const crypto = require('node:crypto');
const { utils: { parseKey } } = require('ssh2');
const { systemLogger } = require('../utils/logger');

const toKeyBuffer = key => Buffer.isBuffer(key) ? Buffer.from(key) : Buffer.from(String(key), 'utf8');
const fingerprintFor = key => `SHA256:${crypto.createHash('sha256').update(toKeyBuffer(key)).digest('base64').replace(/=+$/u, '')}`;

const keyTypeFor = key => {
  try {
    const parsed = parseKey(toKeyBuffer(key));
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return first?.type || 'unknown';
  } catch {
    return 'unknown';
  }
};

class HostKeyStore {
  constructor({ db }) {
    this.db = db;
  }

  async record({ userId, target, key }) {
    const rawKey = toKeyBuffer(key);
    const fingerprint = fingerprintFor(rawKey);
    const keyData = rawKey.toString('base64');
    const existing = await this.db.get(
      'SELECT hostKeyFingerprint, hostKeyData FROM user_ssh_targets WHERE id = ? AND userId = ?',
      [target.id, String(userId)]
    );
    if (!existing) throw new Error('SSH target is no longer available.');
    if (existing.hostKeyFingerprint === fingerprint && existing.hostKeyData === keyData) return { fingerprint, changed: false };

    const now = Date.now();
    const update = await this.db.run(`
      UPDATE user_ssh_targets
      SET hostKeyType = ?, hostKeyData = ?, hostKeyFingerprint = ?, updatedAt = ?
      WHERE id = ? AND userId = ?
    `, [keyTypeFor(rawKey), keyData, fingerprint, now, target.id, String(userId)]);
    if (update.changes !== 1) throw new Error('SSH target is no longer available.');

    if (existing.hostKeyFingerprint) {
      await this.db.run(`
        INSERT INTO terminal_audit_events
          (eventType, userId, targetId, host, port, oldFingerprint, newFingerprint, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, ['host_key_overwritten', String(userId), target.id, target.host, target.port, existing.hostKeyFingerprint, fingerprint, now]);
      Promise.resolve(systemLogger.logSystem('WARN', `SSH host key overwritten: userId=${String(userId)} targetId=${target.id} host=${target.host} port=${target.port} oldFingerprint=${existing.hostKeyFingerprint} newFingerprint=${fingerprint}`)).catch(() => {});
    }
    return { fingerprint, changed: Boolean(existing.hostKeyFingerprint) };
  }
}

module.exports = { HostKeyStore, fingerprintFor, keyTypeFor };
