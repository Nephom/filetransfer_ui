/**
 * Share Link Manager
 * Handles creation, validation, and management of file share links
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
class ShareManager {
  constructor({ db, configManager, logger } = {}) {
    this.db = db;
    this.configManager = configManager;
    this.logger = logger;
  }

  get dependencies() {
    return {
      db: this.db || require('../database/db'),
      configManager: this.configManager || require('../config/index'),
      systemLogger: this.logger || require('../utils/logger').systemLogger
    };
  }
  /**
   * Create a new share link
   * @param {string} userId - User ID creating the share link
   * @param {string} filePath - Path to the file being shared
   * @param {string} fileName - Name of the file
   * @param {Object} options - Share link options
   * @param {number} options.expiresIn - Expiration time in seconds
   * @param {number} options.maxDownloads - Maximum number of downloads (0 = unlimited)
    * @param {string} options.password - Optional password protection
    * @param {Function} options.assertLocationCurrent - Synchronous creation-context guard
   * @returns {Promise<Object>} Share link metadata
   */
  async createShareLink(userId, filePath, fileName, options = {}) {
    const { db, configManager, systemLogger } = this.dependencies;
    try {
      const config = configManager.get('shareLinks');

      // Validate share links are enabled
      if (!config || !config.enabled) {
        throw new Error('Share links are disabled');
      }

      // Generate secure random token
      const shareToken = crypto.randomBytes(32).toString('hex');

      // Calculate expiration time
      const createdAt = Date.now();
      const expiresIn = options.expiresIn ?? config.defaultExpiration;
      const maxDownloads = options.maxDownloads ?? config.maxDownloadsDefault ?? 0;
      if (!Number.isSafeInteger(expiresIn) || expiresIn < 0 ||
          !Number.isSafeInteger(maxDownloads) || maxDownloads < 0 ||
          (options.password != null && typeof options.password !== 'string')) {
        throw Object.assign(new Error('Invalid share options'), { statusCode: 400 });
      }

      // Validate expiration doesn't exceed maximum
      if (expiresIn > config.maxExpiration) {
        throw new Error(`分享連結有效期不能超過 ${Math.floor(config.maxExpiration / 86400)} 天`);
      }

      const expiresAt = expiresIn > 0 ? createdAt + (expiresIn * 1000) : null;

      // Handle password protection
      let hashedPassword = null;
      if (options.password) {
        if (!config.allowPasswordProtection) {
          throw new Error('系統不支持密碼保護的分享連結');
        }
        hashedPassword = await bcrypt.hash(options.password, 10);
      }

      // Password hashing yields. Recheck the captured Location before enqueueing
      // the INSERT, without another await between the guard and database call.
      options.assertLocationCurrent?.();
      await db.run(
        `INSERT INTO share_links
         (shareToken, userId, locationId, filePath, fileName, createdAt, expiresAt, maxDownloads, downloadCount, password, isActive)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1)`,
        [shareToken, userId, options.locationId || 'default', filePath, fileName, createdAt, expiresAt, maxDownloads, hashedPassword]
      );

      systemLogger.logSystem('INFO', 'Share link created');

      return {
        shareToken,
        shareUrl: `/share.html?token=${shareToken}`,
        directDownloadUrl: `/api/share/${shareToken}/download`,
        hasPassword: !!hashedPassword,
        directDownloadMethod: hashedPassword ? 'POST' : 'GET',
        supportsDirectDownload: !hashedPassword,
        expiresAt,
        maxDownloads,
        createdAt
      };
    } catch (error) {
      systemLogger.logSystem('ERROR', 'Failed to create share link');
      throw error;
    }
  }

  /**
   * Validate a share token
   * @param {string} shareToken - Share token to validate
   * @param {string} password - Optional password for protected links
   * @returns {Promise<Object|null>} Share link metadata if valid, null otherwise
   */
  async validateShareToken(shareToken, password = null) {
    const { db, systemLogger } = this.dependencies;
    try {
      const shareLink = await db.get(
        'SELECT * FROM share_links WHERE shareToken = ? AND isActive = 1',
        [shareToken]
      );

      if (!shareLink) {
        return null;
      }

      // Check if expired
      if (shareLink.expiresAt != null && Date.now() >= shareLink.expiresAt) {
        return { error: '此分享連結已過期', status: 410 };
      }

      // Check download limit
      if (shareLink.maxDownloads > 0 && shareLink.downloadCount >= shareLink.maxDownloads) {
        return { error: '此分享連結已達下載次數上限', status: 410 };
      }

      // Check password protection
      if (shareLink.password) {
        if (typeof password !== 'string' || !password) {
          return { error: '此分享連結需要密碼', status: 401 };
        }

        const isPasswordValid = await bcrypt.compare(password, shareLink.password);
        if (!isPasswordValid) {
          return { error: '密碼錯誤', status: 401 };
        }
      }

      return shareLink;
    } catch (error) {
      systemLogger.logSystem('ERROR', 'Failed to validate share token');
      throw error;
    }
  }

  /**
   * Admit one body transfer. Each Range request consumes one admission.
   * @param {string} shareToken - Share token
   * @returns {Promise<boolean>}
   */
  async admitDownload(shareToken) {
    const { db, systemLogger } = this.dependencies;
    try {
      const now = Date.now();
      const result = await db.run(
        `UPDATE share_links
         SET downloadCount = downloadCount + 1, lastDownloadAt = ?
         WHERE shareToken = ? AND isActive = 1
           AND (expiresAt IS NULL OR expiresAt > ?)
           AND (maxDownloads = 0 OR downloadCount < maxDownloads)`,
        [now, shareToken, now]
      );
      return result.changes === 1;
    } catch (error) {
      systemLogger.logSystem('ERROR', 'Failed to admit share download');
      throw error;
    }
  }

  /**
   * Revoke a share link
   * @param {string} shareToken - Share token to revoke
   * @param {string} userId - User ID requesting revocation
   * @returns {Promise<boolean>} True if revoked successfully
   */
  async revokeShareLink(shareToken, userId) {
    const { db, systemLogger } = this.dependencies;
    try {
      const result = await db.run(
        'UPDATE share_links SET isActive = 0 WHERE shareToken = ? AND userId = ?',
        [shareToken, userId]
      );

      if (result.changes === 0) {
        return false;
      }

      systemLogger.logSystem('INFO', 'Share link revoked');
      return true;
    } catch (error) {
      systemLogger.logSystem('ERROR', 'Failed to revoke share link');
      throw error;
    }
  }

  /**
   * Permanently remove an expired share link from the owner's history.
   * Active links must be revoked first and cannot be deleted through this method.
   */
  async deleteExpiredShareLink(shareToken, userId) {
    const { db, systemLogger } = this.dependencies;
    try {
      const result = await db.run(
        'DELETE FROM share_links WHERE shareToken = ? AND userId = ? AND expiresAt IS NOT NULL AND expiresAt < ?',
        [shareToken, userId, Date.now()]
      );

      if (result.changes === 0) {
        return false;
      }

      systemLogger.logSystem('INFO', 'Expired share link deleted');
      return true;
    } catch (error) {
      systemLogger.logSystem('ERROR', 'Failed to delete expired share link');
      throw error;
    }
  }

  /**
   * Permanently remove a revoked share link from the owner's history.
   */
  async deleteRevokedShareLink(shareToken, userId) {
    const { db, systemLogger } = this.dependencies;
    try {
      const result = await db.run(
        'DELETE FROM share_links WHERE shareToken = ? AND userId = ? AND isActive = 0',
        [shareToken, userId]
      );

      if (result.changes === 0) {
        return false;
      }

      systemLogger.logSystem('INFO', 'Revoked share link deleted');
      return true;
    } catch (error) {
      systemLogger.logSystem('ERROR', 'Failed to delete revoked share link');
      throw error;
    }
  }

  async revokeShareLinkAsAdmin(shareToken) {
    const { db } = this.dependencies;
    const result = await db.run('UPDATE share_links SET isActive = 0 WHERE shareToken = ?', [shareToken]);
    return result.changes > 0;
  }

  async deleteExpiredShareLinkAsAdmin(shareToken) {
    const { db } = this.dependencies;
    const result = await db.run(
      'DELETE FROM share_links WHERE shareToken = ? AND expiresAt IS NOT NULL AND expiresAt < ?',
      [shareToken, Date.now()]
    );
    return result.changes > 0;
  }

  async deleteRevokedShareLinkAsAdmin(shareToken) {
    const { db } = this.dependencies;
    const result = await db.run('DELETE FROM share_links WHERE shareToken = ? AND isActive = 0', [shareToken]);
    return result.changes > 0;
  }

  /**
   * Get all share links for a user
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Array of share link objects
   */
  async getUserShareLinks(userId) {
    const { db, systemLogger } = this.dependencies;
    try {
      const shareLinks = await db.all(
        "SELECT id, shareToken, locationId, filePath, fileName, createdAt, expiresAt, maxDownloads, downloadCount, isActive, lastDownloadAt, (password IS NOT NULL AND password != '') AS hasPassword FROM share_links WHERE userId = ? ORDER BY createdAt DESC",
        [userId]
      );

      return shareLinks.map(link => ({
        ...link,
        hasPassword: !!link.hasPassword,
        directDownloadMethod: link.hasPassword ? 'POST' : 'GET',
        supportsDirectDownload: !link.hasPassword,
        shareUrl: `/share.html?token=${link.shareToken}`,
        directDownloadUrl: `/api/share/${link.shareToken}/download`,
        remainingDownloads: link.maxDownloads > 0 ? Math.max(0, link.maxDownloads - link.downloadCount) : null,
        isExpired: link.expiresAt != null && Date.now() >= link.expiresAt,
        isExhausted: link.maxDownloads > 0 && link.downloadCount >= link.maxDownloads
      }));
    } catch (error) {
      systemLogger.logSystem('ERROR', 'Failed to get user share links');
      throw error;
    }
  }

  /**
   * Get every share link for admin management, including its owner id.
   */
  async getAllShareLinks() {
    const { db, systemLogger } = this.dependencies;
    try {
      const shareLinks = await db.all(
        "SELECT id, shareToken, userId, locationId, filePath, fileName, createdAt, expiresAt, maxDownloads, downloadCount, isActive, lastDownloadAt, (password IS NOT NULL AND password != '') AS hasPassword FROM share_links ORDER BY createdAt DESC"
      );

      return shareLinks.map(link => ({
        ...link,
        hasPassword: !!link.hasPassword,
        directDownloadMethod: link.hasPassword ? 'POST' : 'GET',
        supportsDirectDownload: !link.hasPassword,
        shareUrl: `/share.html?token=${link.shareToken}`,
        directDownloadUrl: `/api/share/${link.shareToken}/download`,
        remainingDownloads: link.maxDownloads > 0 ? Math.max(0, link.maxDownloads - link.downloadCount) : null,
        isExpired: link.expiresAt != null && Date.now() >= link.expiresAt,
        isExhausted: link.maxDownloads > 0 && link.downloadCount >= link.maxDownloads
      }));
    } catch (error) {
      systemLogger.logSystem('ERROR', 'Failed to get all share links');
      throw error;
    }
  }

  /**
   * Get share link information
   * @param {string} shareToken - Share token
   * @returns {Promise<Object|null>} Share link metadata
   */
  async getShareLinkInfo(shareToken) {
    const { db, systemLogger } = this.dependencies;
    try {
      const shareLink = await db.get(
        "SELECT id, shareToken, locationId, fileName, createdAt, expiresAt, maxDownloads, downloadCount, isActive, lastDownloadAt, (password IS NOT NULL AND password != '') AS hasPassword FROM share_links WHERE shareToken = ?",
        [shareToken]
      );

      if (!shareLink) {
        return null;
      }

      return {
        ...shareLink,
        hasPassword: !!shareLink.hasPassword,
        directDownloadMethod: shareLink.hasPassword ? 'POST' : 'GET',
        supportsDirectDownload: !shareLink.hasPassword,
        remainingDownloads: shareLink.maxDownloads > 0 ? Math.max(0, shareLink.maxDownloads - shareLink.downloadCount) : null,
        isExpired: shareLink.expiresAt != null && Date.now() >= shareLink.expiresAt,
        isExhausted: shareLink.maxDownloads > 0 && shareLink.downloadCount >= shareLink.maxDownloads
      };
    } catch (error) {
      systemLogger.logSystem('ERROR', 'Failed to get share link info');
      throw error;
    }
  }

  /**
   * Clean up expired and exhausted share links
   * @returns {Promise<number>} Number of deleted records
   */
  async cleanupExpiredLinks() {
    const { db, systemLogger } = this.dependencies;
    try {
      const now = Date.now();
      const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
      const oneDayAgo = now - (24 * 60 * 60 * 1000);

      // Delete expired links older than 7 days
      const expiredResult = await db.run(
        'DELETE FROM share_links WHERE expiresAt IS NOT NULL AND expiresAt < ?',
        [sevenDaysAgo]
      );

      // Delete exhausted links older than 24 hours
      const exhaustedResult = await db.run(
        'DELETE FROM share_links WHERE maxDownloads > 0 AND downloadCount >= maxDownloads AND createdAt < ?',
        [oneDayAgo]
      );

      const totalDeleted = expiredResult.changes + exhaustedResult.changes;

      systemLogger.logSystem('INFO', `Cleaned up ${totalDeleted} share links (${expiredResult.changes} expired, ${exhaustedResult.changes} exhausted)`);

      return totalDeleted;
    } catch (error) {
      systemLogger.logSystem('ERROR', 'Failed to cleanup expired links');
      throw error;
    }
  }
}

module.exports = new ShareManager();
module.exports.ShareManager = ShareManager;
