const { createHash } = require('node:crypto');

const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_ACTIVE_UPLOAD_SESSIONS = 1000;
const MAX_SESSION_MANIFEST_BYTES = 256 * 1024 * 1024;
const MAX_ACTIVE_MANIFEST_BYTES = 1024 * 1024 * 1024;
const ownerIdentity = owner => ({
  ownerIdType: typeof owner.id,
  ownerId: String(owner.id),
  username: owner.username
});
const sameOwner = (row, owner) => row && row.ownerIdType === typeof owner.id &&
  row.ownerId === String(owner.id) && row.username === owner.username;
const manifestHash = (size, chunkHashes) => {
  const digest = createHash('sha256');
  for (const chunkHash of chunkHashes) digest.update(Buffer.from(chunkHash, 'hex'));
  digest.update(String(size), 'utf8');
  return digest.digest('hex');
};
const publicFile = row => ({
  fileId: row.fileId,
  index: row.fileIndex,
  path: row.relativePath,
  name: row.fileName,
  size: row.size,
  chunkSize: row.sessionChunkSize,
  manifestHash: row.manifestHash,
  uploadedOffset: row.uploadedOffset,
  status: row.status
});

class UploadSessionStore {
  constructor({ db, now = Date.now } = {}) {
    if (!db || typeof db.get !== 'function' || typeof db.run !== 'function' || typeof db.all !== 'function') {
      throw new TypeError('A database adapter is required');
    }
    this.db = db;
    this.now = now;
    this.writes = Promise.resolve();
  }

  _write(work) {
    const result = this.writes.then(work);
    this.writes = result.catch(() => {});
    return result;
  }

  async create(context, { clientAttemptId, expectedFileCount, expectedDirectoryCount, chunkSize }) {
    const owner = ownerIdentity(context.owner);
    const now = this.now();
    const sessionId = require('node:crypto').randomUUID();
    try {
      const existing = await this._write(async () => {
        const prior = await this.db.get(`
          SELECT * FROM upload_sessions
          WHERE ownerIdType = ? AND ownerId = ? AND username = ? AND clientAttemptId = ?
        `, [owner.ownerIdType, owner.ownerId, owner.username, clientAttemptId]);
        if (prior) return prior;
        const active = await this.db.get(`
          SELECT COUNT(*) AS count FROM upload_sessions
          WHERE status IN ('manifest', 'uploading', 'cancelling') AND expiresAt > ?
        `, [now]);
        if (active.count >= MAX_ACTIVE_UPLOAD_SESSIONS) {
          throw Object.assign(new Error('Upload session capacity reached'), { statusCode: 429 });
        }
        await this.db.run(`
          INSERT INTO upload_sessions (
            sessionId, ownerIdType, ownerId, username, locationId, locationRevision,
            destinationPath, clientAttemptId, chunkSize, expectedFileCount,
            expectedDirectoryCount, status, createdAt, updatedAt, expiresAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manifest', ?, ?, ?)
        `, [sessionId, owner.ownerIdType, owner.ownerId, owner.username, context.locationId,
          context.locationRevision, context.path, clientAttemptId, chunkSize,
          expectedFileCount, expectedDirectoryCount, now, now, now + SESSION_TTL_MS]);
        return null;
      });
      if (existing) {
        if (existing.expiresAt > now &&
            existing.locationId === context.locationId && existing.locationRevision === context.locationRevision &&
            existing.destinationPath === context.path && existing.expectedFileCount === expectedFileCount &&
            existing.expectedDirectoryCount === expectedDirectoryCount && existing.chunkSize === chunkSize) {
          return { ...this.serialize(existing), created: false };
        }
        throw Object.assign(new Error('Upload attempt already exists or conflicts'), { statusCode: 409 });
      }
    } catch (error) {
      if (error.statusCode) throw error;
      if (/SQLITE_CONSTRAINT/.test(error.code || error.message)) {
        const existing = await this.db.get(`
          SELECT * FROM upload_sessions
          WHERE ownerIdType = ? AND ownerId = ? AND username = ? AND clientAttemptId = ?
        `, [owner.ownerIdType, owner.ownerId, owner.username, clientAttemptId]);
        if (existing && existing.expiresAt > now &&
            existing.locationId === context.locationId && existing.locationRevision === context.locationRevision &&
            existing.destinationPath === context.path && existing.expectedFileCount === expectedFileCount &&
            existing.expectedDirectoryCount === expectedDirectoryCount && existing.chunkSize === chunkSize) {
          return { ...this.serialize(existing), created: false };
        }
        throw Object.assign(new Error('Upload attempt already exists or conflicts'), { statusCode: 409 });
      }
      throw error;
    }
    return { ...this.serialize(await this.get(sessionId)), created: true };
  }

