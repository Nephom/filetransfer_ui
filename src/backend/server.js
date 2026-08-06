// Main server file for file transfer application
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcrypt');
const fs = require('fs').promises;
const fsSync = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');
const archiver = require('archiver');
const crypto = require('crypto');
const configManager = require('./config');
const { EnhancedMemoryFileSystem } = require('./file-system');
const { LocationManager, LocationPermissionManager } = require('./location');
const AuthManager = require('./auth');
const UserManager = require('./auth/user-manager');
const UploadAPI = require('./api/upload.js');
const shareRoutes = require('./api/share');
const sslRoutes = require('./api/ssl');
const database = require('./database/db');
const shareManager = require('./auth/share-manager');
const { transferManager } = require('./transfer');
const { authenticate, setJwtSecret, requireAdmin } = require('./middleware/auth');
const { initializeSecurity } = require('./middleware/security');
const { createLogger, systemLogger } = require('./utils/logger');
const certificateManager = require('./ssl/certificate-manager');
const sanManager = require('./ssl/san-manager');
const pidManager = require('./utils/pid-manager');
const { getVersion } = require('../../scripts/version');



// Initialize user manager
const userManager = new UserManager();

// Initialize app
const app = express();

// These will be initialized after config is loaded
let authManager;
let fileSystem;
let locationManager;
let locationPermissionManager;
const locationFileSystems = new Map();

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const publicLocationLabel = (location) => `${location.displayName} (${location.id})`;
const publicErrorMessage = (error) => {
  let message = error?.message || String(error);
  if (!locationManager) return message;
  const filesystemPermissionError = /\b(?:EACCES|EPERM)\b/i.test(message);
  const matchedLabels = [];

  for (const location of locationManager.getLocations().sort((left, right) => right.rootPath.length - left.rootPath.length)) {
    if (location.rootPath === path.parse(location.rootPath).root) continue;
    const rootPattern = new RegExp(`${escapeRegExp(location.rootPath)}(?=$|[\\/])`, 'g');
    if (rootPattern.test(message)) matchedLabels.push(publicLocationLabel(location));
    rootPattern.lastIndex = 0;
    message = message.replace(rootPattern, publicLocationLabel(location));
  }
  if (filesystemPermissionError) {
    const locations = matchedLabels.length > 0 ? matchedLabels.join(', ') : 'the requested Location';
    return `Permission denied: the server process cannot access ${locations}. Check the filesystem ownership and permissions of the configured directory.`;
  }
  return message;
};

const getRequestedLocationId = (req) => req.query?.locationId || req.body?.locationId || req.headers['x-location-id'];

const getStorageContext = async (req, relativePath = '', capability = 'list', requestedLocationId = null) => {
  if (!locationManager) {
    throw Object.assign(new Error('Location service is not ready'), { statusCode: 503 });
  }

  const requestedId = requestedLocationId || getRequestedLocationId(req);
  const locationId = requestedId || (locationManager.getLocation('default') ? 'default' : null);
  if (!locationId) {
    throw Object.assign(new Error('locationId is required'), { statusCode: 400 });
  }

  const location = locationManager.getLocation(locationId);
  if (!location || !location.enabled) {
    throw Object.assign(new Error('Location is unavailable'), { statusCode: 404 });
  }
  await locationPermissionManager.assertCurrent(req.user, locationId, capability);
  const health = await locationManager.getHealth(locationId);
  if (health.status !== 'online') {
    throw Object.assign(new Error('Location storage is unavailable'), {
      statusCode: 503,
      storageCode: health.status
    });
  }

  let targetPath;
  try {
    targetPath = locationManager.resolveRelativePath(locationId, relativePath || '');
  } catch (error) {
    throw Object.assign(new Error('Path is outside the selected Location'), { statusCode: 403 });
  }

  let locationFileSystem = locationFileSystems.get(locationId);
  if (!locationFileSystem) {
    locationFileSystem = new EnhancedMemoryFileSystem(location.rootPath);
    await locationFileSystem.initialize();
    locationFileSystems.set(locationId, locationFileSystem);
  }

  return {
    locationId,
    location,
    rootPath: location.rootPath,
    targetPath,
    fileSystem: locationFileSystem
  };
};

