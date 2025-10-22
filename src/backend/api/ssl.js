const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const certificateManager = require('../ssl/certificate-manager');
const sanManager = require('../ssl/san-manager');
const { systemLogger } = require('../utils/logger');
const rateLimit = require('express-rate-limit');

// Rate limiter for certificate operations (5 requests per 15 minutes)
const certLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { error: '證書操作過於頻繁，請稍後再試' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * GET /api/admin/ssl/status
 * Get SSL certificate status and information
 */
router.get('/admin/ssl/status', requireAdmin, async (req, res) => {
  try {
    const certStatus = await certificateManager.certificatesExist();
    const response = {
      certificatesExist: certStatus.ca && certStatus.server,
      ca: {
        exists: certStatus.ca
      },
      server: {
        exists: certStatus.server
      },
      sans: []
    };

    // Get expiration dates if certificates exist
    if (certStatus.ca) {
      const caExpiration = await certificateManager.getCertificateExpiration(certificateManager.caCertPath);
      if (caExpiration) {
        response.ca.expirationDate = caExpiration.toISOString();
        response.ca.expirationDateLocal = caExpiration.toLocaleString();
        response.ca.daysUntilExpiry = Math.floor((caExpiration - new Date()) / (1000 * 60 * 60 * 24));
        response.ca.isExpired = certificateManager.isExpired(caExpiration);
        response.ca.isExpiringSoon = certificateManager.isExpiringSoon(caExpiration, 90);
      }
    }

    if (certStatus.server) {
      const serverExpiration = await certificateManager.getCertificateExpiration(certificateManager.serverCertPath);
      if (serverExpiration) {
        response.server.expirationDate = serverExpiration.toISOString();
        response.server.expirationDateLocal = serverExpiration.toLocaleString();
        response.server.daysUntilExpiry = Math.floor((serverExpiration - new Date()) / (1000 * 60 * 60 * 24));
        response.server.isExpired = certificateManager.isExpired(serverExpiration);
        response.server.isExpiringSoon = certificateManager.isExpiringSoon(serverExpiration, 90);
      }

      // Extract SANs from server certificate
      const sans = await certificateManager.extractSANs(certificateManager.serverCertPath);
      response.sans = sans;
    }

    // Get SAN configuration
    const sanConfig = await sanManager.getSANs();
    response.sanConfig = {
      ips: sanConfig.ips,
      hostnames: sanConfig.hostnames,
      autoDetected: sanConfig.autoDetected
    };

    res.json(response);
  } catch (error) {
    systemLogger.logError(`SSL status fetch error: ${error.message}`, req);
    res.status(500).json({ error: 'Failed to fetch SSL status' });
  }
});

/**
 * POST /api/admin/ssl/generate
 * Generate initial CA and server certificates
 */
router.post('/admin/ssl/generate', requireAdmin, certLimiter, async (req, res) => {
  try {
    // Check if certificates already exist
    const certStatus = await certificateManager.certificatesExist();
    if (certStatus.ca && certStatus.server) {
      return res.status(400).json({ error: '證書已存在，請使用更新功能' });
    }

    // Get SANs list
    const sans = await sanManager.getSANList();

    systemLogger.log('INFO', `Generating SSL certificates with SANs: ${sans.join(', ')}`, req);

    // Generate certificates
    const result = await certificateManager.generateFullCertificateSet(sans, req);

    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        expirationDates: {
          ca: result.expirationDates.ca.toISOString(),
          server: result.expirationDates.server.toISOString()
        },
        needsRestart: true
      });
    } else {
      res.status(500).json({ error: result.message });
    }
  } catch (error) {
    systemLogger.logError(`SSL generation error: ${error.message}`, req);
    res.status(500).json({ error: `證書生成失敗: ${error.message}` });
  }
});

/**
 * POST /api/admin/ssl/renew
 * Renew server certificate (keep existing CA)
 */
router.post('/admin/ssl/renew', requireAdmin, certLimiter, async (req, res) => {
  try {
    // Check if CA exists
    const certStatus = await certificateManager.certificatesExist();
    if (!certStatus.ca) {
      return res.status(400).json({ error: 'CA證書不存在，請先生成證書' });
    }

    // Get SANs list (use current or provided)
    let sans;
    if (req.body.sans && Array.isArray(req.body.sans)) {
      sans = req.body.sans;
    } else {
      sans = await sanManager.getSANList();
    }

    systemLogger.log('INFO', `Renewing SSL certificate with SANs: ${sans.join(', ')}`, req);

    // Renew certificate
    const result = await certificateManager.renewServerCertificate(sans, req);

    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        expirationDate: result.expirationDate.toISOString(),
        needsRestart: true
      });
    } else {
      res.status(500).json({ error: result.message });
    }
  } catch (error) {
    systemLogger.logError(`SSL renewal error: ${error.message}`, req);
    res.status(500).json({ error: `證書更新失敗: ${error.message}` });
  }
});