  async get(sessionId) {
    return this.db.get(`
      SELECT s.*,
        (SELECT COALESCE(SUM(f.uploadedOffset), 0) FROM upload_session_files f WHERE f.sessionId = s.sessionId) AS measuredUploadedSize
      FROM upload_sessions s WHERE s.sessionId = ?
    `, [sessionId]);
  }

  async getOwned(sessionId, owner) {
    const row = await this.get(sessionId);
    if (!sameOwner(row, owner)) return null;
    return row;
  }

  async list(owner) {
    const identity = ownerIdentity(owner);
    const rows = await this.db.all(`
      SELECT s.*,
        (SELECT COALESCE(SUM(f.uploadedOffset), 0) FROM upload_session_files f WHERE f.sessionId = s.sessionId) AS measuredUploadedSize
      FROM upload_sessions s
      WHERE ownerIdType = ? AND ownerId = ? AND username = ?
      ORDER BY createdAt DESC
    `, [identity.ownerIdType, identity.ownerId, identity.username]);
    return rows.map(row => this.serialize(row));
  }

  async listAllActive() {
    return this.db.all(`
      SELECT * FROM upload_sessions
      WHERE status NOT IN ('cancelled', 'failed', 'expired')
      ORDER BY createdAt
    `);
  }

  async addManifestPage(session, { pageIndex, fileOffset, directoryOffset, files, directories }) {
    return this._write(async () => {
      if (session.status !== 'manifest' || session.manifestComplete) {
        throw Object.assign(new Error('Upload manifest is already sealed'), { statusCode: 409 });
      }
      const fileData = files.map((file, offset) => ({
        ...file,
        fileIndex: fileOffset + offset,
        collisionKey: file.relativePath.normalize('NFC').toLowerCase(),
        manifestHash: manifestHash(file.size, file.chunkHashes),
        chunkHashes: JSON.stringify(file.chunkHashes)
      }));
      const previousFile = fileOffset === 0 ? null : await this.db.get(`
        SELECT relativePath FROM upload_session_files WHERE sessionId = ? AND fileIndex = ?
      `, [session.sessionId, fileOffset - 1]);
      let previousPath = previousFile?.relativePath;
      for (const file of fileData) {
        const currentPath = file.relativePath;
        if (previousPath !== undefined && Buffer.compare(Buffer.from(previousPath, 'utf8'), Buffer.from(currentPath, 'utf8')) > 0) {
          throw Object.assign(new Error('Upload manifest files must be sorted by destination path'), { statusCode: 400 });
        }
        previousPath = currentPath;
      }
      const body = JSON.stringify({ fileOffset, directoryOffset, files: fileData, directories });
      const contentBytes = Buffer.byteLength(body);
      const contentHash = createHash('sha256').update(body).digest('hex');
      const preceding = await this.db.get(`
        SELECT COALESCE(SUM(fileCount), 0) AS fileCount,
               COALESCE(SUM(directoryCount), 0) AS directoryCount
        FROM upload_session_manifest_pages WHERE sessionId = ? AND pageIndex < ?
      `, [session.sessionId, pageIndex]);
      if (preceding.fileCount !== fileOffset || preceding.directoryCount !== directoryOffset) {
        throw Object.assign(new Error('Manifest page offsets are out of order'), { statusCode: 409 });
      }
      const existingPage = await this.db.get(`
        SELECT contentHash, fileOffset, directoryOffset, fileCount, directoryCount
        FROM upload_session_manifest_pages WHERE sessionId = ? AND pageIndex = ?
      `, [session.sessionId, pageIndex]);
      const pageCount = await this.db.get(
        'SELECT COUNT(*) AS count FROM upload_session_manifest_pages WHERE sessionId = ?', [session.sessionId]
      );
      if (!existingPage && pageIndex !== pageCount.count) {
        throw Object.assign(new Error('Manifest pages must be submitted in order'), { statusCode: 409 });
      }
      if (existingPage && (existingPage.contentHash !== contentHash || existingPage.fileOffset !== fileOffset ||
          existingPage.directoryOffset !== directoryOffset || existingPage.fileCount !== files.length ||
          existingPage.directoryCount !== directories.paths.length)) {
        throw Object.assign(new Error('Manifest page does not match its previous submission'), { statusCode: 409 });
      }
      if (!existingPage) {
        const [sessionSize, activeSize] = await Promise.all([
          this.db.get('SELECT COALESCE(SUM(contentBytes), 0) AS bytes FROM upload_session_manifest_pages WHERE sessionId = ?', [session.sessionId]),
          this.db.get(`SELECT COALESCE(SUM(p.contentBytes), 0) AS bytes
            FROM upload_session_manifest_pages p JOIN upload_sessions s ON s.sessionId = p.sessionId
            WHERE s.expiresAt > ?`, [this.now()])
        ]);
        if (sessionSize.bytes + contentBytes > MAX_SESSION_MANIFEST_BYTES || activeSize.bytes + contentBytes > MAX_ACTIVE_MANIFEST_BYTES) {
          throw Object.assign(new Error('Upload manifest storage capacity reached'), { statusCode: 429 });
        }
        await this.db.run(`
          INSERT INTO upload_session_manifest_pages(
            sessionId, pageIndex, fileOffset, directoryOffset, fileCount, directoryCount, contentBytes, contentHash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [session.sessionId, pageIndex, fileOffset, directoryOffset,
          files.length, directories.paths.length, contentBytes, contentHash]);
      }
      const now = this.now();
      for (const file of fileData) {
        const existing = await this.db.get('SELECT * FROM upload_session_files WHERE fileId = ?', [file.fileId]);
        if (existing) {
          if (existing.sessionId !== session.sessionId || existing.fileIndex !== file.fileIndex ||
              existing.relativePath !== file.relativePath || existing.size !== file.size ||
              existing.chunkHashes !== file.chunkHashes || existing.collisionKey !== file.collisionKey ||
              existing.manifestHash !== file.manifestHash) {
            throw Object.assign(new Error('Manifest file conflicts with an existing entry'), { statusCode: 409 });
          }
          continue;
        }
        await this.db.run(`
          INSERT INTO upload_session_files(
            fileId, sessionId, fileIndex, relativePath, collisionKey, fileName, size, chunkHashes, manifestHash,
            uploadedOffset, status, createdAt, updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)
        `, [file.fileId, session.sessionId, file.fileIndex, file.relativePath, file.collisionKey,
          file.fileName, file.size, file.chunkHashes, file.manifestHash, now, now]);
      }
      const currentDirectories = await this.db.all(`
        SELECT directoryIndex, relativePath FROM upload_session_directories WHERE sessionId = ?
      `, [session.sessionId]);
      for (let index = 0; index < directories.paths.length; index++) {
        const directoryIndex = directoryOffset + index;
        const previous = currentDirectories.find(item => item.directoryIndex === directoryIndex);
        if (previous && previous.relativePath !== directories.paths[index]) {
          throw Object.assign(new Error('Manifest directory conflicts with an existing entry'), { statusCode: 409 });
        }
        if (!previous) await this.db.run(`
          INSERT INTO upload_session_directories(sessionId, directoryIndex, relativePath) VALUES (?, ?, ?)
        `, [session.sessionId, directoryIndex, directories.paths[index]]);
      }
      await this.db.run('UPDATE upload_sessions SET updatedAt = ? WHERE sessionId = ?', [now, session.sessionId]);
      return { pageIndex, fileCount: fileData.length, directoryCount: directories.paths.length };
    });
  }

  async sealManifest(session) {
    return this._write(async () => {
      const [files, directories] = await Promise.all([
        this.db.all('SELECT size FROM upload_session_files WHERE sessionId = ?', [session.sessionId]),
        this.db.all('SELECT relativePath FROM upload_session_directories WHERE sessionId = ?', [session.sessionId])
      ]);
      if (files.length !== session.expectedFileCount || directories.length !== session.expectedDirectoryCount) {
        throw Object.assign(new Error('Upload manifest is incomplete'), { statusCode: 400 });
      }
      const totalSize = files.reduce((sum, file) => sum + file.size, 0);
      if (!Number.isSafeInteger(totalSize)) throw Object.assign(new Error('Upload size exceeds supported range'), { statusCode: 413 });
      await this.db.run(`
        UPDATE upload_sessions SET manifestComplete = 1, totalSize = ?, status = 'uploading', updatedAt = ?
        WHERE sessionId = ? AND manifestComplete = 0 AND status = 'manifest'
      `, [totalSize, this.now(), session.sessionId]);
      const sealed = await this.get(session.sessionId);
      if (!sealed?.manifestComplete) throw Object.assign(new Error('Upload manifest could not be sealed'), { statusCode: 409 });
      return sealed;
    });
  }

  async getFile(sessionId, fileId) {
    const row = await this.db.get(`
      SELECT f.*, s.chunkSize AS sessionChunkSize
      FROM upload_session_files f JOIN upload_sessions s ON s.sessionId = f.sessionId
      WHERE f.sessionId = ? AND f.fileId = ?
    `, [sessionId, fileId]);
    if (!row) return null;
    row.chunkSize = row.sessionChunkSize;
    row.chunkHashes = JSON.parse(row.chunkHashes);
    return row;
  }

  async hasEarlierCollision(sessionId, file) {
    const row = await this.db.get(`
      SELECT fileId FROM upload_session_files
      WHERE sessionId = ? AND collisionKey = ? AND fileIndex < ? AND status != 'completed'
      LIMIT 1
    `, [sessionId, file.relativePath.normalize('NFC').toLowerCase(), file.fileIndex]);
    return Boolean(row);
  }

  async getFiles(sessionId, offset = 0, limit = 100000) {
    const rows = await this.db.all(`
      SELECT f.*, s.chunkSize AS sessionChunkSize
      FROM upload_session_files f JOIN upload_sessions s ON s.sessionId = f.sessionId
      WHERE f.sessionId = ? ORDER BY f.fileIndex LIMIT ? OFFSET ?
    `, [sessionId, limit, offset]);
    return rows.map(publicFile);
  }

  async getFilesInternal(sessionId) {
    return this.db.all('SELECT * FROM upload_session_files WHERE sessionId = ? ORDER BY fileIndex', [sessionId]);
  }

  async getDirectories(sessionId, offset = 0, limit = 100000) {
    const rows = await this.db.all(`
      SELECT relativePath FROM upload_session_directories
      WHERE sessionId = ? ORDER BY directoryIndex LIMIT ? OFFSET ?
    `, [sessionId, limit, offset]);
    return rows.map(row => row.relativePath);
  }

  async manifestSize(sessionId) {
    const row = await this.db.get('SELECT COALESCE(SUM(size), 0) AS totalSize FROM upload_session_files WHERE sessionId = ?', [sessionId]);
    return row?.totalSize || 0;
  }

  async outstandingBytes(excludeSessionId = null, now = this.now()) {
    const row = await this.db.get(`
      SELECT COALESCE(SUM(totalSize - (
        SELECT COALESCE(SUM(f.uploadedOffset), 0) FROM upload_session_files f WHERE f.sessionId = s.sessionId
      )), 0) AS totalBytes
      FROM upload_sessions s
      WHERE manifestComplete = 1 AND status = 'uploading' AND expiresAt > ? AND (? IS NULL OR sessionId != ?)
    `, [now, excludeSessionId, excludeSessionId]);
    return row?.totalBytes || 0;
  }

  async advanceOffset(sessionId, file, expectedOffset, nextOffset) {
    return this._write(async () => {
      const result = await this.db.run(`
        UPDATE upload_session_files SET uploadedOffset = ?, status = 'uploading', updatedAt = ?
        WHERE sessionId = ? AND fileId = ? AND uploadedOffset = ? AND status IN ('pending', 'uploading')
          AND EXISTS (
            SELECT 1 FROM upload_sessions s
            WHERE s.sessionId = upload_session_files.sessionId AND s.status = 'uploading' AND s.expiresAt > ?
          )
      `, [nextOffset, this.now(), sessionId, file.fileId, expectedOffset, this.now()]);
      if (result.changes !== 1) return false;
      await this.db.run(`
        UPDATE upload_sessions SET uploadedSize = (
          SELECT COALESCE(SUM(uploadedOffset), 0) FROM upload_session_files WHERE sessionId = ?
        ), updatedAt = ? WHERE sessionId = ?
      `, [sessionId, this.now(), sessionId]);
      return true;
    });
  }

  async resetFileOffset(sessionId, fileId) {
    return this._write(async () => {
      await this.db.run(`
        UPDATE upload_session_files SET uploadedOffset = 0, status = 'pending', updatedAt = ?
        WHERE sessionId = ? AND fileId = ? AND status != 'completed'
      `, [this.now(), sessionId, fileId]);
      await this.db.run(`
        UPDATE upload_sessions SET uploadedSize = (
          SELECT COALESCE(SUM(uploadedOffset), 0) FROM upload_session_files WHERE sessionId = ?
        ), updatedAt = ? WHERE sessionId = ?
      `, [sessionId, this.now(), sessionId]);
    });
  }

  async updateFile(sessionId, fileId, { status, publishPath, publishTempPath } = {}) {
    const assignments = [];
    const values = [];
    if (status !== undefined) { assignments.push('status = ?'); values.push(status); }
    if (publishPath !== undefined) { assignments.push('publishPath = ?'); values.push(publishPath); }
    if (publishTempPath !== undefined) { assignments.push('publishTempPath = ?'); values.push(publishTempPath); }
    assignments.push('updatedAt = ?');
    values.push(this.now(), sessionId, fileId);
    return this._write(() => this.db.run(`
      UPDATE upload_session_files SET ${assignments.join(', ')} WHERE sessionId = ? AND fileId = ?
    `, values));
  }

  async updateSession(sessionId, status) {
    return this._write(() => this.db.run(
      'UPDATE upload_sessions SET status = ?, updatedAt = ? WHERE sessionId = ?',
      [status, this.now(), sessionId]
    ));
  }

  async transitionSession(sessionId, status, fromStatuses) {
    if (!Array.isArray(fromStatuses) || !fromStatuses.length) throw new TypeError('Expected source statuses are required');
    const placeholders = fromStatuses.map(() => '?').join(', ');
    return this._write(() => this.db.run(`
      UPDATE upload_sessions SET status = ?, updatedAt = ?
      WHERE sessionId = ? AND status IN (${placeholders})
    `, [status, this.now(), sessionId, ...fromStatuses]));
  }

  async expired(now = this.now()) {
    return this.db.all('SELECT * FROM upload_sessions WHERE expiresAt <= ? OR status = \'cancelled\'', [now]);
  }

  async remove(sessionId) {
    return this._write(() => this.db.run('DELETE FROM upload_sessions WHERE sessionId = ?', [sessionId]));
  }

  serialize(row) {
    if (!row) return null;
    return {
      sessionId: row.sessionId,
      clientAttemptId: row.clientAttemptId,
      locationId: row.locationId,
      path: row.destinationPath,
      chunkSize: row.chunkSize,
      expectedFileCount: row.expectedFileCount,
      expectedDirectoryCount: row.expectedDirectoryCount,
      totalSize: row.totalSize,
      uploadedSize: row.measuredUploadedSize ?? row.uploadedSize,
      manifestComplete: row.manifestComplete === 1,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      expiresAt: row.expiresAt
    };
  }
}

module.exports = { UploadSessionStore, SESSION_TTL_MS };
