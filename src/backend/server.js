// Main server file for file transfer application
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcrypt');
const fs = require('fs').promises;
const os = require('os');
const archiver = require('archiver');
const configManager = require('./config');
const { EnhancedMemoryFileSystem } = require('./file-system');
const AuthManager = require('./auth');
const UserManager = require('./auth/user-manager');
const UploadAPI = require('./api/upload.js');
const { transferManager } = require('./transfer');
const { authenticate, setJwtSecret, requireAdmin } = require('./middleware/auth');
const { initializeSecurity } = require('./middleware/security');
const { createLogger, systemLogger } = require('./utils/logger');



// Initialize user manager
const userManager = new UserManager();

// Initialize app
const app = express();

// These will be initialized after config is loaded
let authManager;
let fileSystem;
let securityMiddleware;
let isCacheReady = false;
const userActiveDirectories = new Map(); // Track active directory per user

// Security checks and recommendations on startup
async function performSecurityChecks(config) {
  console.log('\n🔒 SECURITY CONFIGURATION');
  console.log('='.repeat(50));

  // Always enabled security features
  console.log('🛡️  ALWAYS ENABLED (Core Security):');
  console.log('   ✅ JWT token authentication');
  console.log('   ✅ Password hashing with bcrypt');
  console.log('   ✅ HTTPS data transmission (when configured)');

  // Configurable security features
  console.log('\n⚙️  CONFIGURABLE SECURITY FEATURES:');
  const features = [
    { key: 'enableRateLimit', name: 'Rate limiting (auth: 5/15min, files: 50/min)' },
    { key: 'enableSecurityHeaders', name: 'Security headers (HSTS, CSP, etc.)' },
    { key: 'enableInputValidation', name: 'Input validation and sanitization' },
    { key: 'enableFileUploadSecurity', name: 'File upload security checks' },
    { key: 'enableRequestLogging', name: 'Request logging and monitoring' },
    { key: 'enableCSP', name: 'Content Security Policy' }
  ];

  features.forEach(feature => {
    const enabled = config.get(`security.${feature.key}`) === true;
    const status = enabled ? '✅' : '❌';
    console.log(`   ${status} ${feature.name}`);
  });

  // Check config file permissions
  const configPath = './src/config.ini';
  const { securityManager } = require('./middleware/security');
  const isSecure = await securityManager.validateConfigSecurity(configPath);

  console.log('\n📁 CONFIG FILE SECURITY:');
  if (!isSecure) {
    console.log('   ⚠️  Config file has permissive permissions');
    console.log('   💡 Consider running: chmod 600 ./src/config.ini');
  } else {
    console.log('   ✅ Config file permissions are secure');
  }

  console.log('\n💡 SECURITY NOTE:');
  console.log('   Most security features are disabled by default for ease of use.');
  console.log('   Enable them in config.ini for production environments.');
  console.log('   Authentication and data transmission security are always enabled.');

  console.log('='.repeat(50));
}

// Get all available IP addresses
function getNetworkInterfaces() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({
          name: name,
          address: iface.address,
          netmask: iface.netmask
        });
      }
    }
  }

  return addresses;
}

// Security middleware will be initialized after config is loaded

// Basic middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend/public')));

// Use the UploadAPI router for all upload endpoints
const uploadApi = new UploadAPI();
app.use('/api', uploadApi.getRouter());

// Routes
app.get('/admin', authenticate, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/admin.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// Server log endpoint (for admin panel)
app.get('/server.log', requireAdmin, async (req, res) => {
  try {
    const logPath = path.join(__dirname, '../../server.log');
    const logExists = await fs.access(logPath).then(() => true).catch(() => false);

    if (!logExists) {
      return res.status(404).send('Log file not found');
    }

    res.setHeader('Content-Type', 'text/plain');
    res.sendFile(logPath);
  } catch (error) {
    systemLogger.logSystem('ERROR', `Error serving log file: ${error.message}`);
    res.status(500).send('Error reading log file');
  }
});

// Authentication routes
app.post('/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await authManager.register(username, password);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/auth/login', (req, res, next) => {
  // Apply auth limiter if security middleware is initialized
  if (securityMiddleware && securityMiddleware.authLimiter) {
    securityMiddleware.authLimiter(req, res, next);
  } else {
    next();
  }
}, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Authenticate user with UserManager
    const user = await userManager.authenticateUser(username, password);

    if (user) {
      // Log successful authentication
      systemLogger.logAuth('login', username, true, { role: user.role }, req);
      systemLogger.logSessionStart(username, req);

      // Generate JWT token
      const jwt = require('jsonwebtoken');
      const token = jwt.sign(
        {
          id: user.id,
          username: user.username,
          role: user.role
        },
        configManager.get('security.jwtSecret') || 'file-transfer-secret-key',
        { expiresIn: '24h' }
      );

      res.json({
        success: true,
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          email: user.email,
          permissions: user.permissions,
          lastLogin: user.lastLogin
        }
      });
    } else {
      // Log failed authentication
      systemLogger.logAuth('login', username, false, null, req);
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    systemLogger.logSystem('ERROR', `Login error: ${error.message}`);
    res.status(401).json({ error: 'Authentication failed' });
  }
});

