/**
 * Share Link Manager
 * Handles creation, validation, and management of file share links
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../database/db');
const configManager = require('../config/index');
const { systemLogger } = require('../utils/logger');

class ShareManager {
  /**
   * Create a new share link
   * @param {string} userId - User ID creating the share link
   * @param {string} filePath - Path to the file being shared
   * @param {string} fileName - Name of the file
   * @param {Object} options - Share link options
   * @param {number} options.expiresIn - Expiration time in seconds
   * @param {number} options.maxDownloads - Maximum number of downloads (0 = unlimited)
   * @param {string} options.password - Optional password protection
   * @returns {Promise<Object>} Share link metadata
   */
  async createShareLink(userId, filePath, fileName, options = {}) {
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
      let expiresIn = options.expiresIn || config.defaultExpiration;

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

      // Set max downloads
      const maxDownloads = options.maxDownloads || config.maxDownloadsDefault || 0;

      // Insert into database
      await db.run(
        `INSERT INTO share_links
         (shareToken, userId, filePath, fileName, createdAt, expiresAt, maxDownloads, downloadCount, password, isActive)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1)`,
        [shareToken, userId, filePath, fileName, createdAt, expiresAt, maxDownloads, hashedPassword]
      );

      systemLogger.logSystem('INFO', `Share link created: ${shareToken} by user ${userId}`);

      return {
        shareToken,
        shareUrl: `/share.html?token=${shareToken}`,
        directDownloadUrl: `/api/share/${shareToken}/download`,
        expiresAt,
        maxDownloads,
        createdAt
      };
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to create share link: ${error.message}`);
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
    try {
      const shareLink = await db.get(
        'SELECT * FROM share_links WHERE shareToken = ? AND isActive = 1',
        [shareToken]
      );

      if (!shareLink) {
        return null;
      }

      // Check if expired
      if (shareLink.expiresAt && Date.now() > shareLink.expiresAt) {
        return { error: '此分享連結已過期', status: 410 };
      }

      // Check download limit
      if (shareLink.maxDownloads > 0 && shareLink.downloadCount >= shareLink.maxDownloads) {
        return { error: '此分享連結已達下載次數上限', status: 410 };
      }

      // Check password protection
      if (shareLink.password) {
        if (!password) {
          return { error: '此分享連結需要密碼', status: 401 };
        }

        const isPasswordValid = await bcrypt.compare(password, shareLink.password);
        if (!isPasswordValid) {
          return { error: '密碼錯誤', status: 401 };
        }
      }

      return shareLink;
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to validate share token: ${error.message}`);
      throw error;
    }
  }

  /**
   * Increment download counter for a share link
   * @param {string} shareToken - Share token
   * @returns {Promise<void>}
   */
  async incrementDownloadCount(shareToken) {
    try {
      await db.run(
        `UPDATE share_links
         SET downloadCount = downloadCount + 1, lastDownloadAt = ?
         WHERE shareToken = ?`,
        [Date.now(), shareToken]
      );

      systemLogger.logSystem('INFO', `Download count incremented for share token: ${shareToken}`);
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to increment download count: ${error.message}`);
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
    try {
      const result = await db.run(
        'UPDATE share_links SET isActive = 0 WHERE shareToken = ? AND userId = ?',
        [shareToken, userId]
      );

      if (result.changes === 0) {
        return false;
      }

      systemLogger.logSystem('INFO', `Share link revoked: ${shareToken} by user ${userId}`);
      return true;
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to revoke share link: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all share links for a user
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Array of share link objects
   */
  async getUserShareLinks(userId) {
    try {
      const shareLinks = await db.all(
        'SELECT id, shareToken, filePath, fileName, createdAt, expiresAt, maxDownloads, downloadCount, isActive, lastDownloadAt FROM share_links WHERE userId = ? ORDER BY createdAt DESC',
        [userId]
      );

      return shareLinks.map(link => ({
        ...link,
        remainingDownloads: link.maxDownloads > 0 ? Math.max(0, link.maxDownloads - link.downloadCount) : null,
        isExpired: link.expiresAt && Date.now() > link.expiresAt,
        isExhausted: link.maxDownloads > 0 && link.downloadCount >= link.maxDownloads
      }));
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to get user share links: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get share link information
   * @param {string} shareToken - Share token
   * @returns {Promise<Object|null>} Share link metadata
   */
  async getShareLinkInfo(shareToken) {
    try {
      const shareLink = await db.get(
        'SELECT id, shareToken, fileName, createdAt, expiresAt, maxDownloads, downloadCount, isActive, lastDownloadAt FROM share_links WHERE shareToken = ?',
        [shareToken]
      );

      if (!shareLink) {
        return null;
      }

      return {
        ...shareLink,
        remainingDownloads: shareLink.maxDownloads > 0 ? Math.max(0, shareLink.maxDownloads - shareLink.downloadCount) : null,
        isExpired: shareLink.expiresAt && Date.now() > shareLink.expiresAt,
        isExhausted: shareLink.maxDownloads > 0 && shareLink.downloadCount >= shareLink.maxDownloads
      };
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to get share link info: ${error.message}`);
      throw error;
    }
  }

  /**
   * Clean up expired and exhausted share links
   * @returns {Promise<number>} Number of deleted records
   */
  async cleanupExpiredLinks() {
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
      systemLogger.logSystem('ERROR', `Failed to cleanup expired links: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new ShareManager();