/**
 * GET /api/admin/ssl/sans
 * Get current SAN configuration
 */
router.get('/admin/ssl/sans', requireAdmin, async (req, res) => {
  try {
    const sans = await sanManager.getSANs();
    const config = await sanManager.loadConfig();

    res.json({
      ips: sans.ips,
      hostnames: sans.hostnames,
      autoDetected: sans.autoDetected,
      autoDetectIPs: config.autoDetectIPs
    });
  } catch (error) {
    systemLogger.logError(`SAN fetch error: ${error.message}`, req);
    res.status(500).json({ error: 'Failed to fetch SAN configuration' });
  }
});

/**
 * PUT /api/admin/ssl/sans
 * Update SAN configuration and regenerate certificate
 */
router.put('/admin/ssl/sans', requireAdmin, certLimiter, async (req, res) => {
  try {
    const { ips, hostnames, autoDetectIPs } = req.body;

    // Update SAN configuration
    const updateResult = await sanManager.updateSANs({
      ips: ips || [],
      hostnames: hostnames || [],
      autoDetectIPs: autoDetectIPs !== undefined ? autoDetectIPs : true
    }, req);

    if (!updateResult.success) {
      return res.status(400).json({ error: updateResult.message });
    }

    // Check if certificates exist
    const certStatus = await certificateManager.certificatesExist();
    if (!certStatus.ca || !certStatus.server) {
      // Configuration updated but no certificates to regenerate
      return res.json({
        success: true,
        message: 'SAN配置已更新。請生成證書以應用更改。',
        needsRestart: false
      });
    }

    // Regenerate server certificate with new SANs
    const sans = await sanManager.getSANList();
    const renewResult = await certificateManager.renewServerCertificate(sans, req);

    if (renewResult.success) {
      res.json({
        success: true,
        message: 'SAN配置已更新且證書已重新生成。請重啟服務。',
        expirationDate: renewResult.expirationDate.toISOString(),
        needsRestart: true
      });
    } else {
      res.status(500).json({ error: renewResult.message });
    }
  } catch (error) {
    systemLogger.logError(`SAN update error: ${error.message}`, req);
    res.status(500).json({ error: `SAN配置更新失敗: ${error.message}` });
  }
});

/**
 * POST /api/admin/ssl/sans/add
 * Add a new SAN entry
 */
router.post('/admin/ssl/sans/add', requireAdmin, async (req, res) => {
  try {
    const { san } = req.body;

    if (!san) {
      return res.status(400).json({ error: 'SAN不能為空' });
    }

    const result = await sanManager.addSAN(san, req);

    if (result.success) {
      res.json({
        success: true,
        message: result.message
      });
    } else {
      res.status(400).json({ error: result.message });
    }
  } catch (error) {
    systemLogger.logError(`SAN add error: ${error.message}`, req);
    res.status(500).json({ error: '添加SAN失敗' });
  }
});

/**
 * DELETE /api/admin/ssl/sans/:san
 * Remove a SAN entry
 */
router.delete('/admin/ssl/sans/:san', requireAdmin, async (req, res) => {
  try {
    const { san } = req.params;

    const result = await sanManager.removeSAN(decodeURIComponent(san), req);

    if (result.success) {
      res.json({
        success: true,
        message: result.message
      });
    } else {
      res.status(400).json({ error: result.message });
    }
  } catch (error) {
    systemLogger.logError(`SAN remove error: ${error.message}`, req);
    res.status(500).json({ error: '移除SAN失敗' });
  }
});

/**
 * GET /api/admin/ssl/download/ca
 * Download CA certificate for client trust installation
 */
router.get('/admin/ssl/download/ca', requireAdmin, async (req, res) => {
  try {
    const certStatus = await certificateManager.certificatesExist();
    if (!certStatus.ca) {
      return res.status(404).json({ error: 'CA證書不存在' });
    }

    const fs = require('fs');
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="filetransfer-ca.crt"');
    res.sendFile(certificateManager.caCertPath);

    systemLogger.log('INFO', 'CA certificate downloaded', req);
  } catch (error) {
    systemLogger.logError(`CA download error: ${error.message}`, req);
    res.status(500).json({ error: '下載CA證書失敗' });
  }
});

module.exports = router;