// Change password endpoint
app.post('/auth/change-password', (req, res, next) => {
  // Apply auth limiter if security middleware is initialized
  if (securityMiddleware && securityMiddleware.authLimiter) {
    securityMiddleware.authLimiter(req, res, next);
  } else {
    next();
  }
}, authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    // Get current credentials from config
    const configUsername = configManager.get('auth.username');
    const configPassword = configManager.get('auth.password');

    // Verify current password
    if (currentPassword !== configPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash the new password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Update config file
    const configPath = './src/config.ini';
    let configContent = await fs.readFile(configPath, 'utf8');

    // Replace password line
    configContent = configContent.replace(
      /^password=.*$/m,
      `password=${hashedPassword}`
    );

    // Add hash indicator if not present
    if (!configContent.includes('passwordHashed=true')) {
      configContent += '\npasswordHashed=true';
    } else {
      configContent = configContent.replace(
        /^passwordHashed=.*$/m,
        'passwordHashed=true'
      );
    }

    await fs.writeFile(configPath, configContent);

    // Reload configuration
    await configManager.load();

    systemLogger.logSystem('INFO', `Password changed successfully for user: ${req.user.username}`);

    res.json({
      success: true,
      message: 'Password changed successfully. Please login again with your new password.'
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Password change error: ${error.message}`);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Forgot password endpoint (generates temporary reset token)
app.post('/auth/forgot-password', (req, res, next) => {
  // Apply auth limiter if security middleware is initialized
  if (securityMiddleware && securityMiddleware.authLimiter) {
    securityMiddleware.authLimiter(req, res, next);
  } else {
    next();
  }
}, async (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const configUsername = configManager.get('auth.username');

    if (username !== configUsername) {
      // Don't reveal if username exists or not
      return res.json({
        success: true,
        message: 'If the username exists, a reset token has been generated. Check the server console.'
      });
    }

    // Use Redis to store the reset token
    const redisClient = fileSystem.cache.redisClient;
    if (!redisClient) {
      return res.status(500).json({ error: 'Redis client not available' });
    }

    const resetToken = require('crypto').randomBytes(32).toString('hex');
    const redisKey = `reset-token:${username}`;
    const expirySeconds = 15 * 60; // 15 minutes

    await redisClient.set(redisKey, resetToken, { EX: expirySeconds });

    // Log to server.log
    systemLogger.logSystem('INFO', `Password reset request for user: ${username}, Token: ${resetToken}, Valid for: 15 minutes`);

    // Also display in console for immediate visibility
    console.log('='.repeat(60));
    console.log('🔐 PASSWORD RESET REQUEST');
    console.log('='.repeat(60));
    console.log(`Username: ${username}`);
    console.log(`Reset Token: ${resetToken}`);
    console.log(`Valid for: 15 minutes`);
    console.log('Use this token to reset your password within 15 minutes.');
    console.log('='.repeat(60));

    res.json({
      success: true,
      message: 'Reset token generated. Check the server console for the token.'
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Forgot password error: ${error.message}`);
    res.status(500).json({ error: 'Failed to process forgot password request' });
  }
});

