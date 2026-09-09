/**
 * Share Link API Endpoints
 * Handles file sharing via secure, time-limited download links
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const rateLimit = require('express-rate-limit');

function createShareRouter(dependencies = {}) {
const router = express.Router();
const shareManager = dependencies.shareManager || require('../auth/share-manager');
const configManager = dependencies.configManager || require('../config/index');
const systemLogger = dependencies.logger || require('../utils/logger').systemLogger;
const { authenticate, requireAdmin } = dependencies.auth || require('../middleware/auth');
const userManager = dependencies.userManager || require('../auth/user-manager');
const LocationManager = dependencies.LocationManager || require('../location').LocationManager;
let locationPermissionManager = dependencies.locationPermissionManager || null;

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  if (Object.keys(req.query).some(key => /password/i.test(key))) {
    return res.status(400).json({ success: false, message: 'Use POST body credentials; query passwords are not accepted' });
  }
  next();
});

const setLocationPermissionManager = (manager) => {
  locationPermissionManager = manager;
};

const getLocationContext = (locationId) => {
  const manager = new LocationManager(configManager.getConfig());
  const selectedId = locationId || (manager.getLocation('default') ? 'default' : null);
  if (!selectedId) throw new Error('locationId is required');
  const location = manager.getLocation(selectedId);
  if (!location || !location.enabled) throw new Error('Location is unavailable');
  return { manager, locationId: selectedId, location };
};

const assertSharePermission = async (user, locationId, manager = locationPermissionManager) => {
  if (!manager) {
    throw Object.assign(new Error('Location permission service is not ready'), { statusCode: 503 });
  }
  await manager.assertCurrent(user, locationId, 'share');
};

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
    const { filePath, locationId, expiresIn, maxDownloads, password } = req.body;

    // Get user from JWT (set by auth middleware)
    const userId = req.user?.id || req.user?.username || 'anonymous';

    if (typeof filePath !== 'string' || !filePath) {
      return res.status(400).json({ success: false, message: '文件路徑不能為空' });
    }

    // Security: Prevent path traversal
    const normalizedPath = path.normalize(filePath);
    if (normalizedPath.includes('..')) {
      systemLogger.logSystem('WARN', 'Invalid share creation path');
      return res.status(400).json({ success: false, message: '無效的文件路徑' });
    }

    const context = getLocationContext(locationId);
    context.revision = context.manager.getRevision(context.locationId);
    context.permissionManager = locationPermissionManager;
    context.permissionLocationManager = context.permissionManager?.locationManager;
    const requestedRevision = req.get('X-Location-Revision');
    const assertLocationCurrent = () => {
      const currentManager = new LocationManager(configManager.getConfig());
      if ((requestedRevision !== undefined && requestedRevision !== context.revision) ||
          !currentManager.getLocation(context.locationId) ||
          currentManager.getRevision(context.locationId) !== context.revision ||
          context.permissionManager !== locationPermissionManager ||
          context.permissionLocationManager !== context.permissionManager?.locationManager ||
          (context.permissionManager && (!context.permissionLocationManager?.getLocation(context.locationId) ||
            context.permissionLocationManager.getRevision(context.locationId) !== context.revision))) {
        throw Object.assign(new Error('Location changed; refresh the file selection'), { statusCode: 409 });
      }
    };
    assertLocationCurrent();
    await assertSharePermission(req.user, context.locationId, context.permissionManager);
    assertLocationCurrent();
    const fullPath = await context.manager.resolveCheckedPath(context.locationId, normalizedPath, { allowMissing: false });

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
    assertLocationCurrent();
    const shareLink = await shareManager.createShareLink(
      userId,
      normalizedPath,
      fileName,
      {
        locationId: context.locationId,
        expiresIn: expiresIn == null ? undefined : Number(expiresIn),
        maxDownloads: maxDownloads == null ? undefined : Number(maxDownloads),
        password,
        assertLocationCurrent
      }
    );

    // Log share link creation
    systemLogger.logSystem('INFO', 'Share link creation completed');

    res.json({
      success: true,
      data: {
        shareToken: shareLink.shareToken,
        shareUrl: shareLink.shareUrl,
        fullUrl: `${req.protocol}://${req.get('host')}${shareLink.shareUrl}`,
        directDownloadUrl: shareLink.directDownloadUrl,
        directDownloadFullUrl: `${req.protocol}://${req.get('host')}${shareLink.directDownloadUrl}`,
        hasPassword: shareLink.hasPassword,
        directDownloadMethod: shareLink.directDownloadMethod,
        supportsDirectDownload: shareLink.supportsDirectDownload,
        expiresAt: shareLink.expiresAt,
        maxDownloads: shareLink.maxDownloads,
        locationId: context.locationId,
        createdAt: shareLink.createdAt
      }
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', 'Share link creation failed');
    res.status(error.statusCode || 500).json({ success: false, message: error.statusCode === 409
      ? 'Location changed; refresh the file selection' : 'Unable to create share link' });
  }
});

/**
 * GET /api/share/:shareToken/download
 * Download file using share token (NO authentication required)
 */