const refreshDirectoryCache = async (directoryPath, operation, req, targetFileSystem = fileSystem) => {
  if (!targetFileSystem?.cache) return;
  if (targetFileSystem.cache.refreshDirectory) {
    await targetFileSystem.cache.refreshDirectory(directoryPath);
  } else if (targetFileSystem.cache.scanDirectory) {
    await targetFileSystem.cache.scanDirectory(directoryPath);
  }
  systemLogger.logCacheOperation(operation, { path: directoryPath }, req);
};
let securityMiddleware;
let isCacheReady = false;
const userActiveDirectories = new Map(); // Track active directory per user
let httpServerInstance = null;
let httpsServerInstance = null;
let tempUploadCleanupInterval = null;
const browserHandoffs = new Map();

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
app.use(cors({
  credentials: true,
  origin: true,
  exposedHeaders: ['Authorization'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
// Increase JSON body limit to 100MB for large file metadata
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static(path.join(__dirname, '../frontend/public'), {
  setHeaders: (response, filePath) => {
    if (/\.(?:html|js|jsx|css)$/.test(filePath)) {
      response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

// Use the UploadAPI router for all upload endpoints
const uploadApi = new UploadAPI();
app.use('/api', uploadApi.getRouter());

const configureLocationRuntime = () => {
  for (const cachedFileSystem of locationFileSystems.values()) {
    if (cachedFileSystem !== fileSystem) {
      const closing = cachedFileSystem.cache?.close?.();
      closing?.catch(() => {});
    }
  }
  locationFileSystems.clear();

  locationManager = new LocationManager(configManager.getConfig());
  locationPermissionManager = new LocationPermissionManager(locationManager);
  locationPermissionManager.setUserResolver((username) => userManager.getUser(username));
  shareRoutes.setLocationPermissionManager?.(locationPermissionManager);

  const defaultLocation = locationManager.getLocation('default');
  if (fileSystem && defaultLocation && defaultLocation.rootPath === path.resolve(fileSystem.storagePath)) {
    locationFileSystems.set('default', fileSystem);
  }

  uploadApi.setCache(fileSystem?.cache);
  uploadApi.setLocationManager(locationManager, async (locationId) => {
    let targetFileSystem = locationFileSystems.get(locationId);
    if (!targetFileSystem) {
      const location = locationManager.getLocation(locationId);
      if (!location) return null;
      targetFileSystem = new EnhancedMemoryFileSystem(location.rootPath);
      await targetFileSystem.initialize();
      locationFileSystems.set(locationId, targetFileSystem);
    }
    return targetFileSystem.cache;
  }, locationPermissionManager);
};

// Share routes - /api/share/:token/download does NOT require authentication
// Other share routes require authentication via middleware
app.use('/api', shareRoutes);

// SSL management routes (admin only)
app.use('/api', sslRoutes);

// Routes
// The document itself contains no protected data. Its requests remain guarded by
// requireAdmin, while loading it without a header permits normal browser navigation.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/admin.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

app.get('/api/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json(getVersion());
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

app.post('/auth/browser-handoff', authenticate, requireAdmin, (req, res) => {
  const authorization = req.get('Authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authorization token missing' });

  const code = crypto.randomBytes(32).toString('base64url');
  browserHandoffs.set(code, { token, expiresAt: Date.now() + 60_000 });
  res.set('Cache-Control', 'no-store');
  res.json({ url: `/auth/browser-handoff/${code}` });
});

app.get('/auth/browser-handoff/:code', (req, res) => {
  const handoff = browserHandoffs.get(req.params.code);
  browserHandoffs.delete(req.params.code);
  if (!handoff || handoff.expiresAt < Date.now()) return res.status(410).send('This browser sign-in link has expired.');

  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Type': 'text/html; charset=utf-8' });
  res.send(`<!doctype html><meta name="referrer" content="no-referrer"><script>localStorage.setItem('token', ${JSON.stringify(handoff.token)});location.replace('/admin');</script>`);
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

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }

    const configUsername = configManager.get('auth.username');
    if (req.user.username === configUsername) {
      const configPassword = configManager.get('auth.password');
      const passwordHashed = configManager.get('auth.passwordHashed');
      const validPassword = passwordHashed === true || passwordHashed === 'true'
        ? await bcrypt.compare(currentPassword, configPassword)
        : currentPassword === configPassword;

      if (!validPassword) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      const hashedPassword = await bcrypt.hash(newPassword, 12);
      const configPath = './src/config.ini';
      let configContent = await fs.readFile(configPath, 'utf8');
      configContent = configContent.replace(/^password=.*$/m, `password=${hashedPassword}`);
      configContent = configContent.includes('passwordHashed=true')
        ? configContent.replace(/^passwordHashed=.*$/m, 'passwordHashed=true')
        : `${configContent}\npasswordHashed=true`;
      await fs.writeFile(configPath, configContent);
      await configManager.load();
    } else {
      await userManager.changeOwnPassword(req.user.username, currentPassword, newPassword);
    }

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

// Token verification endpoint
app.post('/auth/verify', (req, res, next) => {
  // Apply auth limiter if security middleware is initialized
  if (securityMiddleware && securityMiddleware.authLimiter) {
    securityMiddleware.authLimiter(req, res, next);
  } else {
    next();
  }
}, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No valid authorization header' });
    }

    const token = authHeader.substring(7);
    const jwt = require('jsonwebtoken');
    const jwtSecret = configManager.get('security.jwtSecret') || 'file-transfer-secret-key';

    try {
      const decoded = jwt.verify(token, jwtSecret);

      // Return user information without sensitive data
      res.json({
        success: true,
        user: {
          id: decoded.id,
          username: decoded.username,
          role: decoded.role
        }
      });
    } catch (jwtError) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  } catch (error) {
    systemLogger.logSystem('ERROR', `Token verification error: ${error.message}`);
    res.status(500).json({ error: 'Token verification failed' });
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
    systemLogger.logSystem('INFO', '='.repeat(60));
    systemLogger.logSystem('INFO', '🔐 PASSWORD RESET REQUEST');
    systemLogger.logSystem('INFO', '='.repeat(60));
    systemLogger.logSystem('INFO', `Username: ${username}`);
    systemLogger.logSystem('INFO', `Reset Token: ${resetToken}`);
    systemLogger.logSystem('INFO', `Valid for: 15 minutes`);
    systemLogger.logSystem('INFO', 'Use this token to reset your password within 15 minutes.');
    systemLogger.logSystem('INFO', '='.repeat(60));

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

    const context = await getStorageContext(req, '', 'read');

    // Search using Redis index (no timeout needed - index queries are fast)
    const searchResults = await context.fileSystem.searchFiles(query);

    // Check if indexing is in progress
    if (searchResults.indexing) {
      systemLogger.logAPI('search', query, false, req, { status: 'indexing', progress: searchResults.progress });
      return res.status(202).json({
        files: [],
        indexing: true,
        message: searchResults.message || 'Index is currently building. Please try again later.',
        progress: searchResults.progress
      });
    }

    // Check for errors
    if (searchResults.error) {
      systemLogger.logAPI('search', query, false, req, { error: searchResults.error });
      return res.status(500).json({
        error: searchResults.error,
        files: []
      });
    }

    const files = (searchResults.files || []).filter((file) => file && typeof file.name === 'string' && file.name.trim() && typeof file.path === 'string' && file.path.trim());
    systemLogger.logAPI('search', query, true, req, { resultCount: files.length, skippedResults: searchResults.files.length - files.length });
    res.json({
      files,
      resultCount: files.length,
      locationId: context.locationId,
      indexStats: searchResults.indexStats
    });
  } catch (error) {
    systemLogger.logAPI('search', req.body.query || req.query.query, false, req, { error: error.message });
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
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

    const context = await getStorageContext(req, '', 'read');

    // Search using Redis index (no timeout needed - index queries are fast)
    const searchResults = await context.fileSystem.searchFiles(query);

    // Check if indexing is in progress
    if (searchResults.indexing) {
      systemLogger.logAPI('search', query, false, req, { status: 'indexing', progress: searchResults.progress });
      return res.status(202).json({
        files: [],
        indexing: true,
        message: searchResults.message || 'Index is currently building. Please try again later.',
        progress: searchResults.progress
      });
    }

    // Check for errors
    if (searchResults.error) {
      systemLogger.logAPI('search', query, false, req, { error: searchResults.error });
      return res.status(500).json({
        error: searchResults.error,
        files: []
      });
    }

    const files = (searchResults.files || []).filter((file) => file && typeof file.name === 'string' && file.name.trim() && typeof file.path === 'string' && file.path.trim());
    systemLogger.logAPI('search', query, true, req, { resultCount: files.length, skippedResults: searchResults.files.length - files.length });
    res.json({
      files,
      resultCount: files.length,
      locationId: context.locationId,
      indexStats: searchResults.indexStats
    });
  } catch (error) {
    systemLogger.logAPI('search', req.query.query, false, req, { error: error.message });
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// IMPORTANT: Specific routes must come before the general '/api/files/*' wildcard route.

// Cache statistics endpoint
app.get('/api/files/cache-stats', authenticate, async (req, res) => {
  try {
    const context = await getStorageContext(req, '', 'list');
    const stats = await context.fileSystem.getCacheInfo ? await context.fileSystem.getCacheInfo() : { message: 'Cache stats not available' };
    res.json({ ...stats, locationId: context.locationId });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Cache stats error: ${error.message}`);
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Index status endpoint - shows global search index status
app.get('/api/files/index-status', authenticate, async (req, res) => {
  try {
    const context = await getStorageContext(req, '', 'list');
    if (!context.fileSystem.cache || !context.fileSystem.cache.getIndexStatus) {
      return res.status(404).json({ error: 'Index status not available' });
    }
    const status = await context.fileSystem.cache.getIndexStatus();
    res.json({ ...status, locationId: context.locationId });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Index status error: ${error.message}`);
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Trigger manual index rebuild endpoint (admin only recommended)
app.post('/api/files/rebuild-index', authenticate, async (req, res) => {
  try {
    const context = await getStorageContext(req, '', 'list');
    if (!context.fileSystem.cache || !context.fileSystem.cache.buildGlobalIndex) {
      return res.status(404).json({ error: 'Index rebuild not available' });
    }

    // Check if already indexing
    const status = await context.fileSystem.cache.getIndexStatus();
    if (status.isIndexing) {
      return res.status(409).json({
        error: 'Index rebuild already in progress',
        progress: status.progress
      });
    }

    // Start index rebuild in background (don't await)
    context.fileSystem.cache.buildGlobalIndex().catch(err => {
      systemLogger.logSystem('ERROR', `Background index rebuild failed: ${err.message}`);
    });

    systemLogger.logAPI('rebuild_index', 'manual trigger', true, req);
    res.json({
      message: 'Index rebuild started in background',
      status: 'started'
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Index rebuild error: ${error.message}`);
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Cache refresh endpoint (for manual cache updates)
app.get('/api/locations', authenticate, async (req, res) => {
  try {
    if (!locationManager) return res.status(503).json({ error: 'Location service is not ready' });
    const currentUser = req.user.role === 'admin'
      ? req.user
      : await userManager.getUser(req.user.username) || req.user;
    const locations = await Promise.all(locationPermissionManager.getAccessibleLocations(currentUser).map(async (location) => {
      const health = await locationManager.getHealth(location.id);
      return { ...location, status: health.status, errorCode: health.errorCode };
    }));
    res.json({ success: true, locations });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

app.post('/api/files/refresh-cache', authenticate, async (req, res) => {
  try {
    const { directoryPath } = req.body; // Allow partial refresh
    const context = await getStorageContext(req, directoryPath || '', 'list');

    if (directoryPath) {
      await refreshDirectoryCache(context.targetPath, 'refresh_directory', req, context.fileSystem);
      res.json({ success: true, locationId: context.locationId, message: `Cache for ${directoryPath} refreshed.` });
    } else {
      systemLogger.logCacheOperation('refresh_full', {}, req);
      if (context.fileSystem.cache && context.fileSystem.cache.refreshCache) {
        await context.fileSystem.cache.refreshCache();
      }
      res.json({ success: true, locationId: context.locationId, message: 'Entire cache refreshed successfully' });
    }
  } catch (error) {
    systemLogger.logSystem('ERROR', `Cache refresh error: ${error.message}`);
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Get file content
app.get('/api/files/content/*', authenticate, async (req, res) => {
  try {
    const requestPath = req.params[0] || '';
    const context = await getStorageContext(req, requestPath, 'read');
    const content = await context.fileSystem.read(context.targetPath);
    res.json({ content: content.toString() });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Download file endpoint
app.get('/api/files/download/*', authenticate, async (req, res) => {
  const requestStartedAt = Date.now();
  let responseFinished = false;
  let streamFailed = false;
  let fileName = req.params[0] || 'unknown';
  try {
    const requestPath = req.params[0] || '';
    const context = await getStorageContext(req, requestPath, 'read');
    const fullPath = context.targetPath;

    const stats = await fs.stat(fullPath);
    if (stats.isDirectory()) {
      systemLogger.logDownload(requestPath, 'authenticated', false, req, { error: 'Attempted to download directory' });
      return res.status(400).json({ error: 'This endpoint only supports file downloads. For directory downloads, please use the archive functionality.' });
    }

    fileName = path.basename(fullPath);
    const userName = req.user?.username || req.user?.id || 'unknown';
    systemLogger.logSystem('INFO', `DOWNLOAD START - User: ${userName}, Path: ${requestPath}, File: ${fileName}, Size: ${stats.size} bytes`);
    // Use RFC 2231 encoding for UTF-8 filenames
    const encodedFileName = encodeURIComponent(fileName);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedFileName}`);
    res.setHeader('Content-Type', 'application/octet-stream');

    res.on('finish', () => {
      responseFinished = true;
      const duration = Date.now() - requestStartedAt;
      if (streamFailed) return;
      systemLogger.logSystem('INFO', `DOWNLOAD COMPLETE - User: ${userName}, File: ${fileName}, Status: ${res.statusCode}, Bytes: ${stats.size}, Duration: ${duration}ms`);
      systemLogger.logDownload(fileName, 'authenticated', true, req, { size: stats.size });
    });
    res.on('close', () => {
      if (!responseFinished) {
        const duration = Date.now() - requestStartedAt;
        systemLogger.logSystem('WARN', `DOWNLOAD ABORTED - User: ${userName}, File: ${fileName}, Status: ${res.statusCode}, BytesWritten: ${res.socket?.bytesWritten || 0}, Duration: ${duration}ms`);
        systemLogger.logDownload(fileName, 'authenticated', false, req, { size: stats.size, error: 'Client disconnected before response finished' });
      }
    });

    const fileStream = fsSync.createReadStream(fullPath);
    systemLogger.logSystem('INFO', `DOWNLOAD STREAM OPEN - User: ${userName}, File: ${fileName}`);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      streamFailed = true;
      systemLogger.logSystem('ERROR', `DOWNLOAD STREAM FAILED - User: ${userName}, File: ${fileName}, Error: ${error.message}`);
      systemLogger.logDownload(fileName, 'authenticated', false, req, { error: error.message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download file' });
      }
    });
  } catch (error) {
    // Catch file not found errors from fs.stat
    if (error.code === 'ENOENT') {
      systemLogger.logDownload(req.params[0] || 'unknown', 'authenticated', false, req, { error: 'File not found' });
      return res.status(404).json({ error: 'File not found' });
    }
    systemLogger.logSystem('ERROR', `DOWNLOAD SETUP FAILED - User: ${req.user?.username || req.user?.id || 'unknown'}, File: ${fileName}, Error: ${error.message}`);
    systemLogger.logDownload(req.params[0] || 'unknown', 'authenticated', false, req, { error: error.message });
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Handle root files API call
app.get('/api/files', authenticate, async (req, res) => {
  if (!isCacheReady) {
    return res.status(503).json({ error: 'Cache is warming up. Please try again in a few moments.' });
  }

  const requestStartTime = Date.now(); // Performance monitoring

  try {
    const { path: requestPath, offset, limit } = req.query;
    const context = await getStorageContext(req, requestPath || '', 'list');
    const { locationId, rootPath: storageRoot, targetPath, fileSystem: locationFileSystem } = context;

    const isRootDir = targetPath === storageRoot;

    // --- On-demand watcher integration ---
    const userId = req.user.id;
    const activeDirectoryKey = `${userId}:${locationId}`;
    const previousPath = userActiveDirectories.get(activeDirectoryKey);

    const cacheOperationStart = Date.now();
    if (previousPath && previousPath !== targetPath) {
      await locationFileSystem.cache.leaveDirectory(previousPath);
    }
    await locationFileSystem.cache.enterDirectory(targetPath);
    userActiveDirectories.set(activeDirectoryKey, targetPath);
    const cacheOperationTime = Date.now() - cacheOperationStart;

    systemLogger.logSystem('INFO', `📊 Cache operation took ${cacheOperationTime}ms for ${isRootDir ? 'ROOT' : 'subdirectory'}`);
    // ------------------------------------

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), 30000);
    });

    // OPTIMIZATION: Support pagination parameters
    const listOptions = {};
    if (offset !== undefined) {
      listOptions.offset = parseInt(offset) || 0;
    }
    if (limit !== undefined) {
      listOptions.limit = parseInt(limit) || 1000;
    }

    const rawFiles = await Promise.race([
      locationFileSystem.list(targetPath, listOptions),
      timeoutPromise
    ]);

    // Handle paginated response
    let transformedFiles, paginationInfo;
    if (rawFiles && rawFiles.files !== undefined) {
      // Paginated response
      transformedFiles = rawFiles.files.map(file => {
        const relativePath = path.relative(storageRoot, file.path);
        return {
          ...file,
          name: path.basename(file.path),
          path: relativePath,
          isDirectory: file.isDirectory === 'true' || file.isDirectory === true,
          size: parseInt(file.size) || 0,
          modified: parseInt(file.modified) || 0
        };
      });
      paginationInfo = {
        total: rawFiles.total,
        offset: rawFiles.offset,
        limit: rawFiles.limit,
        hasMore: rawFiles.hasMore
      };
    } else {
      // Non-paginated response (legacy)
      transformedFiles = rawFiles.map(file => {
        const relativePath = path.relative(storageRoot, file.path);
        return {
          ...file,
          name: path.basename(file.path),
          path: relativePath,
          isDirectory: file.isDirectory === 'true' || file.isDirectory === true,
          size: parseInt(file.size) || 0,
          modified: parseInt(file.modified) || 0
        };
      });
    }

    // Return in the format expected by FileBrowser
    const currentPath = path.relative(storageRoot, targetPath) || '';

    const totalRequestTime = Date.now() - requestStartTime;
    systemLogger.logAPI('list', requestPath || '/', true, req, {
      fileCount: transformedFiles.length,
      responseTime: `${totalRequestTime}ms`,
      cacheTime: `${cacheOperationTime}ms`
    });

    const response = {
      files: transformedFiles,
      currentPath: currentPath,
      locationId,
      success: true
    };

    // Add pagination info if available
    if (paginationInfo) {
      response.pagination = paginationInfo;
    }

    // Add cache-control headers for performance
    // Root directory: short cache (3 seconds, aligned with polling interval)
    // Subdirectories: slightly longer cache (5 seconds)
    const cacheMaxAge = isRootDir ? 3 : 5;
    res.setHeader('Cache-Control', `private, max-age=${cacheMaxAge}`);
    res.setHeader('X-Response-Time', `${totalRequestTime}ms`);
    res.setHeader('X-Cache-Time', `${cacheOperationTime}ms`);

    res.json(response);
  } catch (error) {
    if (error.message === 'Request timeout') {
      systemLogger.logAPI('list', req.query.path || '/', false, req, { error: 'Request timeout' });
      res.status(408).json({ error: 'Request timeout - file system may be busy' });
    } else {
      systemLogger.logAPI('list', req.query.path || '/', false, req, { error: error.message });
      res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
    }
  }
});

// Create/write file
app.post('/api/files', authenticate, async (req, res) => {
  try {
    const { path: requestPath, content } = req.body;
    const fullPath = await getStorageContext(req, requestPath, 'write').then((context) => {
      return { ...context, parentPath: path.dirname(context.targetPath) };
    });

    await fullPath.fileSystem.write(fullPath.targetPath, content);
    await refreshDirectoryCache(fullPath.parentPath, 'refresh_after_write', req, fullPath.fileSystem);
    res.json({ success: true, locationId: fullPath.locationId });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Create new folder
app.post('/api/folders', authenticate, async (req, res) => {
  try {
    const { folderName, currentPath } = req.body;

    if (!folderName || !folderName.trim()) {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    const relativePath = currentPath ? path.join(currentPath, folderName.trim()) : folderName.trim();
    const context = await getStorageContext(req, relativePath, 'mkdir');
    const parentContext = await getStorageContext(req, currentPath || '', 'mkdir');

    await context.fileSystem.mkdir(context.targetPath);

    // Force cache refresh for the parent directory
    if (context.fileSystem.cache) {
      try {
        await refreshDirectoryCache(parentContext.targetPath, 'refresh_after_mkdir', req, context.fileSystem);
      } catch (cacheError) {
        // Non-fatal cache error (not logged)('Cache refresh error (non-fatal):', cacheError.message);
      }
    }

    systemLogger.logFileOperation('mkdir', relativePath, true, req, { folderName });
    res.json({ success: true, locationId: context.locationId, message: 'Folder created successfully' });
  } catch (error) {
    systemLogger.logFileOperation('mkdir', req.body.currentPath || '/', false, req, { error: error.message, folderName: req.body.folderName });
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// ========== SPECIFIC ROUTES (must be before wildcard routes) ==========

// Legacy endpoint for backward compatibility
app.post('/api/files/directory', authenticate, async (req, res) => {
  try {
    const { path: requestPath } = req.body;
    const context = await getStorageContext(req, requestPath, 'mkdir');
    await context.fileSystem.mkdir(context.targetPath);
    await refreshDirectoryCache(path.dirname(context.targetPath), 'refresh_after_mkdir', req, context.fileSystem);
    res.json({ success: true, locationId: context.locationId });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Delete files or folders (specific route - must be before wildcard)
app.delete('/api/files/delete', authenticate, async (req, res) => {
  try {
    const { items, currentPath } = req.body;

    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Items array is required' });
    }

    const deletedItems = [];
    const context = await getStorageContext(req, currentPath || '', 'delete');

    for (const item of items) {
      const itemContext = await getStorageContext(req, path.join(currentPath || '', item.name), 'delete');

      await context.fileSystem.delete(itemContext.targetPath);
      deletedItems.push(item.name);
      systemLogger.logFileOperation('delete', path.join(currentPath || '', item.name), true, req, { type: item.isDirectory ? 'directory' : 'file' });
    }

    // Force cache refresh for the parent directory
    if (context.fileSystem.cache) {
      try {
        await refreshDirectoryCache(context.targetPath, 'refresh_after_delete', req, context.fileSystem);
      } catch (cacheError) {
        // Non-fatal cache error (not logged)('Cache refresh error (non-fatal):', cacheError.message);
      }
    }

    res.json({
      success: true,
      message: `${deletedItems.length} item(s) deleted successfully`,
      deletedItems,
      locationId: context.locationId
    });
  } catch (error) {
    systemLogger.logFileOperation('delete', req.body.currentPath || '/', false, req, { error: error.message, items: req.body.items?.map(i => i.name) });
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Rename file or folder (specific route - must be before wildcard)
app.put('/api/files/rename', authenticate, async (req, res) => {
  try {
    const { oldName, newName, currentPath } = req.body;

    if (!oldName || !newName) {
      return res.status(400).json({ error: 'Both old and new names are required' });
    }

    const oldContext = await getStorageContext(req, path.join(currentPath || '', oldName), 'rename');
    const newContext = await getStorageContext(req, path.join(currentPath || '', newName), 'rename');

    // Perform rename
    await oldContext.fileSystem.rename(oldContext.targetPath, newContext.targetPath);

    // Force cache refresh for the parent directory
    if (oldContext.fileSystem.cache) {
      try {
        await refreshDirectoryCache(path.dirname(oldContext.targetPath), 'refresh_after_rename', req, oldContext.fileSystem);
      } catch (cacheError) {
        // Non-fatal cache error
        systemLogger.logSystem('WARN', `Cache refresh after rename failed (non-fatal): ${cacheError.message}`);
      }
    }

    systemLogger.logFileOperation('rename', path.join(currentPath || '', oldName), true, req, { newName, oldName });
    res.json({ success: true, locationId: oldContext.locationId, message: 'Item renamed successfully' });
  } catch (error) {
    systemLogger.logFileOperation('rename', path.join(req.body.currentPath || '', req.body.oldName), false, req, { error: error.message });
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Create new file (specific route - must be before wildcard)
app.post('/api/files/create', authenticate, async (req, res) => {
  try {
    const { fileName, currentPath, content = '' } = req.body;

    if (!fileName || !fileName.trim()) {
      return res.status(400).json({ error: 'File name is required' });
    }

    const context = await getStorageContext(req, path.join(currentPath || '', fileName.trim()), 'write');

    await context.fileSystem.write(context.targetPath, content);

    await refreshDirectoryCache(path.dirname(context.targetPath), 'refresh_after_create', req, context.fileSystem);

    systemLogger.logFileOperation('create', path.join(currentPath || '', fileName.trim()), true, req, { fileName, size: content.length });
    res.json({ success: true, locationId: context.locationId, message: 'File created successfully' });
  } catch (error) {
    systemLogger.logFileOperation('create', path.join(req.body.currentPath || '', req.body.fileName), false, req, { error: error.message });
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Copy/Move/Paste operations (specific routes - must be before wildcard)
app.post('/api/files/copy', authenticate, async (req, res) => {
  try {
    const { sourcePath, destinationPath, sourceLocationId, targetLocationId, destinationLocationId } = req.body;
    const targetId = targetLocationId || destinationLocationId;
    const sourceContext = await getStorageContext(req, sourcePath, 'copy', sourceLocationId);
    const destinationContext = await getStorageContext(req, destinationPath, 'copy', targetId);
    await destinationContext.fileSystem.copy(sourceContext.targetPath, destinationContext.targetPath);
    await refreshDirectoryCache(path.dirname(destinationContext.targetPath), 'refresh_after_copy', req, destinationContext.fileSystem);
    res.json({ success: true, locationId: destinationContext.locationId, sourceLocationId: sourceContext.locationId, targetLocationId: destinationContext.locationId });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

app.post('/api/files/move', authenticate, async (req, res) => {
  try {
    const { sourcePath, destinationPath, sourceLocationId, targetLocationId, destinationLocationId } = req.body;
    const targetId = targetLocationId || destinationLocationId;
    const sourceContext = await getStorageContext(req, sourcePath, 'move', sourceLocationId);
    const destinationContext = await getStorageContext(req, destinationPath, 'move', targetId);
    if (sourceContext.locationId === destinationContext.locationId) {
      await sourceContext.fileSystem.move(sourceContext.targetPath, destinationContext.targetPath);
    } else {
      await destinationContext.fileSystem.copy(sourceContext.targetPath, destinationContext.targetPath);
      await sourceContext.fileSystem.delete(sourceContext.targetPath);
    }
    await refreshDirectoryCache(path.dirname(sourceContext.targetPath), 'refresh_after_move_source', req, sourceContext.fileSystem);
    await refreshDirectoryCache(path.dirname(destinationContext.targetPath), 'refresh_after_move_destination', req, destinationContext.fileSystem);
    res.json({ success: true, locationId: destinationContext.locationId, sourceLocationId: sourceContext.locationId, targetLocationId: destinationContext.locationId });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Paste (copy or move) files (specific route - must be before wildcard)
app.post('/api/files/paste', authenticate, async (req, res) => {
  try {
    const { items, operation, targetPath, sourceLocationId, targetLocationId, destinationLocationId } = req.body;

    if (!items || !Array.isArray(items) || !operation) {
      return res.status(400).json({ error: 'Items array and operation are required' });
    }

    const processedItems = [];
    const sourceDirectories = new Set();
    const pasteCapability = operation === 'copy' ? 'copy' : 'move';
    const targetId = targetLocationId || destinationLocationId;
    const targetContext = await getStorageContext(req, targetPath || '', pasteCapability, targetId);

    for (const item of items) {
      // Build source path from item.path (relative path from frontend)
      const itemSourceLocationId = item.sourceLocationId || sourceLocationId;
      const sourceContext = await getStorageContext(req, item.path, pasteCapability, itemSourceLocationId);
      const targetItemContext = await getStorageContext(req, path.join(targetPath || '', item.name), pasteCapability, targetContext.locationId);
      const sourceFullPath = sourceContext.targetPath;
      const targetFullPath = targetItemContext.targetPath;

      sourceDirectories.add({ fileSystem: sourceContext.fileSystem, path: path.dirname(sourceFullPath) });

      if (operation === 'copy') {
        await targetItemContext.fileSystem.copy(sourceFullPath, targetFullPath);
        systemLogger.logFileOperation('copy', path.join(targetPath || '', item.name), true, req, { source: sourceFullPath, target: targetFullPath });
      } else if (operation === 'cut') {
        if (sourceContext.locationId === targetItemContext.locationId) {
          await sourceContext.fileSystem.move(sourceFullPath, targetFullPath);
        } else {
          await targetItemContext.fileSystem.copy(sourceFullPath, targetFullPath);
          await sourceContext.fileSystem.delete(sourceFullPath);
        }
        systemLogger.logFileOperation('move', path.join(targetPath || '', item.name), true, req, { source: sourceFullPath, target: targetFullPath });
      }

      processedItems.push(item.name);
    }

    // Force cache refresh for both source and target directories
    if (targetContext.fileSystem.cache) {
      try {
        // Refresh target directory
        const targetDir = targetContext.targetPath;
        await refreshDirectoryCache(targetDir, 'refresh_after_paste', req, targetContext.fileSystem);

        // For move operations, refresh every affected source directory in its own Location cache.
        if (operation === 'cut') {
          for (const sourceDirectory of sourceDirectories) {
            if (sourceDirectory.path !== targetDir || sourceDirectory.fileSystem !== targetContext.fileSystem) {
              await refreshDirectoryCache(sourceDirectory.path, 'refresh_after_paste_source', req, sourceDirectory.fileSystem);
            }
          }
        }
      } catch (cacheError) {
        // Non-fatal cache error (not logged)('Cache refresh error (non-fatal):', cacheError.message);
      }
    }

    res.json({
      success: true,
      locationId: targetContext.locationId,
      message: `${processedItems.length} item(s) ${operation === 'copy' ? 'copied' : 'moved'} successfully`,
      processedItems
    });
  } catch (error) {
    systemLogger.logFileOperation(req.body.operation === 'copy' ? 'copy' : 'move', req.body.targetPath || '/', false, req, { error: error.message, items: req.body.items?.map(i => i.name) });
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Archive endpoint - create zip of multiple files/folders
app.post('/api/archive', authenticate, async (req, res) => {
  let archiveFileName = 'archive.zip';
  let items = [];
  try {
    ({ items, currentPath = '' } = req.body);

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items array is required' });
    }

    await getStorageContext(req, currentPath, 'read');
    const resolvedItems = [];
    for (const item of items) {
      if (!item || typeof item.name !== 'string' || item.name.trim() === '') {
        return res.status(400).json({ error: 'Each archive item must have a name' });
      }

      // Search results carry a full relative item.path while directory listings use currentPath.
      // Resolve both forms before validating the storage-root boundary.
      const parentPath = typeof item.path === 'string' && item.path
        ? path.dirname(item.path)
        : currentPath;
      const itemContext = await getStorageContext(req, path.join(parentPath, item.name), 'read');
      resolvedItems.push({ item, itemPath: itemContext.targetPath });
    }

    // Determine archive filename based on selection
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sanitizeName = (name) => name.replace(/[\r\n]/g, '').trim();
    archiveFileName = `archive_${timestamp}.zip`;

    if (items.length === 1) {
      const singleItem = items[0];
      const safeName = sanitizeName(singleItem.name || 'archive');
      const baseName = safeName.replace(/[\\/]/g, '');

      if (singleItem.isDirectory) {
        archiveFileName = `${baseName}.zip`;
      } else {
        archiveFileName = baseName.toLowerCase().endsWith('.zip') ? baseName : `${baseName}.zip`;
      }
    }

    // Validate every source before sending headers so clients receive useful JSON errors.
    for (const { item, itemPath } of resolvedItems) {
      try {
        await fs.stat(itemPath);
      } catch (error) {
        return res.status(error.code === 'ENOENT' ? 404 : 400).json({
          error: `Unable to archive ${item.name}: ${error.code === 'ENOENT' ? 'item not found' : error.message}`
        });
      }
    }

    // Set response headers for zip download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${archiveFileName}"`);

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
      systemLogger.logDownload(archiveFileName, 'archive', false, req, {
        fileCount: items.length,
        error: err.message
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create archive' });
      }
    });

    // Track archive statistics
    let totalArchiveSize = 0;

    // Add each item to the archive
    for (const { item, itemPath } of resolvedItems) {

      try {
        const stats = await fs.stat(itemPath);

        if (stats.isDirectory()) {
          // Add directory recursively
          archive.directory(itemPath, item.name);
          // For directories, we can't easily get total size, so skip counting
        } else {
          // Add single file
          archive.file(itemPath, { name: item.name });
          totalArchiveSize += stats.size;
        }
      } catch (err) {
        systemLogger.logSystem('ERROR', `Failed to add ${item.name} to archive: ${err.message}`);
        // Continue with other items
      }
    }

    // Finalize the archive
    await archive.finalize();

    // Log successful archive download
    systemLogger.logDownload(archiveFileName, 'archive', true, req, {
      fileCount: items.length,
      size: totalArchiveSize
    });

  } catch (error) {
    systemLogger.logDownload(archiveFileName || 'archive.zip', 'archive', false, req, {
      fileCount: items?.length || 0,
      error: error.message
    });
    if (!res.headersSent) {
      res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
    }
  }
});

// Progress tracking routes
app.get('/api/progress/:transferId', authenticate, (req, res) => {
  try {
    const progress = transferManager.getTransfer(req.params.transferId);
    if (!progress) {
      return res.status(404).json({
        success: false,
        error: {
          code: 402,
          message: 'Transfer ID 不存在'
        }
      });
    }
    res.json(progress);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Batch progress tracking route
app.get('/api/progress/batch/:batchId', authenticate, (req, res) => {
  try {
    const { batchId } = req.params;

    // Get batch information
    const batch = transferManager.getBatch(batchId);
    if (!batch) {
      return res.status(404).json({
        success: false,
        error: {
          code: 403,
          message: 'Batch ID 不存在'
        }
      });
    }

    // Calculate batch statistics
    const stats = transferManager.calculateBatchStats(batchId);

    // Return response matching SPEC format
    res.json({
      batchId: batch.batchId,
      status: batch.status,
      totalFiles: stats.totalFiles,
      successCount: stats.successCount,
      failedCount: stats.failedCount,
      pendingCount: stats.pendingCount,
      totalSize: stats.totalSize,
      transferredSize: stats.transferredSize,
      progress: stats.progress,
      files: stats.files
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Batch progress error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: {
        code: 500,
        message: 'Internal server error',
        details: error.message
      }
    });
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

    if (updatedFields.includes('fileSystem.locations')) {
      configureLocationRuntime();
    }

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
    const { username, password, email, role = 'user', permissions, locationPermissions } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const normalizedLocationPermissions = locationPermissionManager.validateMapping(locationPermissions);
    const newUser = await userManager.createUser({
      username,
      password,
      email,
      role,
      permissions,
      locationPermissions: normalizedLocationPermissions
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

app.get('/api/admin/users/:username/locations', requireAdmin, async (req, res) => {
  try {
    const user = req.params.username === (configManager.get('auth.username') || 'admin')
      ? { role: 'admin', username: req.params.username, permissions: ['all'] }
      : await userManager.getUser(req.params.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, username: req.params.username, locationPermissions: locationPermissionManager.getPublicPermissions(user) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/admin/users/:username/locations', requireAdmin, async (req, res) => {
  try {
    const { locationPermissions } = req.body;
    const normalized = locationPermissionManager.validateMapping(locationPermissions);
    const updatedUser = await userManager.updateUser(req.params.username, { locationPermissions: normalized });
    res.json({ success: true, username: req.params.username, user: updatedUser, locationPermissions: normalized });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/admin/users/:username', requireAdmin, async (req, res) => {
  try {
    const { username } = req.params;
    const updates = { ...req.body };
    if (updates.locationPermissions !== undefined) {
      updates.locationPermissions = locationPermissionManager.validateMapping(updates.locationPermissions);
    }
    
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

const ADMIN_CONFIG_SCHEMA = {
  server: {
    port: { type: 'integer', label: 'HTTP port', description: 'Port used by the WebUI and API. Requires a service restart.', example: '9400', requiresRestart: true },
    host: { type: 'string', label: 'Bind address', description: 'Network address where the service listens. Use 0.0.0.0 to listen on all interfaces.', example: '0.0.0.0', requiresRestart: true }
  },
  fileSystem: {
    maxFileSize: { type: 'integer', label: 'Maximum file size (bytes)', description: 'Maximum accepted upload size in bytes.', example: '10737418240', requiresRestart: true }
  },
  locations: {
    definitions: { type: 'locations', label: 'Server Locations', description: 'Server-side roots. Set storageType to nfs for mount presence checks; mount the share first and enter the mounted directory. Changes apply immediately.', example: '[{"id":"team-a","displayName":"Team A","rootPath":"/mnt/nfs/team-a","storageType":"nfs","enabled":true,"readOnly":false,"order":10}]', requiresRestart: false }
  },
  maintenance: {
    tempUploadRetentionDays: { type: 'integer', label: 'Temporary upload retention (days)', description: 'Delete interrupted temporary uploads older than this many days.', example: '7', requiresRestart: false },
    tempUploadCleanupIntervalHours: { type: 'integer', label: 'Temporary upload cleanup interval (hours)', description: 'How often the service scans for expired temporary uploads.', example: '24', requiresRestart: false }
  },
  logging: {
    level: { type: 'enum', label: 'Log level', description: 'DEBUG is verbose and should only be enabled while investigating a problem.', example: 'INFO', options: ['DEBUG', 'INFO', 'WARN', 'ERROR'], requiresRestart: false }
  },
  security: {
    enableRateLimit: { type: 'boolean', label: 'Rate limiting', description: 'Limit request frequency to reduce abuse.', requiresRestart: false },
    enableSecurityHeaders: { type: 'boolean', label: 'Security headers', description: 'Send protective HTTP security headers.', requiresRestart: false },
    enableInputValidation: { type: 'boolean', label: 'Input validation', description: 'Validate and sanitize user input.', requiresRestart: false },
    enableFileUploadSecurity: { type: 'boolean', label: 'File upload security', description: 'Apply upload security checks.', requiresRestart: false },
    enableRequestLogging: { type: 'boolean', label: 'Request logging', description: 'Log HTTP requests and responses.', requiresRestart: false },
    enableCSP: { type: 'boolean', label: 'Content Security Policy', description: 'Enable CSP headers to reduce XSS risk.', requiresRestart: false },
    jwtSecret: { type: 'secret', label: 'JWT secret', description: 'Signs login tokens. Changing it invalidates existing tokens and requires a restart.', requiresRestart: true, sensitive: true }
  },
  shareLinks: {
    enabled: { type: 'boolean', label: 'Enable share links', description: 'Allow authenticated users to create public share links.', requiresRestart: false },
    defaultExpiration: { type: 'integer', label: 'Default expiration (seconds)', description: 'Default public-link lifetime. 86400 seconds equals 24 hours.', example: '86400', requiresRestart: false },
    maxExpiration: { type: 'integer', label: 'Maximum expiration (seconds)', description: 'Longest public-link lifetime. Must not be less than the default.', example: '2592000', requiresRestart: false },
    allowPasswordProtection: { type: 'boolean', label: 'Allow password protection', description: 'Allow a share link to require its own password.', requiresRestart: false },
    cleanupInterval: { type: 'integer', label: 'Cleanup interval (seconds)', description: 'How often expired share links are removed.', example: '86400', requiresRestart: false },
    maxDownloadsDefault: { type: 'integer', label: 'Default maximum downloads', description: 'Default download limit. 0 means unlimited.', example: '0', requiresRestart: false }
  },
  ssl: {
    httpsPort: { type: 'integer', label: 'HTTPS port', description: 'HTTPS listener port when certificates are configured. Requires a service restart.', example: '9443', requiresRestart: true },
    enableHttpsRedirect: { type: 'boolean', label: 'Redirect HTTP to HTTPS', description: 'Redirect HTTP requests when HTTPS is available.', requiresRestart: true },
    autoGenerateCerts: { type: 'boolean', label: 'Auto-generate certificates', description: 'Generate local certificates when none are available.', requiresRestart: true }
  },
  auth: {
    username: { type: 'string', label: 'Administrator username', description: 'The single system administrator account. Managed here instead of User Management.', requiresRestart: false },
    password: { type: 'secret', label: 'Administrator password', description: 'Enter a new password to replace the current administrator password. The stored value is bcrypt-hashed.', requiresRestart: false, sensitive: true }
  }
};

const getAdminConfig = () => ({
  server: {
    port: configManager.get('server.port') ?? 9400,
    host: configManager.get('server.host') ?? 'localhost'
  },
  fileSystem: {
    maxFileSize: configManager.get('fileSystem.maxFileSize') ?? 1024 * 1024 * 10000
  },
  locations: locationManager
    ? locationManager.getLocations({ includeDisabled: true }).map(({ id, displayName, rootPath, storageType, enabled, readOnly, order }) => ({ id, displayName, rootPath, storageType, enabled, readOnly, order }))
    : (configManager.get('fileSystem.locations') || []),
  maintenance: {
    tempUploadRetentionDays: configManager.get('maintenance.tempUploadRetentionDays') ?? 7,
    tempUploadCleanupIntervalHours: configManager.get('maintenance.tempUploadCleanupIntervalHours') ?? 24
  },
  logging: {
    level: String(configManager.get('logging.level') ?? 'INFO').toUpperCase()
  },
  security: {
    enableRateLimit: configManager.get('security.enableRateLimit') === true,
    enableSecurityHeaders: configManager.get('security.enableSecurityHeaders') === true,
    enableInputValidation: configManager.get('security.enableInputValidation') === true,
    enableFileUploadSecurity: configManager.get('security.enableFileUploadSecurity') === true,
    enableRequestLogging: configManager.get('security.enableRequestLogging') === true,
    enableCSP: configManager.get('security.enableCSP') === true,
    jwtSecret: configManager.get('security.jwtSecret') ? '[SET]' : '[DEFAULT]'
  },
  shareLinks: {
    enabled: configManager.get('shareLinks.enabled') === true,
    defaultExpiration: configManager.get('shareLinks.defaultExpiration') ?? 86400,
    maxExpiration: configManager.get('shareLinks.maxExpiration') ?? 2592000,
    allowPasswordProtection: configManager.get('shareLinks.allowPasswordProtection') === true,
    cleanupInterval: configManager.get('shareLinks.cleanupInterval') ?? 86400,
    maxDownloadsDefault: configManager.get('shareLinks.maxDownloadsDefault') ?? 0
  },
  ssl: {
    httpsPort: configManager.get('ssl.httpsPort') ?? 9443,
    enableHttpsRedirect: configManager.get('ssl.enableHttpsRedirect') !== false,
    autoGenerateCerts: configManager.get('ssl.autoGenerateCerts') === true
  },
  auth: {
    username: configManager.get('auth.username') ?? 'admin',
    password: configManager.get('auth.password') ? '[SET]' : ''
  }
});

app.get('/api/admin/config/schema', requireAdmin, (req, res) => {
  res.json({ schema: ADMIN_CONFIG_SCHEMA, source: './src/config.ini' });
});

app.get('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const config = getAdminConfig();
    const restartRequiredFields = Object.entries(ADMIN_CONFIG_SCHEMA)
      .flatMap(([section, fields]) => Object.entries(fields)
        .filter(([, metadata]) => metadata.requiresRestart)
        .map(([key]) => `${section}.${key}`));
    res.json({ config, schema: ADMIN_CONFIG_SCHEMA, restartRequiredFields, source: './src/config.ini', success: true });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to fetch config: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch configuration' });
  }
});

app.put('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    const { server, fileSystem, locations, maintenance, logging, security, shareLinks, ssl, auth } = req.body;
    const updatedFields = [];

    const integer = (value, label, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
      }
      return parsed;
    };

    const booleanFields = (section, values, allowed) => {
      if (!values) return;
      for (const key of Object.keys(values)) {
        if (!allowed.includes(key)) throw new Error(`Unknown configuration field: ${section}.${key}`);
        if (typeof values[key] !== 'boolean') throw new Error(`${section}.${key} must be true or false`);
      }
    };

    const pending = [];
    const add = (key, value) => pending.push([key, value]);

    if (auth) {
      if (auth.username !== undefined) {
        if (typeof auth.username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(auth.username.trim())) {
          throw new Error('auth.username must be 3-64 characters and contain only letters, numbers, dot, underscore, or hyphen');
        }
        add('auth.username', auth.username.trim());
        updatedFields.push('auth.username');
      }
      if (auth.password !== undefined && auth.password !== '' && auth.password !== '[SET]') {
        if (typeof auth.password !== 'string' || auth.password.length < 6) {
          throw new Error('auth.password must be at least 6 characters long');
        }
        add('auth.password', await bcrypt.hash(auth.password, 12));
        add('auth.passwordHashed', true);
        updatedFields.push('auth.password', 'auth.passwordHashed');
      }
    }

    // Validate and update server settings
    if (server) {
      if (server.port !== undefined) {
        const port = integer(server.port, 'server.port', 1, 65535);
        add('server.port', port);
        updatedFields.push('server.port');
      }
      if (server.host !== undefined) {
        if (typeof server.host !== 'string' || !server.host.trim()) throw new Error('server.host must be a non-empty string');
        add('server.host', server.host.trim());
        updatedFields.push('server.host');
      }
    }

    // Validate and update file system settings
    if (fileSystem) {
      if (fileSystem.maxFileSize !== undefined) {
        add('fileSystem.maxFileSize', integer(fileSystem.maxFileSize, 'fileSystem.maxFileSize'));
        updatedFields.push('fileSystem.maxFileSize');
      }
    }

    if (locations !== undefined) {
      if (!Array.isArray(locations) || locations.length === 0) throw new Error('locations must be a non-empty array');
      const candidateFileSystem = {
        storagePath: fileSystem?.storagePath ?? configManager.get('fileSystem.storagePath'),
        locations
      };
      new LocationManager({ fileSystem: candidateFileSystem });
      add('fileSystem.locations', locations);
      updatedFields.push('fileSystem.locations');
    }

    if (maintenance) {
      if (maintenance.tempUploadRetentionDays !== undefined) {
        add('maintenance.tempUploadRetentionDays', integer(maintenance.tempUploadRetentionDays, 'maintenance.tempUploadRetentionDays'));
        updatedFields.push('maintenance.tempUploadRetentionDays');
      }
      if (maintenance.tempUploadCleanupIntervalHours !== undefined) {
        add('maintenance.tempUploadCleanupIntervalHours', integer(maintenance.tempUploadCleanupIntervalHours, 'maintenance.tempUploadCleanupIntervalHours'));
        updatedFields.push('maintenance.tempUploadCleanupIntervalHours');
      }
    }

    if (logging) {
      if (!['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(String(logging.level || '').toUpperCase())) throw new Error('logging.level must be DEBUG, INFO, WARN, or ERROR');
      add('logging.level', String(logging.level).toUpperCase());
      updatedFields.push('logging.level');
    }

    // Update security settings
    if (security) {
      const { jwtSecret, ...securityFlags } = security;
      booleanFields('security', securityFlags, ['enableRateLimit', 'enableSecurityHeaders', 'enableInputValidation', 'enableFileUploadSecurity', 'enableRequestLogging', 'enableCSP']);
      for (const key of Object.keys(security)) {
        if (key === 'jwtSecret') {
          if (typeof security[key] !== 'string' || security[key].trim().length < 16) throw new Error('JWT secret must be at least 16 characters long');
          add('security.jwtSecret', security[key].trim());
          updatedFields.push('security.jwtSecret');
        } else {
          add(`security.${key}`, security[key]);
          updatedFields.push(`security.${key}`);
        }
      }
    }

    // Update share links settings
    if (shareLinks) {
      if (shareLinks.defaultExpiration !== undefined) {
        const expiration = integer(shareLinks.defaultExpiration, 'shareLinks.defaultExpiration', 60);
        add('shareLinks.defaultExpiration', expiration);
        updatedFields.push('shareLinks.defaultExpiration');
      }
      if (shareLinks.maxExpiration !== undefined) {
        const maxExpiration = integer(shareLinks.maxExpiration, 'shareLinks.maxExpiration', 60);
        add('shareLinks.maxExpiration', maxExpiration);
        updatedFields.push('shareLinks.maxExpiration');
      }
      if (shareLinks.allowPasswordProtection !== undefined) {
        if (typeof shareLinks.allowPasswordProtection !== 'boolean') throw new Error('shareLinks.allowPasswordProtection must be true or false');
        add('shareLinks.allowPasswordProtection', shareLinks.allowPasswordProtection);
        updatedFields.push('shareLinks.allowPasswordProtection');
      }
      if (shareLinks.enabled !== undefined) {
        if (typeof shareLinks.enabled !== 'boolean') throw new Error('shareLinks.enabled must be true or false');
        add('shareLinks.enabled', shareLinks.enabled);
        updatedFields.push('shareLinks.enabled');
      }
      if (shareLinks.cleanupInterval !== undefined) {
        const interval = integer(shareLinks.cleanupInterval, 'shareLinks.cleanupInterval', 60);
        add('shareLinks.cleanupInterval', interval);
        updatedFields.push('shareLinks.cleanupInterval');
      }
      if (shareLinks.maxDownloadsDefault !== undefined) {
        const maxDownloads = integer(shareLinks.maxDownloadsDefault, 'shareLinks.maxDownloadsDefault', 0);
        add('shareLinks.maxDownloadsDefault', maxDownloads);
        updatedFields.push('shareLinks.maxDownloadsDefault');
      }
    }

    if (ssl) {
      if (ssl.httpsPort !== undefined) {
        add('ssl.httpsPort', integer(ssl.httpsPort, 'ssl.httpsPort', 1, 65535));
        updatedFields.push('ssl.httpsPort');
      }
      const sslFlags = Object.fromEntries(Object.entries({
        enableHttpsRedirect: ssl.enableHttpsRedirect,
        autoGenerateCerts: ssl.autoGenerateCerts
      }).filter(([, value]) => value !== undefined));
      booleanFields('ssl', sslFlags, ['enableHttpsRedirect', 'autoGenerateCerts']);
      for (const key of ['enableHttpsRedirect', 'autoGenerateCerts']) {
        if (ssl[key] !== undefined) {
          add(`ssl.${key}`, ssl[key]);
          updatedFields.push(`ssl.${key}`);
        }
      }
    }

    const defaultExpiration = shareLinks?.defaultExpiration ?? configManager.get('shareLinks.defaultExpiration');
    const maxExpiration = shareLinks?.maxExpiration ?? configManager.get('shareLinks.maxExpiration');
    if (defaultExpiration > maxExpiration) throw new Error('shareLinks.defaultExpiration cannot exceed shareLinks.maxExpiration');

    pending.forEach(([key, value]) => configManager.set(key, value));

    // Save configuration to file
    await configManager.save();

    systemLogger.logSystem('INFO', `Configuration updated by admin: ${req.user?.username}, Updated fields: ${JSON.stringify(updatedFields)}`);

    // Determine restart requirements
    const requiresRestart = field =>
      field.startsWith('server.') ||
      field === 'security.jwtSecret' ||
      (field.startsWith('fileSystem.') && field !== 'fileSystem.locations') ||
      field.startsWith('ssl.');
    const needsRestart = updatedFields.some(requiresRestart);
    const restartRequiredFields = updatedFields.filter(requiresRestart);

    res.json({
      success: true,
      message: needsRestart
        ? 'Configuration updated successfully. Server restart required for some changes to take effect.'
        : 'Configuration updated successfully.',
      updatedFields,
      needsRestart,
      restartRequiredFields
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to update config: ${error.message}`);
    const statusCode = /must be|Unknown configuration|cannot exceed|non-empty|locations|auth\./.test(error.message) ? 400 : 500;
    res.status(statusCode).json({ error: error.message || 'Failed to update configuration' });
  }
});

app.post('/api/admin/config/backup', requireAdmin, async (req, res) => {
  try {
    const backup = {
      timestamp: new Date().toISOString(),
      config: configManager.getAll(),
      createdBy: req.user?.username
    };
    
    // Remove sensitive data from nested configuration sections.
    if (backup.config.auth) {
      delete backup.config.auth.password;
      delete backup.config.auth.passwordHashed;
    }
    if (backup.config.security) delete backup.config.security.jwtSecret;
    
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

// Service restart endpoint
app.post('/api/admin/service/restart', requireAdmin, async (req, res) => {
  try {
    const username = req.user?.username || 'unknown';

    // Try to acquire restart lock
    const lockResult = await pidManager.acquireLock(username, 'web');

    if (!lockResult.success) {
      systemLogger.logSystem('WARN', `Restart blocked - lock held by ${lockResult.lockData?.initiator} (${lockResult.lockData?.method})`);
      return res.status(409).json({
        error: lockResult.message,
        details: {
          locked_by: lockResult.lockData?.initiator,
          locked_at: lockResult.lockData?.timestamp,
          method: lockResult.lockData?.method
        }
      });
    }

    systemLogger.logSystem('INFO', `SERVICE RESTART initiated by user: ${username}`);

    // Send response before restarting
    res.json({
      success: true,
      message: '服務重啟已啟動，請稍候...'
    });

    // Wait a bit to ensure response is sent
    setTimeout(async () => {
      try {
        systemLogger.logSystem('INFO', 'Starting graceful restart...');
        console.log('\n🔄 Service restart requested by admin...');

        // Close servers gracefully
        if (httpsServerInstance) {
          await new Promise((resolve) => {
            httpsServerInstance.close(() => {
              console.log('✅ HTTPS server stopped');
              resolve();
            });
          });
        }

        if (httpServerInstance) {
          await new Promise((resolve) => {
            httpServerInstance.close(() => {
              console.log('✅ HTTP server stopped');
              resolve();
            });
          });
        }

        // Close file system
        if (fileSystem && fileSystem.close) {
          await fileSystem.close();
          console.log('✅ File system closed');
        }

        systemLogger.logSystem('INFO', 'Graceful restart completed, restarting process...');

        // Restart the process
        const { spawn} = require('child_process');
        const child = spawn(process.argv[0], process.argv.slice(1), {
          detached: true,
          stdio: 'inherit',
          cwd: process.cwd(),
          env: process.env
        });

        child.unref();

        // Exit current process
        console.log('🚀 New process started, exiting old process...');
        process.exit(0);
      } catch (error) {
        systemLogger.logSystem('ERROR', `Restart failed: ${error.message}`);
        console.error('❌ Restart failed:', error);
        // Release lock on failure
        await pidManager.releaseLock();
      }
    }, 500);
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to initiate restart: ${error.message}`);
    await pidManager.releaseLock();
    res.status(500).json({ error: '服務重啟失敗，請檢查日誌' });
  }
});


/**
 * Check if SSL certificates exist and are valid
 * @returns {Object} { exist: boolean, ca: boolean, server: boolean }
 */
async function checkSSLCertificates() {
  try {
    const exists = await certificateManager.certificatesExist();
    return {
      exist: exists.ca && exists.server,
      ca: exists.ca,
      server: exists.server
    };
  } catch (error) {
    return { exist: false, ca: false, server: false };
  }
}

/**
 * Load SSL certificates and create HTTPS options
 * @returns {Object|null} HTTPS options or null if certificates don't exist
 */
async function loadSSLCertificates() {
  try {
    const certStatus = await checkSSLCertificates();
    if (!certStatus.exist) {
      return null;
    }

    const certPath = certificateManager.serverCertPath;
    const keyPath = certificateManager.serverKeyPath;

    const cert = await fs.readFile(certPath, 'utf8');
    const key = await fs.readFile(keyPath, 'utf8');

    return {
      key: key,
      cert: cert
    };
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to load SSL certificates: ${error.message}`);
    return null;
  }
}

/**
 * HTTP to HTTPS redirect middleware
 */
function httpsRedirectMiddleware(httpsPort) {
  return (req, res, next) => {
    // Skip redirect for certain paths (e.g., health checks)
    if (req.path === '/health') {
      return next();
    }

    const httpsUrl = `https://${req.hostname}:${httpsPort}${req.url}`;
    res.redirect(301, httpsUrl);
  };
}

// Start server with configuration
async function startServer() {
  try {
    // Load configuration first
    await configManager.load();
    systemLogger.setLogLevel(configManager.get('logging.level'));

    // Initialize database
    await database.initialize();
    systemLogger.logSystem('INFO', 'Database initialized successfully');

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

    const tempUploadRetentionDays = configManager.get('maintenance.tempUploadRetentionDays');
    const tempUploadCleanupIntervalHours = configManager.get('maintenance.tempUploadCleanupIntervalHours');
    const runTempUploadCleanup = async () => {
      try {
        await uploadApi.cleanupTempUploads(tempUploadRetentionDays);
      } catch (error) {
        // The cleanup method records the detailed failure; keep startup available.
      }
    };

    await runTempUploadCleanup();
    tempUploadCleanupInterval = setInterval(runTempUploadCleanup, tempUploadCleanupIntervalHours * 60 * 60 * 1000);
    systemLogger.logSystem('INFO', `TEMP UPLOAD CLEANUP SCHEDULER - RetentionDays: ${tempUploadRetentionDays}, IntervalHours: ${tempUploadCleanupIntervalHours}`);

    // Initialize enhanced file system with in-memory cache
    fileSystem = new EnhancedMemoryFileSystem(storagePath);
    configureLocationRuntime();
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
    const httpsPort = configManager.get('ssl.httpsPort') || 9443;
    const enableHttpsRedirect = configManager.get('ssl.enableHttpsRedirect') !== false; // Default true

    console.log('Configuration loaded:');
    console.log('- HTTP Port:', port);
    console.log('- Username:', configManager.get('auth.username'));
    console.log('- Storage Path:', storagePath);
    console.log('- Server Timeout: 10 hours (for large file transfers)');

    // Log cache information
    const cacheInfo = await fileSystem.getCacheInfo();
    console.log('- Cache Status:', cacheInfo.initialized ? 'Active' : 'Inactive');
    if (cacheInfo.initialized) {
      console.log(`- Cached Files: ${cacheInfo.totalFiles}`);
      console.log(`- Cached Directories: ${cacheInfo.totalDirectories}`);
      console.log(`- File Watcher: ${cacheInfo.isWatching ? 'Active' : 'Inactive'}`);
    }

    // Check for SSL certificates
    const sslOptions = await loadSSLCertificates();
    let httpsServer = null;

    if (sslOptions) {
      console.log('- SSL Status: Enabled');
      console.log('- HTTPS Port:', httpsPort);
      console.log('- HTTPS Redirect:', enableHttpsRedirect ? 'Enabled' : 'Disabled');

      // Get certificate expiration dates
      const caExpiration = await certificateManager.getCertificateExpiration(certificateManager.caCertPath);
      const serverExpiration = await certificateManager.getCertificateExpiration(certificateManager.serverCertPath);

      if (caExpiration) {
        const daysUntilExpiry = Math.floor((caExpiration - new Date()) / (1000 * 60 * 60 * 24));
        console.log(`- CA Certificate Expires: ${caExpiration.toLocaleDateString()} (${daysUntilExpiry} days)`);
      }
      if (serverExpiration) {
        const daysUntilExpiry = Math.floor((serverExpiration - new Date()) / (1000 * 60 * 60 * 24));
        console.log(`- Server Certificate Expires: ${serverExpiration.toLocaleDateString()} (${daysUntilExpiry} days)`);

        // Warn if expiring soon
        if (certificateManager.isExpiringSoon(serverExpiration, 90)) {
          console.log('  ⚠️  WARNING: Certificate expires within 90 days!');
        }
        if (certificateManager.isExpired(serverExpiration)) {
          console.log('  ❌ ERROR: Certificate has expired!');
        }
      }

      // Create HTTPS server
      try {
        httpsServer = https.createServer(sslOptions, app);
        httpsServerInstance = httpsServer; // Store for graceful shutdown

        // Increase timeout for large file transfers (10 hours = 36000000ms)
        // This prevents connection timeout during large file uploads/downloads
        httpsServer.timeout = 36000000; // 10 hours
        httpsServer.keepAliveTimeout = 36000000; // 10 hours
        httpsServer.headersTimeout = 36000000; // 10 hours

        httpsServer.listen(httpsPort, () => {
          systemLogger.logSystem('INFO', `HTTPS server started on port ${httpsPort}`);
          systemLogger.logSystem('INFO', `HTTPS timeout set to ${httpsServer.timeout / 1000 / 60} minutes for large file transfers`);
        });
      } catch (error) {
        systemLogger.logSystem('ERROR', `Failed to start HTTPS server: ${error.message}`);
        console.log('  ❌ Failed to start HTTPS server, continuing with HTTP only');
      }
    } else {
      console.log('- SSL Status: Disabled (no certificates found)');
      console.log('  💡 Generate certificates in Admin Panel to enable HTTPS');
    }

    // Create HTTP server (with redirect middleware if HTTPS is enabled and redirect is requested)
    let httpApp = app;
    if (httpsServer && enableHttpsRedirect) {
      // Create a separate Express app for HTTP with redirect middleware
      const httpRedirectApp = express();
      httpRedirectApp.use(httpsRedirectMiddleware(httpsPort));
      httpApp = httpRedirectApp;
    }

    const httpServer = http.createServer(httpApp);
    httpServerInstance = httpServer; // Store for graceful shutdown

    // Increase timeout for large file transfers (10 hours = 36000000ms)
    // This prevents connection timeout during large file uploads/downloads
    httpServer.timeout = 36000000; // 10 hours
    httpServer.keepAliveTimeout = 36000000; // 10 hours
    httpServer.headersTimeout = 36000000; // 10 hours

    httpServer.listen(port, async () => {
      console.log(`\n🌐 File Transfer API is now running!`);
      console.log('='.repeat(50));

      // Show all available access URLs
      const networkInterfaces = getNetworkInterfaces();
      console.log('📡 Available access URLs:');

      // HTTP URLs
      console.log('\n  HTTP:');
      console.log(`   🏠 Local:     http://localhost:${port}`);
      console.log(`   🏠 Local:     http://127.0.0.1:${port}`);

      if (networkInterfaces.length > 0) {
        networkInterfaces.forEach(iface => {
          console.log(`   🌍 Network:   http://${iface.address}:${port} (${iface.name})`);
        });
      } else {
        console.log('   ⚠️  No external network interfaces found');
      }

      // HTTPS URLs (if SSL is enabled)
      if (httpsServer) {
        console.log('\n  HTTPS:');
        console.log(`   🔒 Local:     https://localhost:${httpsPort}`);
        console.log(`   🔒 Local:     https://127.0.0.1:${httpsPort}`);

        if (networkInterfaces.length > 0) {
          networkInterfaces.forEach(iface => {
            console.log(`   🔒 Network:   https://${iface.address}:${httpsPort} (${iface.name})`);
          });
        }

        if (enableHttpsRedirect) {
          console.log('\n  ℹ️  HTTP requests will be redirected to HTTPS');
        }
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

      if (httpsServer) {
        accessUrls.push(`https://localhost:${httpsPort}`, `https://127.0.0.1:${httpsPort}`);
        networkInterfaces.forEach(iface => {
          accessUrls.push(`https://${iface.address}:${httpsPort}`);
        });
        systemLogger.logSystem('INFO', `Server started successfully. HTTP port: ${port}, HTTPS port: ${httpsPort}. Access URLs: ${accessUrls.join(', ')}`);
      } else {
        systemLogger.logSystem('INFO', `Server started successfully on port ${port}. Access URLs: ${accessUrls.join(', ')}`);
      }

      // Write PID and release lock after successful startup
      await pidManager.writePID(process.pid);
      await pidManager.releaseLock();
      console.log(`✅ PID ${process.pid} written to server.pid, lock released`);

      // Schedule cleanup job for share links (runs daily at 3 AM)
      const scheduleCleanup = () => {
        const now = new Date();
        const night = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate() + 1, // next day
          3, // 3 AM
          0,
          0
        );
        const msToMidnight = night.getTime() - now.getTime();

        setTimeout(async () => {
          try {
            const deleted = await shareManager.cleanupExpiredLinks();
            systemLogger.logSystem('INFO', `Share links cleanup completed. Deleted ${deleted} expired links.`);
          } catch (error) {
            systemLogger.logSystem('ERROR', `Share links cleanup failed: ${error.message}`);
          }
          // Schedule next cleanup
          scheduleCleanup();
        }, msToMidnight);
      };

      // Start cleanup scheduler
      scheduleCleanup();
      systemLogger.logSystem('INFO', 'Share links cleanup scheduler started (runs daily at 3 AM)');
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to start server: ${error.message}`);
    process.exit(1);
  }
}

// Global error handlers to prevent silent crashes
process.on('uncaughtException', (error) => {
  systemLogger.logSystem('ERROR', `❌ UNCAUGHT EXCEPTION: ${error.message}`);
  systemLogger.logSystem('ERROR', `Stack trace: ${error.stack}`);
  console.error('\n❌ UNCAUGHT EXCEPTION:', error);
  console.error('Stack trace:', error.stack);
  // Don't exit immediately, log the error and continue
});

process.on('unhandledRejection', (reason, promise) => {
  systemLogger.logSystem('ERROR', `❌ UNHANDLED REJECTION at: ${promise}`);
  systemLogger.logSystem('ERROR', `Reason: ${reason}`);
  console.error('\n❌ UNHANDLED REJECTION at:', promise);
  console.error('Reason:', reason);
  // Don't exit immediately, log the error and continue
});

// Graceful shutdown handling
process.on('SIGINT', async () => {
  systemLogger.logSystem('INFO', 'Received SIGINT, shutting down gracefully...');
  console.log('\n🛑 Received SIGINT, shutting down gracefully...');
  await gracefulShutdown();
});

process.on('SIGTERM', async () => {
  systemLogger.logSystem('INFO', 'Received SIGTERM, shutting down gracefully...');
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  await gracefulShutdown();
});

async function gracefulShutdown() {
  try {
    systemLogger.logSystem('INFO', 'Starting graceful shutdown...');
    console.log('Closing servers...');

    if (tempUploadCleanupInterval) {
      clearInterval(tempUploadCleanupInterval);
      tempUploadCleanupInterval = null;
    }

    // Close HTTP server
    if (httpServerInstance) {
      await new Promise((resolve) => {
        httpServerInstance.close(() => {
          console.log('✅ HTTP server closed');
          resolve();
        });
      });
    }

    // Close HTTPS server
    if (httpsServerInstance) {
      await new Promise((resolve) => {
        httpsServerInstance.close(() => {
          console.log('✅ HTTPS server closed');
          resolve();
        });
      });
    }

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