// Reset password with token
app.post('/auth/reset-password', (req, res, next) => {
  // Apply auth limiter if security middleware is initialized
  if (securityMiddleware && securityMiddleware.authLimiter) {
    securityMiddleware.authLimiter(req, res, next);
  } else {
    next();
  }
}, async (req, res) => {
  try {
    const { username, resetToken, newPassword } = req.body;

    if (!username || !resetToken || !newPassword) {
      return res.status(400).json({ error: 'Username, reset token, and new password are required' });
    }

    // Check if reset token exists and is valid in Redis
    const redisClient = fileSystem.cache.redisClient;
    if (!redisClient) {
      return res.status(500).json({ error: 'Redis client not available' });
    }

    const redisKey = `reset-token:${username}`;
    const storedToken = await redisClient.get(redisKey);

    if (storedToken !== resetToken) {
      return res.status(401).json({ error: 'Invalid or expired reset token' });
    }

    // Hash the new password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Update config file
    const configPath = './src/config.ini';
    let configContent = await fs.readFile(configPath, 'utf8');

    // Replace password line
    configContent = configContent.replace(
      /^password=.*$/m,
      `password=${hashedPassword}`
    );

    // Add hash indicator
    if (!configContent.includes('passwordHashed=true')) {
      configContent += '\npasswordHashed=true';
    } else {
      configContent = configContent.replace(
        /^passwordHashed=.*$/m,
        'passwordHashed=true'
      );
    }

    await fs.writeFile(configPath, configContent);

    // Clear the used reset token from Redis
    await redisClient.del(redisKey);

    // Reload configuration
    await configManager.load();

    systemLogger.logSystem('INFO', `Password reset successfully for user: ${username}`);

    res.json({
      success: true,
      message: 'Password reset successfully. Please login with your new password.'
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Password reset error: ${error.message}`);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Search files using cache (must be before wildcard route)
// POST endpoint for JSON request body
app.post('/api/files/search', authenticate, async (req, res) => {
  if (!isCacheReady) {
    return res.status(503).json({ error: 'Cache is warming up. Please try again in a few moments.' });
  }
  try {
    // Check both body and query for compatibility
    const query = req.body.query || req.query.query;

    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    // Add timeout for search operations
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Search timeout')), 15000);
    });

    const searchResults = await Promise.race([
      fileSystem.searchFiles(query),
      timeoutPromise
    ]);

    systemLogger.logAPI('search', query, true, req, { resultCount: searchResults.length });
    res.json(searchResults);
  } catch (error) {
    if (error.message === 'Search timeout') {
      systemLogger.logAPI('search', req.body.query || req.query.query, false, req, { error: 'Search timeout' });
      res.status(408).json({ error: 'Search timeout - try a more specific query' });
    } else {
      systemLogger.logAPI('search', req.body.query || req.query.query, false, req, { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
});

// GET endpoint for query parameters (legacy frontend support)
app.get('/api/files/search', authenticate, async (req, res) => {
  if (!isCacheReady) {
    return res.status(503).json({ error: 'Cache is warming up. Please try again in a few moments.' });
  }
  try {
    const { query } = req.query;

    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    // Add timeout for search operations
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Search timeout')), 15000);
    });

    const searchResults = await Promise.race([
      fileSystem.searchFiles(query),
      timeoutPromise
    ]);

    systemLogger.logAPI('search', query, true, req, { resultCount: searchResults.length });
    res.json(searchResults);
  } catch (error) {
    if (error.message === 'Search timeout') {
      systemLogger.logAPI('search', req.query.query, false, req, { error: 'Search timeout' });
      res.status(408).json({ error: 'Search timeout - try a more specific query' });
    } else {
      systemLogger.logAPI('search', req.query.query, false, req, { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
});

// IMPORTANT: Specific routes must come before the general '/api/files/*' wildcard route.

// Cache statistics endpoint
app.get('/api/files/cache-stats', authenticate, async (req, res) => {
  try {
    const stats = await fileSystem.getCacheInfo ? await fileSystem.getCacheInfo() : { message: 'Cache stats not available' };
    res.json(stats);
  } catch (error) {
    systemLogger.logSystem('ERROR', `Cache stats error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Cache refresh endpoint (for manual cache updates)
app.post('/api/files/refresh-cache', authenticate, async (req, res) => {
  try {
    const { directoryPath } = req.body; // Allow partial refresh

    if (directoryPath) {
      const storagePath = configManager.get('fileSystem.storagePath') || './storage';
      const fullPath = path.join(path.resolve(storagePath), directoryPath);
      systemLogger.logCacheOperation('refresh_directory', { path: fullPath }, req);
      // This will re-scan and overwrite the specific directory hash in Redis.
      // Note: This won't detect deletions within the directory, a full refresh is needed for that.
      if (fileSystem.cache && fileSystem.cache.scanDirectory) {
        await fileSystem.cache.scanDirectory(fullPath);
      }
      res.json({ success: true, message: `Cache for ${directoryPath} refreshed.` });
    } else {
      systemLogger.logCacheOperation('refresh_full', {}, req);
      if (fileSystem.cache && fileSystem.cache.refreshCache) {
        await fileSystem.cache.refreshCache();
      }
      res.json({ success: true, message: 'Entire cache refreshed successfully' });
    }
  } catch (error) {
    systemLogger.logSystem('ERROR', `Cache refresh error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get file content
app.get('/api/files/content/*', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const requestPath = req.params[0] || '';

    const storageRoot = path.resolve(storagePath);
    const fullPath = path.join(storageRoot, requestPath);

    if (!fullPath.startsWith(storageRoot)) {
      return res.status(403).json({ error: 'Forbidden: Access denied.' });
    }

    const content = await fileSystem.read(fullPath);
    res.json({ content: content.toString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Download file endpoint
app.get('/api/files/download/*', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const requestPath = req.params[0] || '';

    const storageRoot = path.resolve(storagePath);
    const fullPath = path.join(storageRoot, requestPath);

    if (!fullPath.startsWith(storageRoot)) {
      systemLogger.logSecurity('path_traversal_attempt', { path: requestPath }, req);
      return res.status(403).json({ error: 'Forbidden: Access denied.' });
    }

    const stats = await fs.stat(fullPath);
    if (stats.isDirectory()) {
      systemLogger.logFileOperation('download', requestPath, false, req, { error: 'Attempted to download directory' });
      return res.status(400).json({ error: 'This endpoint only supports file downloads. For directory downloads, please use the archive functionality.' });
    }

    const fileName = path.basename(fullPath);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const fileStream = require('fs').createReadStream(fullPath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      systemLogger.logFileOperation('download', requestPath, false, req, { error: error.message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download file' });
      }
    });

    fileStream.on('close', () => {
      systemLogger.logFileOperation('download', requestPath, true, req, { size: stats.size });
    });
  } catch (error) {
    // Catch file not found errors from fs.stat
    if (error.code === 'ENOENT') {
      systemLogger.logFileOperation('download', req.params[0], false, req, { error: 'File not found' });
      return res.status(404).json({ error: 'File not found' });
    }
    systemLogger.logFileOperation('download', req.params[0], false, req, { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// List files in a directory (or root)
app.get('/api/files/*', authenticate, async (req, res) => {
  if (!isCacheReady) {
    return res.status(503).json({ error: 'Cache is warming up. Please try again in a few moments.' });
  }
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const requestPath = req.params[0] || '';

    const storageRoot = path.resolve(storagePath);
    const fullPath = path.join(storageRoot, requestPath);

    if (!fullPath.startsWith(storageRoot)) {
      systemLogger.logSecurity('path_traversal_attempt', { path: requestPath }, req);
      return res.status(403).json({ error: 'Forbidden: Access denied.' });
    }

    // --- On-demand watcher integration ---
    const userId = req.user.id;
    const previousPath = userActiveDirectories.get(userId);
    if (previousPath && previousPath !== fullPath) {
      await fileSystem.cache.leaveDirectory(previousPath);
    }
    await fileSystem.cache.enterDirectory(fullPath);
    userActiveDirectories.set(userId, fullPath);
    // ------------------------------------

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), 30000);
    });

    const files = await Promise.race([
      fileSystem.list(fullPath),
      timeoutPromise
    ]);

    systemLogger.logAPI('list', requestPath, true, req, { fileCount: files.length });
    res.json(files);
  } catch (error) {
    if (error.message === 'Request timeout') {
      systemLogger.logAPI('list', req.params[0] || '/', false, req, { error: 'Request timeout' });
      res.status(408).json({ error: 'Request timeout - file system may be busy' });
    } else {
      systemLogger.logAPI('list', req.params[0] || '/', false, req, { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
});

// Handle root files API call
app.get('/api/files', authenticate, async (req, res) => {
  if (!isCacheReady) {
    return res.status(503).json({ error: 'Cache is warming up. Please try again in a few moments.' });
  }
  try {
    const { path: requestPath } = req.query;
    const storagePath = configManager.get('fileSystem.storagePath');
    const storageRoot = path.resolve(storagePath);
    
    // Determine the target path
    let targetPath = storageRoot;
    if (requestPath && requestPath.trim() !== '') {
      targetPath = path.resolve(storageRoot, requestPath);
      // Security check: ensure the path is within storage root
      if (!targetPath.startsWith(storageRoot)) {
        systemLogger.logSecurity('path_traversal_attempt', { path: requestPath }, req);
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // --- On-demand watcher integration ---
    const userId = req.user.id;
    const previousPath = userActiveDirectories.get(userId);
    if (previousPath && previousPath !== targetPath) {
      await fileSystem.cache.leaveDirectory(previousPath);
    }
    await fileSystem.cache.enterDirectory(targetPath);
    userActiveDirectories.set(userId, targetPath);
    // ------------------------------------

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), 30000);
    });

    const rawFiles = await Promise.race([
      fileSystem.list(targetPath),
      timeoutPromise
    ]);

    // Transform the file data to match frontend expectations
    const transformedFiles = rawFiles.map(file => {
      const relativePath = path.relative(storageRoot, file.path);
      return {
        ...file,
        name: path.basename(file.path),
        path: relativePath || file.path,
        isDirectory: file.isDirectory === 'true' || file.isDirectory === true,
        size: parseInt(file.size) || 0,
        modified: parseInt(file.modified) || 0
      };
    });

    // Return in the format expected by FileBrowser
    const currentPath = path.relative(storageRoot, targetPath) || '';

    systemLogger.logAPI('list', requestPath || '/', true, req, { fileCount: transformedFiles.length });

    res.json({
      files: transformedFiles,
      currentPath: currentPath,
      success: true
    });
  } catch (error) {
    if (error.message === 'Request timeout') {
      systemLogger.logAPI('list', req.query.path || '/', false, req, { error: 'Request timeout' });
      res.status(408).json({ error: 'Request timeout - file system may be busy' });
    } else {
      systemLogger.logAPI('list', req.query.path || '/', false, req, { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
});

// Create/write file
app.post('/api/files', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const { path: requestPath, content } = req.body;

    const storageRoot = path.resolve(storagePath);
    const fullPath = path.join(storageRoot, requestPath);
    if (!fullPath.startsWith(storageRoot)) {
      return res.status(403).json({ error: 'Forbidden: Access denied.' });
    }

    await fileSystem.write(fullPath, content);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new folder
app.post('/api/folders', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const { folderName, currentPath } = req.body;

    if (!folderName || !folderName.trim()) {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    const relativePath = currentPath ? path.join(currentPath, folderName.trim()) : folderName.trim();

    const storageRoot = path.resolve(storagePath);
    const fullPath = path.join(storageRoot, relativePath);
    if (!fullPath.startsWith(storageRoot)) {
      systemLogger.logSecurity('path_traversal_attempt', { path: relativePath }, req);
      return res.status(403).json({ error: 'Forbidden: Access denied.' });
    }

    await fileSystem.mkdir(fullPath);

    // Force cache refresh for the parent directory
    if (fileSystem.cache && fileSystem.cache.scanDirectory) {
      try {
        const parentPath = currentPath ? path.join(storageRoot, currentPath) : storageRoot;
        await fileSystem.cache.scanDirectory(parentPath);
        systemLogger.logCacheOperation('refresh_after_mkdir', { path: currentPath || '/' }, req);
      } catch (cacheError) {
        // Non-fatal cache error (not logged)('Cache refresh error (non-fatal):', cacheError.message);
      }
    }

    systemLogger.logFileOperation('mkdir', relativePath, true, req, { folderName });
    res.json({ success: true, message: 'Folder created successfully' });
  } catch (error) {
    systemLogger.logFileOperation('mkdir', req.body.currentPath || '/', false, req, { error: error.message, folderName: req.body.folderName });
    res.status(500).json({ error: error.message });
  }
});

// Legacy endpoint for backward compatibility
app.post('/api/files/directory', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const { path: requestPath } = req.body;

    const storageRoot = path.resolve(storagePath);
    const fullPath = path.join(storageRoot, requestPath);
    if (!fullPath.startsWith(storageRoot)) {
      return res.status(403).json({ error: 'Forbidden: Access denied.' });
    }

    await fileSystem.mkdir(fullPath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete file or folder
app.delete('/api/files/*', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const requestPath = req.params[0] || '';
    
    const storageRoot = path.resolve(storagePath);
    const fullPath = path.join(storageRoot, requestPath);
    if (!fullPath.startsWith(storageRoot)) {
      return res.status(403).json({ error: 'Forbidden: Access denied.' });
    }

    await fileSystem.delete(fullPath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/files/rename', authenticate, async (req, res) => {
  try {
    const { oldPath, newPath } = req.body;
    await fileSystem.rename(oldPath, newPath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/files/copy', authenticate, async (req, res) => {
  try {
    const { sourcePath, destinationPath } = req.body;
    await fileSystem.copy(sourcePath, destinationPath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/files/move', authenticate, async (req, res) => {
  try {
    const { sourcePath, destinationPath } = req.body;
    await fileSystem.move(sourcePath, destinationPath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new file
app.post('/api/files/create', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const { fileName, currentPath, content = '' } = req.body;

    if (!fileName || !fileName.trim()) {
      return res.status(400).json({ error: 'File name is required' });
    }

    const fullPath = currentPath
      ? `${storagePath}/${currentPath}/${fileName.trim()}`
      : `${storagePath}/${fileName.trim()}`;

    await fileSystem.write(fullPath, content);

    // HYBRID CACHE: Update cache immediately after API operation
    if (fileSystem.cache) {
      await fileSystem.cache.addOrUpdatePath(fullPath);
    }

    systemLogger.logFileOperation('create', path.join(currentPath || '', fileName.trim()), true, req, { fileName, size: content.length });
    res.json({ success: true, message: 'File created successfully' });
  } catch (error) {
    systemLogger.logFileOperation('create', path.join(req.body.currentPath || '', req.body.fileName), false, req, { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Rename file or folder
app.put('/api/files/rename', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const { oldName, newName, currentPath } = req.body;

    if (!oldName || !newName) {
      return res.status(400).json({ error: 'Both old and new names are required' });
    }

    const path = require('path');
    const oldPath = currentPath
      ? path.join(storagePath, currentPath, oldName)
      : path.join(storagePath, oldName);

    const newPath = currentPath
      ? path.join(storagePath, currentPath, newName)
      : path.join(storagePath, newName);

    // Perform rename
    await fileSystem.rename(oldPath, newPath);

    // Force cache refresh for the parent directory
    if (fileSystem.cache && fileSystem.cache.refreshCache) {
      const parentPath = currentPath ? path.join(storagePath, currentPath) : storagePath;
      await fileSystem.cache.scanDirectory(parentPath);
      systemLogger.logCacheOperation('refresh_after_rename', { path: currentPath || '/' }, req);
    }

    systemLogger.logFileOperation('rename', path.join(currentPath || '', oldName), true, req, { newName, oldName });
    res.json({ success: true, message: 'Item renamed successfully' });
  } catch (error) {
    systemLogger.logFileOperation('rename', path.join(req.body.currentPath || '', req.body.oldName), false, req, { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Delete files or folders
app.delete('/api/files/delete', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const { items, currentPath } = req.body;

    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Items array is required' });
    }

    const path = require('path');
    const deletedItems = [];

    for (const item of items) {
      const fullPath = currentPath
        ? path.join(storagePath, currentPath, item.name)
        : path.join(storagePath, item.name);

      await fileSystem.delete(fullPath);
      deletedItems.push(item.name);
      systemLogger.logFileOperation('delete', path.join(currentPath || '', item.name), true, req, { type: item.isDirectory ? 'directory' : 'file' });
    }

    // Force cache refresh for the parent directory
    if (fileSystem.cache && fileSystem.cache.scanDirectory) {
      try {
        const parentPath = currentPath ? path.join(storagePath, currentPath) : storagePath;
        await fileSystem.cache.scanDirectory(parentPath);
        systemLogger.logCacheOperation('refresh_after_delete', { path: currentPath || '/' }, req);
      } catch (cacheError) {
        // Non-fatal cache error (not logged)('Cache refresh error (non-fatal):', cacheError.message);
      }
    }

    res.json({
      success: true,
      message: `${deletedItems.length} item(s) deleted successfully`,
      deletedItems
    });
  } catch (error) {
    systemLogger.logFileOperation('delete', currentPath || '/', false, req, { error: error.message, items: items.map(i => i.name) });
    res.status(500).json({ error: error.message });
  }
});

// Archive endpoint - create zip of multiple files/folders
app.post('/api/archive', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const { items, currentPath } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items array is required' });
    }

    systemLogger.logFileOperation('archive', currentPath || '/', true, req, { itemCount: items.length, items: items.map(i => i.name) });

    // Set response headers for zip download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="archive.zip"');

    // Create archiver instance
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });

    // Pipe archive to response
    archive.pipe(res);

    // Handle archiver warnings and errors
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        systemLogger.logSystem('WARN', `Archive warning: ${err.message}`);
      } else {
        throw err;
      }
    });

    archive.on('error', (err) => {
      systemLogger.logSystem('ERROR', `Archive error: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create archive' });
      }
    });

    // Add each item to the archive
    for (const item of items) {
      const itemPath = currentPath
        ? path.join(storagePath, currentPath, item.name)
        : path.join(storagePath, item.name);

      try {
        const stats = await fs.stat(itemPath);

        if (stats.isDirectory()) {
          // Add directory recursively
          archive.directory(itemPath, item.name);
        } else {
          // Add single file
          archive.file(itemPath, { name: item.name });
        }
      } catch (err) {
        systemLogger.logSystem('ERROR', `Failed to add ${item.name} to archive: ${err.message}`);
        // Continue with other items
      }
    }

    // Finalize the archive
    await archive.finalize();

  } catch (error) {
    systemLogger.logFileOperation('archive', req.body.currentPath || '/', false, req, { error: error.message });
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Paste (copy or move) files
app.post('/api/files/paste', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const { items, operation, targetPath } = req.body;

    if (!items || !Array.isArray(items) || !operation) {
      return res.status(400).json({ error: 'Items array and operation are required' });
    }

    const path = require('path');
    const processedItems = [];

    for (const item of items) {
      const sourcePath = item.sourcePath || (item.currentPath
        ? path.join(storagePath, item.currentPath, item.name)
        : path.join(storagePath, item.name));

      const targetFullPath = targetPath
        ? path.join(storagePath, targetPath, item.name)
        : path.join(storagePath, item.name);

      if (operation === 'copy') {
        await fileSystem.copy(sourcePath, targetFullPath);
        systemLogger.logFileOperation('copy', path.join(targetPath || '', item.name), true, req, { source: sourcePath, target: targetFullPath });
      } else if (operation === 'cut') {
        await fileSystem.move(sourcePath, targetFullPath);
        systemLogger.logFileOperation('move', path.join(targetPath || '', item.name), true, req, { source: sourcePath, target: targetFullPath });
      }

      processedItems.push(item.name);
    }

    // Force cache refresh for both source and target directories
    if (fileSystem.cache && fileSystem.cache.scanDirectory) {
      try {
        // Refresh target directory
        const targetDir = targetPath ? path.join(storagePath, targetPath) : storagePath;
        await fileSystem.cache.scanDirectory(targetDir);
        systemLogger.logCacheOperation('refresh_after_paste', { targetPath: targetPath || '/', operation }, req);

        // For move operations, also refresh source directory
        if (operation === 'cut' && items.length > 0) {
          const firstItem = items[0];
          if (firstItem.sourcePath) {
            const sourceDir = path.dirname(firstItem.sourcePath);
            if (sourceDir !== targetDir) {
              await fileSystem.cache.scanDirectory(sourceDir);
            }
          }
        }
      } catch (cacheError) {
        // Non-fatal cache error (not logged)('Cache refresh error (non-fatal):', cacheError.message);
      }
    }

    res.json({
      success: true,
      message: `${processedItems.length} item(s) ${operation === 'copy' ? 'copied' : 'moved'} successfully`,
      processedItems
    });
  } catch (error) {
    systemLogger.logFileOperation(operation === 'copy' ? 'copy' : 'move', targetPath || '/', false, req, { error: error.message, items: items.map(i => i.name) });
    res.status(500).json({ error: error.message });
  }
});



// Progress tracking routes
app.get('/api/progress/:transferId', authenticate, (req, res) => {
  try {
    const progress = transferManager.getTransfer(req.params.transferId);
    if (!progress) {
      return res.status(404).json({ error: 'Transfer not found' });
    }
    res.json(progress);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Settings API endpoints
app.get('/api/settings', authenticate, async (req, res) => {
  try {
    const settings = {
      enableRateLimit: configManager.get('security.enableRateLimit') === true,
      enableSecurityHeaders: configManager.get('security.enableSecurityHeaders') === true,
      enableInputValidation: configManager.get('security.enableInputValidation') === true,
      enableFileUploadSecurity: configManager.get('security.enableFileUploadSecurity') === true,
      enableRequestLogging: configManager.get('security.enableRequestLogging') === true,
      enableCSP: configManager.get('security.enableCSP') === true
    };

    res.json(settings);
  } catch (error) {
    systemLogger.logSystem('ERROR', `Settings fetch error: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.put('/api/settings', authenticate, async (req, res) => {
  try {
    const {
      enableRateLimit,
      enableSecurityHeaders,
      enableInputValidation,
      enableFileUploadSecurity,
      enableRequestLogging,
      enableCSP
    } = req.body;

    // Update configuration
    configManager.set('security.enableRateLimit', enableRateLimit === true);
    configManager.set('security.enableSecurityHeaders', enableSecurityHeaders === true);
    configManager.set('security.enableInputValidation', enableInputValidation === true);
    configManager.set('security.enableFileUploadSecurity', enableFileUploadSecurity === true);
    configManager.set('security.enableRequestLogging', enableRequestLogging === true);
    configManager.set('security.enableCSP', enableCSP === true);

    // Save configuration to file
    await configManager.save();

    systemLogger.logSystem('INFO', `Security settings updated by user: ${req.user?.username}, Settings: ${JSON.stringify({
      enableRateLimit,
      enableSecurityHeaders,
      enableInputValidation,
      enableFileUploadSecurity,
      enableRequestLogging,
      enableCSP
    })}`);

    res.json({
      success: true,
      message: 'Settings saved successfully. Server restart may be required for some changes to take effect.'
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Settings save error: ${error.message}`);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Admin User Management Endpoints
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await userManager.getAllUsers();
    const stats = await userManager.getUserStats();
    
    res.json({ 
      users,
      stats,
      success: true 
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to fetch users: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, email, role = 'user', permissions } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const newUser = await userManager.createUser({
      username,
      password,
      email,
      role,
      permissions
    });

    systemLogger.logSystem('INFO', `User '${username}' created by admin: ${req.user?.username}`);

    res.status(201).json({
      success: true,
      message: `User '${username}' created successfully`,
      user: newUser
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to create user: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/admin/users/:username', requireAdmin, async (req, res) => {
  try {
    const { username } = req.params;
    const updates = req.body;
    
    const updatedUser = await userManager.updateUser(username, updates);

    systemLogger.logSystem('INFO', `User '${username}' updated by admin: ${req.user?.username}`);

    res.json({
      success: true,
      message: `User '${username}' updated successfully`,
      user: updatedUser
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to update user: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/users/:username', requireAdmin, async (req, res) => {
  try {
    const { username } = req.params;
    
    const result = await userManager.deleteUser(username);

    systemLogger.logSystem('INFO', `User '${username}' deleted by admin: ${req.user?.username}`);

    res.json({
      success: true,
      message: result.message
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to delete user: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/users/:username/change-password', requireAdmin, async (req, res) => {
  try {
    const { username } = req.params;
    const { newPassword } = req.body;
    
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }

    await userManager.updateUser(username, { password: newPassword });

    systemLogger.logSystem('INFO', `Password changed for user '${username}' by admin: ${req.user?.username}`);

    res.json({
      success: true,
      message: `Password changed for user '${username}'`
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to change password: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/admin/users/:username', requireAdmin, async (req, res) => {
  try {
    const { username } = req.params;
    const user = await userManager.getUser(username);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ user, success: true });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to fetch user: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.get('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    // Return current configuration (sanitized - no passwords)
    const config = {
      server: {
        port: configManager.get('server.port') || 3000,
        host: configManager.get('server.host') || 'localhost'
      },
      fileSystem: {
        storagePath: configManager.get('fileSystem.storagePath') || './storage',
        maxFileSize: configManager.get('fileSystem.maxFileSize') || (100 * 1024 * 1024), // 100MB
      },
      security: {
        enableRateLimit: configManager.get('security.enableRateLimit') === true,
        enableSecurityHeaders: configManager.get('security.enableSecurityHeaders') === true,
        enableInputValidation: configManager.get('security.enableInputValidation') === true,
        enableFileUploadSecurity: configManager.get('security.enableFileUploadSecurity') === true,
        enableRequestLogging: configManager.get('security.enableRequestLogging') === true,
        enableCSP: configManager.get('security.enableCSP') === true
      },
      logging: {
        enableDetailedLogging: configManager.get('logging.enableDetailedLogging') === true,
        logLevel: configManager.get('logging.logLevel') || 'info',
        logFileOperations: configManager.get('logging.logFileOperations') === true,
        logSecurityEvents: configManager.get('logging.logSecurityEvents') === true,
        logPerformanceMetrics: configManager.get('logging.logPerformanceMetrics') === true,
        includeUserAgent: configManager.get('logging.includeUserAgent') === true,
        includeRealIP: configManager.get('logging.includeRealIP') === true
      },
      auth: {
        username: configManager.get('auth.username') || 'admin',
        // Never return password
        jwtSecret: configManager.get('security.jwtSecret') ? '[SET]' : '[DEFAULT]'
      }
    };

    res.json({ config, success: true });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to fetch config: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch configuration' });
  }
});

app.put('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const { server, fileSystem, security, logging, auth } = req.body;
    const updatedFields = [];
    
    // Validate and update server settings
    if (server) {
      if (server.port) {
        const port = parseInt(server.port);
        if (port < 1 || port > 65535) {
          return res.status(400).json({ error: 'Port must be between 1 and 65535' });
        }
        configManager.set('server.port', port);
        updatedFields.push('server.port');
      }
      if (server.host) {
        configManager.set('server.host', server.host);
        updatedFields.push('server.host');
      }
    }
    
    // Validate and update file system settings
    if (fileSystem) {
      if (fileSystem.storagePath) {
        // Basic path validation
        if (fileSystem.storagePath.includes('..')) {
          return res.status(400).json({ error: 'Storage path cannot contain ".."' });
        }
        configManager.set('fileSystem.storagePath', fileSystem.storagePath);
        updatedFields.push('fileSystem.storagePath');
      }
      if (fileSystem.maxFileSize) {
        const maxSize = parseInt(fileSystem.maxFileSize);
        if (maxSize < 1024) { // Minimum 1KB
          return res.status(400).json({ error: 'Max file size must be at least 1KB' });
        }
        configManager.set('fileSystem.maxFileSize', maxSize);
        updatedFields.push('fileSystem.maxFileSize');
      }
    }
    
    // Update security settings
    if (security) {
      Object.keys(security).forEach(key => {
        configManager.set(`security.${key}`, Boolean(security[key]));
        updatedFields.push(`security.${key}`);
      });
    }
    
    // Update logging settings
    if (logging) {
      Object.keys(logging).forEach(key => {
        if (key === 'logLevel') {
          const validLevels = ['error', 'warn', 'info', 'debug'];
          if (!validLevels.includes(logging[key])) {
            return res.status(400).json({ 
              error: `Invalid log level. Must be one of: ${validLevels.join(', ')}` 
            });
          }
          configManager.set(`logging.${key}`, logging[key]);
        } else {
          configManager.set(`logging.${key}`, Boolean(logging[key]));
        }
        updatedFields.push(`logging.${key}`);
      });
    }
    
    // Update auth settings (careful with these)
    if (auth) {
      if (auth.username && auth.username !== configManager.get('auth.username')) {
        if (auth.username.length < 3) {
          return res.status(400).json({ error: 'Username must be at least 3 characters long' });
        }
        configManager.set('auth.username', auth.username);
        updatedFields.push('auth.username');
      }
      if (auth.jwtSecret) {
        if (auth.jwtSecret.length < 32) {
          return res.status(400).json({ error: 'JWT secret must be at least 32 characters long' });
        }
        configManager.set('security.jwtSecret', auth.jwtSecret);
        updatedFields.push('security.jwtSecret');
      }
    }
    
    // Save configuration to file
    await configManager.save();

    systemLogger.logSystem('INFO', `Configuration updated by admin: ${req.user?.username}, Updated fields: ${JSON.stringify(updatedFields)}`);

    // Determine restart requirements
    const needsRestart = updatedFields.some(field =>
      field.startsWith('server.') ||
      field === 'security.jwtSecret' ||
      field === 'fileSystem.storagePath'
    );

    res.json({
      success: true,
      message: needsRestart
        ? 'Configuration updated successfully. Server restart required for some changes to take effect.'
        : 'Configuration updated successfully.',
      updatedFields,
      needsRestart
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to update config: ${error.message}`);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

app.post('/api/admin/config/backup', requireAdmin, async (req, res) => {
  try {
    const backup = {
      timestamp: new Date().toISOString(),
      config: configManager.getAll(),
      createdBy: req.user?.username
    };
    
    // Remove sensitive data from backup
    delete backup.config.password;
    delete backup.config.passwordHashed;
    delete backup.config.jwtSecret;
    
    const backupName = `config-backup-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.json`;
    
    res.setHeader('Content-Disposition', `attachment; filename="${backupName}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(backup);
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to create config backup: ${error.message}`);
    res.status(500).json({ error: 'Failed to create configuration backup' });
  }
});

app.post('/api/admin/config/reset', requireAdmin, async (req, res) => {
  try {
    const { section } = req.body;
    
    if (!section) {
      return res.status(400).json({ error: 'Configuration section is required' });
    }
    
    // Reset specific section to defaults
    const defaultConfigs = {
      security: {
        'security.enableRateLimit': false,
        'security.enableSecurityHeaders': false,
        'security.enableInputValidation': false,
        'security.enableFileUploadSecurity': false,
        'security.enableRequestLogging': true,
        'security.enableCSP': false
      },
      logging: {
        'logging.enableDetailedLogging': true,
        'logging.logLevel': 'info',
        'logging.logFileOperations': true,
        'logging.logSecurityEvents': true,
        'logging.logPerformanceMetrics': true,
        'logging.includeUserAgent': true,
        'logging.includeRealIP': true
      }
    };
    
    if (!defaultConfigs[section]) {
      return res.status(400).json({ error: 'Invalid configuration section' });
    }
    
    // Apply defaults
    Object.entries(defaultConfigs[section]).forEach(([key, value]) => {
      configManager.set(key, value);
    });
    
    await configManager.save();

    systemLogger.logSystem('INFO', `Configuration section '${section}' reset to defaults by admin: ${req.user?.username}`);

    res.json({
      success: true,
      message: `Configuration section '${section}' reset to default values`
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to reset config section: ${error.message}`);
    res.status(500).json({ error: 'Failed to reset configuration section' });
  }
});

// Clear file cache endpoint
app.post('/api/admin/cache/clear', requireAdmin, async (req, res) => {
  try {
    // Clear the in-memory cache
    await fileSystem.clearCache();

    systemLogger.logSystem('INFO', `Cache cleared by admin: ${req.user?.username}`);

    res.json({
      success: true,
      message: 'File cache cleared successfully'
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to clear cache: ${error.message}`);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});


// Start server with configuration
async function startServer() {
  try {
    // Load configuration first
    await configManager.load();

    // Initialize security middleware with configuration
    securityMiddleware = initializeSecurity(configManager);

    // Apply security middleware
    app.use(securityMiddleware.securityHeaders);
    app.use(securityMiddleware.requestLogger);
    app.use(securityMiddleware.validateInput);

    // Initialize components after config is loaded
    const jwtSecret = configManager.get('security.jwtSecret') || 'file-transfer-secret-key';

    authManager = new AuthManager({
      jwtSecret: jwtSecret
    });

    // Initialize user manager
    await userManager.initialize();

    // Set JWT secret for middleware
    setJwtSecret(jwtSecret);

    const storagePath = configManager.get('fileSystem.storagePath') || './storage';

    // Initialize enhanced file system with in-memory cache
    fileSystem = new EnhancedMemoryFileSystem(storagePath);
    systemLogger.logSystem('INFO', 'Initializing file system cache in the background...');
    fileSystem.initialize().then(() => {
      isCacheReady = true;
      systemLogger.logSystem('INFO', '✅ File system cache is ready.');
    }).catch(error => {
      systemLogger.logSystem('ERROR', `Failed to initialize file system cache: ${error.message}`);
      // The server will continue to run, but search and file listing might not work correctly.
    });

    // Start periodic cache refresh for external changes (e.g., every 10 minutes)
    const cacheRefreshInterval = 10 * 60 * 1000;
    setInterval(() => {
      if (fileSystem && fileSystem.cache && fileSystem.cache.refreshCache) {
        systemLogger.logSystem('INFO', 'Performing scheduled full cache refresh to sync external changes...');
        fileSystem.cache.refreshCache();
      }
    }, cacheRefreshInterval);

    const port = configManager.get('server.port') || 3000;

    console.log('Configuration loaded:');
    console.log('- Port:', port);
    console.log('- Username:', configManager.get('auth.username'));
    console.log('- Storage Path:', storagePath);

    // Log cache information
    const cacheInfo = await fileSystem.getCacheInfo();
    console.log('- Cache Status:', cacheInfo.initialized ? 'Active' : 'Inactive');
    if (cacheInfo.initialized) {
      console.log(`- Cached Files: ${cacheInfo.totalFiles}`);
      console.log(`- Cached Directories: ${cacheInfo.totalDirectories}`);
      console.log(`- File Watcher: ${cacheInfo.isWatching ? 'Active' : 'Inactive'}`);
    }

    app.listen(port, async () => {
      console.log(`\n🌐 File Transfer API is now running!`);
      console.log('='.repeat(50));

      // Show all available access URLs
      const networkInterfaces = getNetworkInterfaces();
      console.log('📡 Available access URLs:');
      console.log(`   🏠 Local:     http://localhost:${port}`);
      console.log(`   🏠 Local:     http://127.0.0.1:${port}`);

      if (networkInterfaces.length > 0) {
        networkInterfaces.forEach(iface => {
          console.log(`   🌍 Network:   http://${iface.address}:${port} (${iface.name})`);
        });
      } else {
        console.log('   ⚠️  No external network interfaces found');
      }

      console.log('\n💡 Access the application from any device on your network!');
      console.log('='.repeat(50));

      // Perform security checks
      await performSecurityChecks(configManager);

      console.log('\n🚀 Server is ready!');

      // Log server startup
      const accessUrls = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
      networkInterfaces.forEach(iface => {
        accessUrls.push(`http://${iface.address}:${port}`);
      });
      systemLogger.logSystem('INFO', `Server started successfully on port ${port}. Access URLs: ${accessUrls.join(', ')}`);
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to start server: ${error.message}`);
    process.exit(1);
  }
}

// Graceful shutdown handling
process.on('SIGINT', async () => {
  console.log('\n🛑 Received SIGINT, shutting down gracefully...');
  await gracefulShutdown();
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  await gracefulShutdown();
});

async function gracefulShutdown() {
  try {
    systemLogger.logSystem('INFO', 'Starting graceful shutdown...');
    console.log('Closing file system cache...');
    if (fileSystem && fileSystem.close) {
      await fileSystem.close();
    }
    console.log('✅ File system cache closed');

    systemLogger.logSystem('INFO', 'Server shutdown completed successfully');
    console.log('🚀 Server shutdown complete');
    process.exit(0);
  } catch (error) {
    systemLogger.logSystem('ERROR', `Error during shutdown: ${error.message}`);
    process.exit(1);
  }
}

startServer();

module.exports = app;