const download = async (req, res) => {
  try {
    const { shareToken } = req.params;
    const password = req.method === 'POST' ? req.body?.password : undefined;
    if (password != null && typeof password !== 'string') {
      return res.status(400).json({ success: false, message: 'Invalid password format' });
    }

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
      systemLogger.logSystem('WARN', 'Invalid stored share path');
      return res.status(400).json({ success: false, message: '無效的文件路徑' });
    }

    const context = getLocationContext(shareLink.locationId);
    const fullPath = await context.manager.resolveCheckedPath(context.locationId, normalizedPath, { allowMissing: false });

    // Check the file before admission. Failed transfers after admission still count.
    let stats;
    try {
      await fs.access(fullPath);
      stats = await fs.stat(fullPath);
      if (!stats.isFile()) return res.status(404).json({ success: false, message: 'File not found' });
    } catch (error) {
      systemLogger.logSystem('WARN', 'Shared file unavailable');
      return res.status(404).json({ success: false, message: '文件不存在' });
    }

    // HEAD consumes no admission. Every admitted GET/POST, including Range,
    // consumes one count, even if the client disconnects or streaming fails.
    if (req.method !== 'HEAD' && !(await shareManager.admitDownload(shareToken))) {
      return res.status(410).json({ success: false, message: 'Share link expired, revoked, or exhausted' });
    }

    // Keep the public endpoint useful to appliance clients (BMC/iLO) that
    // consume the response as a raw file rather than as a browser download.
    res.setHeader('Accept-Ranges', 'bytes');
    res.type(path.extname(shareLink.fileName) || 'application/octet-stream');

    // Stream file to client
    res.download(fullPath, shareLink.fileName, { cacheControl: false, lastModified: false }, (err) => {
      if (err) {
        systemLogger.logDownload(shareLink.fileName, 'share-link', false, req, {
          error: 'File transfer failed'
        });
        if (!res.headersSent) {
          res.removeHeader('Content-Length');
          res.removeHeader('Content-Disposition');
          res.status(500).json({ success: false, message: '文件下載失敗' });
        } else if (!res.writableEnded) {
          res.destroy();
        }
      } else if (req.method !== 'HEAD') {
        systemLogger.logDownload(shareLink.fileName, 'share-link', true, req, { size: stats.size });
      }
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', 'Share download failed');
    if (!res.headersSent) {
      res.status(error.code === 'ENOENT' ? 404 : error.statusCode || 500).json({ success: false, message: '下載失敗' });
    }
  }
};
router.get('/share/:shareToken/download', downloadFailLimiter, download);
router.post('/share/:shareToken/download', downloadFailLimiter, express.json({ limit: '16kb' }), download);

/**
 * GET /api/files/shares
 * List all share links for current user (authenticated)
 */
router.get('/files/shares', authenticate, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.username || 'anonymous';

    const shareLinks = await shareManager.getUserShareLinks(userId);
    const permittedLinks = [];
    for (const shareLink of shareLinks) {
      try {
        await assertSharePermission(req.user, shareLink.locationId || 'default');
        permittedLinks.push(shareLink);
      } catch (error) {
        if (error.statusCode !== 403) throw error;
      }
    }

    res.json({
      success: true,
      data: permittedLinks
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', 'Failed to get user share links');
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

    const shareLink = await shareManager.getShareLinkInfo(shareToken);
    if (!shareLink) {
      return res.status(404).json({ success: false, message: '分享連結不存在或無權限撤銷' });
    }
    await assertSharePermission(req.user, shareLink.locationId || 'default');

    const success = await shareManager.revokeShareLink(shareToken, userId);

    if (!success) {
      return res.status(404).json({ success: false, message: '分享連結不存在或無權限撤銷' });
    }

    systemLogger.logSystem('INFO', 'Share link revoked by owner');

    res.json({ success: true, message: '分享連結已撤銷' });
  } catch (error) {
    systemLogger.logSystem('ERROR', 'Failed to revoke share link');
    res.status(error.statusCode || 500).json({ success: false, message: '撤銷分享連結失敗' });
  }
});

/**
 * GET /api/admin/share-links
 * List every user's share links for administrators.
 */
router.get('/admin/share-links', requireAdmin, async (req, res) => {
  try {
    const [shareLinks, users] = await Promise.all([
      shareManager.getAllShareLinks(),
      userManager.getAllUsers()
    ]);
    const usernamesById = new Map(users.map(user => [String(user.id), user.username]));

    res.json({
      success: true,
      data: shareLinks.map(link => ({
        ...link,
        creatorUsername: usernamesById.get(String(link.userId)) || String(link.userId)
      }))
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', 'Failed to get all share links');
    res.status(500).json({ success: false, message: '獲取全部分享連結列表失敗' });
  }
});

router.delete('/admin/share-links/:shareToken', requireAdmin, async (req, res) => {
  const success = await shareManager.revokeShareLinkAsAdmin(req.params.shareToken);
  if (!success) return res.status(404).json({ success: false, message: '分享連結不存在' });
  res.json({ success: true, message: '分享連結已撤銷' });
});

router.delete('/admin/share-links/:shareToken/history', requireAdmin, async (req, res) => {
  const success = await shareManager.deleteExpiredShareLinkAsAdmin(req.params.shareToken);
  if (!success) return res.status(404).json({ success: false, message: '過期分享連結不存在或尚未過期' });
  res.json({ success: true, message: '過期分享連結已移除' });
});

router.delete('/admin/share-links/:shareToken/history/revoked', requireAdmin, async (req, res) => {
  const success = await shareManager.deleteRevokedShareLinkAsAdmin(req.params.shareToken);
  if (!success) return res.status(404).json({ success: false, message: '已撤銷分享連結不存在或仍在啟用中' });
  res.json({ success: true, message: '已撤銷分享連結已移除' });
});

/**
 * DELETE /api/files/share/:shareToken/history
 * Permanently remove an expired share link from the current user's history.
 */
router.delete('/files/share/:shareToken/history', authenticate, async (req, res) => {
  try {
    const { shareToken } = req.params;
    const userId = req.user?.id || req.user?.username || 'anonymous';

    const shareLink = await shareManager.getShareLinkInfo(shareToken);
    if (!shareLink) {
      return res.status(404).json({ success: false, message: '過期分享連結不存在或尚未過期' });
    }
    await assertSharePermission(req.user, shareLink.locationId || 'default');
    const success = await shareManager.deleteExpiredShareLink(shareToken, userId);

    if (!success) {
      return res.status(404).json({ success: false, message: '過期分享連結不存在或尚未過期' });
    }

    res.json({ success: true, message: '過期分享連結已從歷史記錄移除' });
  } catch (error) {
    systemLogger.logSystem('ERROR', 'Failed to delete expired share link');
    res.status(error.statusCode || 500).json({ success: false, message: '移除過期分享連結失敗' });
  }
});

/**
 * DELETE /api/files/share/:shareToken/history/revoked
 * Permanently remove a revoked share link from the current user's history.
 */
router.delete('/files/share/:shareToken/history/revoked', authenticate, async (req, res) => {
  try {
    const { shareToken } = req.params;
    const userId = req.user?.id || req.user?.username || 'anonymous';

    const shareLink = await shareManager.getShareLinkInfo(shareToken);
    if (!shareLink) {
      return res.status(404).json({ success: false, message: '已撤銷分享連結不存在或仍在啟用中' });
    }
    await assertSharePermission(req.user, shareLink.locationId || 'default');
    const success = await shareManager.deleteRevokedShareLink(shareToken, userId);

    if (!success) {
      return res.status(404).json({ success: false, message: '已撤銷分享連結不存在或仍在啟用中' });
    }

    res.json({ success: true, message: '已撤銷分享連結已從歷史記錄移除' });
  } catch (error) {
    systemLogger.logSystem('ERROR', 'Failed to delete revoked share link');
    res.status(error.statusCode || 500).json({ success: false, message: '移除已撤銷分享連結失敗' });
  }
});

/**
 * GET /api/share/:shareToken/info
 * Get basic share link information (NO authentication required)
 * This is for public users to check if password is required before downloading
 */
router.get('/share/:shareToken/info', async (req, res) => {
  try {
    const { shareToken } = req.params;

    const shareLink = await shareManager.getShareLinkInfo(shareToken);

    if (!shareLink) {
      return res.status(404).json({ success: false, message: '分享連結不存在' });
    }

    // Only return safe information for public access
    res.json({
      success: true,
      data: {
        fileName: shareLink.fileName,
        hasPassword: shareLink.hasPassword,
        directDownloadMethod: shareLink.directDownloadMethod,
        supportsDirectDownload: shareLink.supportsDirectDownload,
        expiresAt: shareLink.expiresAt,
        maxDownloads: shareLink.maxDownloads,
        isActive: shareLink.isActive,
        isExpired: shareLink.isExpired,
        isExhausted: shareLink.isExhausted
      }
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', 'Failed to get public share link info');
    res.status(500).json({ success: false, message: '獲取分享連結信息失敗' });
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

    await assertSharePermission(req.user, shareLink.locationId || 'default');

    res.json({
      success: true,
      data: shareLink
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', 'Failed to get share link info');
    res.status(error.statusCode || 500).json({ success: false, message: '獲取分享連結信息失敗' });
  }
});

router.setLocationPermissionManager = setLocationPermissionManager;
return router;
}

module.exports = createShareRouter();
module.exports.createShareRouter = createShareRouter;
