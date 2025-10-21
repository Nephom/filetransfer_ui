/**
 * Share Link API Endpoints
 * Handles file sharing via secure, time-limited download links
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const shareManager = require('../auth/share-manager');
const configManager = require('../config/index');
const { systemLogger } = require('../utils/logger');
const { authenticate } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

// Rate limiter for share link creation (max 10 per minute per user)
const createShareLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { success: false, message: '創建分享連結過於頻繁，請稍後再試' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for failed download attempts (max 100 per hour per IP)
const downloadFailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100,
  skipSuccessfulRequests: true,
  message: { success: false, message: '請求過於頻繁，請稍後再試' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * POST /api/files/share
 * Create a new share link (authenticated)
 */
router.post('/files/share', authenticate, createShareLimiter, async (req, res) => {
  try {
    const { filePath, expiresIn, maxDownloads, password } = req.body;

    // Get user from JWT (set by auth middleware)
    const userId = req.user?.id || req.user?.username || 'anonymous';

    if (!filePath) {
      return res.status(400).json({ success: false, message: '文件路徑不能為空' });
    }

    // Security: Prevent path traversal
    const normalizedPath = path.normalize(filePath);
    if (normalizedPath.includes('..')) {
      systemLogger.logSystem('WARN', `Path traversal attempt detected: ${filePath}`);
      return res.status(400).json({ success: false, message: '無效的文件路徑' });
    }

    // Get storage path from config
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const fullPath = path.join(storagePath, normalizedPath);

    // Check if file exists
    try {
      const stats = await fs.stat(fullPath);
      if (!stats.isFile()) {
        return res.status(400).json({ success: false, message: '只能分享文件，不能分享目錄' });
      }
    } catch (error) {
      return res.status(404).json({ success: false, message: '文件不存在' });
    }

    // Extract file name
    const fileName = path.basename(normalizedPath);

    // Create share link
    const shareLink = await shareManager.createShareLink(
      userId,
      normalizedPath,
      fileName,
      {
        expiresIn: expiresIn ? parseInt(expiresIn) : undefined,
        maxDownloads: maxDownloads ? parseInt(maxDownloads) : undefined,
        password
      }
    );

    // Log share link creation
    systemLogger.logSystem('INFO', `Share link created for file: ${fileName} by user: ${userId}`);

    res.json({
      success: true,
      data: {
        shareToken: shareLink.shareToken,
        shareUrl: shareLink.shareUrl,
        fullUrl: `${req.protocol}://${req.get('host')}${shareLink.shareUrl}`,
        expiresAt: shareLink.expiresAt,
        maxDownloads: shareLink.maxDownloads,
        createdAt: shareLink.createdAt
      }
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Share link creation failed: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/share/:shareToken/download
 * Download file using share token (NO authentication required)
 */
router.get('/share/:shareToken/download', downloadFailLimiter, async (req, res) => {
  try {
    const { shareToken } = req.params;
    const password = req.query.password;

    // Validate share token
    const shareLink = await shareManager.validateShareToken(shareToken, password);

    if (!shareLink) {
      return res.status(404).json({ success: false, message: '分享連結不存在或已失效' });
    }

    // Handle validation errors
    if (shareLink.error) {
      return res.status(shareLink.status).json({ success: false, message: shareLink.error });
    }

    // Security: Prevent path traversal
    const normalizedPath = path.normalize(shareLink.filePath);
    if (normalizedPath.includes('..')) {
      systemLogger.logSystem('WARN', `Path traversal attempt in share link: ${shareToken}`);
      return res.status(400).json({ success: false, message: '無效的文件路徑' });
    }

    // Get storage path from config
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const fullPath = path.join(storagePath, normalizedPath);

    // Check if file exists
    try {
      await fs.access(fullPath);
    } catch (error) {
      systemLogger.logSystem('ERROR', `Shared file not found: ${fullPath}`);
      return res.status(404).json({ success: false, message: '文件不存在' });
    }

    // Increment download counter
    await shareManager.incrementDownloadCount(shareToken);

    // Log download
    systemLogger.logSystem('INFO', `File downloaded via share link: ${shareToken}, file: ${shareLink.fileName}`);

    // Stream file to client
    res.download(fullPath, shareLink.fileName, (err) => {
      if (err) {
        systemLogger.logSystem('ERROR', `File download error: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).json({ success: false, message: '文件下載失敗' });
        }
      }
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Share download failed: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: '下載失敗' });
    }
  }
});

/**
 * GET /api/files/shares
 * List all share links for current user (authenticated)
 */
router.get('/files/shares', authenticate, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.username || 'anonymous';

    const shareLinks = await shareManager.getUserShareLinks(userId);

    res.json({
      success: true,
      data: shareLinks
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to get user share links: ${error.message}`);
    res.status(500).json({ success: false, message: '獲取分享連結列表失敗' });
  }
});

/**
 * DELETE /api/files/share/:shareToken
 * Revoke a share link (authenticated)
 */
router.delete('/files/share/:shareToken', authenticate, async (req, res) => {
  try {
    const { shareToken } = req.params;
    const userId = req.user?.id || req.user?.username || 'anonymous';

    const success = await shareManager.revokeShareLink(shareToken, userId);

    if (!success) {
      return res.status(404).json({ success: false, message: '分享連結不存在或無權限撤銷' });
    }

    systemLogger.logSystem('INFO', `Share link revoked: ${shareToken} by user: ${userId}`);

    res.json({ success: true, message: '分享連結已撤銷' });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to revoke share link: ${error.message}`);
    res.status(500).json({ success: false, message: '撤銷分享連結失敗' });
  }
});

/**
 * GET /api/files/share/:shareToken/info
 * Get share link information (authenticated)
 */
router.get('/files/share/:shareToken/info', authenticate, async (req, res) => {
  try {
    const { shareToken } = req.params;

    const shareLink = await shareManager.getShareLinkInfo(shareToken);

    if (!shareLink) {
      return res.status(404).json({ success: false, message: '分享連結不存在' });
    }

    res.json({
      success: true,
      data: shareLink
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to get share link info: ${error.message}`);
    res.status(500).json({ success: false, message: '獲取分享連結信息失敗' });
  }
});

module.exports = router;
