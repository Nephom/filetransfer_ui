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
const { LocationManager, LocationPermissionManager, CAPABILITIES } = require('./location');
const AuthManager = require('./auth');
const userManager = require('./auth/user-manager');
const RoleManager = require('./auth/role-manager');
const UploadAPI = require('./api/upload.js');
const shareRoutes = require('./api/share');
const sslRoutes = require('./api/ssl');
const database = require('./database/db');
const shareManager = require('./auth/share-manager');
const bulkUserJobManager = require('./auth/bulk-user-job');
const { transferManager } = require('./transfer');
const transferProgress = require('./transfer/progress');
const { authenticate, setJwtSecret, requireAdmin, requireStaffRole, resolveCurrentAccount } = require('./middleware/auth');
const { initializeSecurity } = require('./middleware/security');
const { createLogger, systemLogger } = require('./utils/logger');
const certificateManager = require('./ssl/certificate-manager');
const sanManager = require('./ssl/san-manager');
const pidManager = require('./utils/pid-manager');
const { modifiedTimestamp, normalizeSort, sortFiles } = require('./utils/file-sorting');
const { archiveFilename, contentDisposition } = require('./utils/archive-filename');
const { getVersion } = require('../../scripts/version');
const { clearSessionCookie, getSessionToken, setSessionCookie } = require('./auth/session-cookie');
const { withOperationLocks } = require('./file-system/operation-locks');
const { assertSafeTree, assertTransferPaths } = require('./file-system/path-safety');
const { publicDirectory, checkBrowserBuild } = require('../../scripts/build-browser');



// User manager is a shared singleton (see auth/user-manager.js) so
// middleware/auth.js can re-check a caller's current role/active status on
// every admin/superuser-gated request without a circular require.

// Initialize role manager (named, reusable per-Location permission matrices)
const roleManager = new RoleManager();

// Initialize app
const app = express();

// These will be initialized after config is loaded
let authManager;
let locationManager;
let locationPermissionManager;
const locationFileSystems = new Map();
const initializingFileSystems = new Map();
const storageRequests = new Set();
let runtimeChanging = false;
let configurationWrites = Promise.resolve();
const configurationChange = handler => (req, res, next) => {
  const job = configurationWrites.then(() => handler(req, res));
  configurationWrites = job.catch(() => {});
  job.catch(next);
};

const getLocationFileSystem = async (location) => {
  if (locationFileSystems.has(location.id)) return locationFileSystems.get(location.id);
  if (!initializingFileSystems.has(location.id)) {
    const instance = new EnhancedMemoryFileSystem(location.rootPath, { locationId: location.id });
    const initializing = instance.initialize().then(() => {
      locationFileSystems.set(location.id, instance);
      return instance;
    }).catch(async (error) => {
      await instance.close().catch(() => {});
      throw error;
    }).finally(() => initializingFileSystems.delete(location.id));
    initializingFileSystems.set(location.id, initializing);
  }
  return initializingFileSystems.get(location.id);
};

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
const itemRelativePath = (item, currentPath = '') => {
  if (!item || typeof item.name !== 'string' || !item.name || /[\\/\x00-\x1f]/.test(item.name) || ['.', '..'].includes(item.name)) {
    throw Object.assign(new Error('Each item requires a basename'), { statusCode: 400 });
  }
  if (typeof currentPath !== 'string' || (item.path !== undefined && (typeof item.path !== 'string' || !item.path))) {
    throw Object.assign(new Error('Invalid item path'), { statusCode: 400 });
  }
  const value = (item.path === undefined ? path.posix.join(currentPath, item.name) : item.path).replace(/\\/g, '/');
  if (value.startsWith('/') || /^[a-z]:/i.test(value) || value.split('/').includes('..') || path.posix.basename(value) !== item.name) {
    throw Object.assign(new Error('Item path must match its name inside the Location'), { statusCode: 400 });
  }
  return value;
};

// Pass capability=null for authenticated infrastructure operations (such as
// cache/index maintenance) that are not file permission operations.
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
  const headerLocationId = getRequestedLocationId(req) || (locationManager.getLocation('default') ? 'default' : null);
  const targetLocationId = req.body?.targetLocationId || req.body?.destinationLocationId || headerLocationId;
  const revisions = [
    headerLocationId === locationId ? req.headers['x-location-revision'] : undefined,
    (req.body?.sourceLocationId || headerLocationId) === locationId ? req.body?.sourceLocationRevision : undefined,
    targetLocationId === locationId ? req.body?.targetLocationRevision : undefined
  ].filter(value => value !== undefined);
  if (revisions.some(value => value !== locationManager.getRevision(locationId))) {
    throw Object.assign(new Error('Location changed; refresh before retrying'), { statusCode: 409 });
  }
  if (capability && !locationPermissionManager) {
    throw Object.assign(new Error('Location permission service is not ready'), { statusCode: 503 });
  }
  if (capability) await locationPermissionManager.assertCurrent(req.user, locationId, capability);
  const health = await locationManager.getHealth(locationId);
  if (health.status !== 'online') {
    throw Object.assign(new Error('Location storage is unavailable'), {
      statusCode: 503,
      storageCode: health.status
    });
  }

  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || /[\x00-\x1f]/.test(relativePath)) {
    throw Object.assign(new Error('A Location-relative path is required'), { statusCode: 400 });
  }
  const rootPath = await locationManager.resolveCheckedPath(locationId, '', { allowMissing: false });
  const targetPath = await locationManager.resolveCheckedPath(locationId, relativePath, { allowMissing: true });
  const locationFileSystem = await getLocationFileSystem(location);

  return {
    locationId,
    location,
    rootPath,
    targetPath,
    fileSystem: locationFileSystem
  };
};

const refreshDirectoryCache = async (directoryPath, operation, req, targetFileSystem = null) => {
  if (!targetFileSystem?.cache) return;
  if (targetFileSystem.cache.refreshDirectory) {
    await targetFileSystem.cache.refreshDirectory(directoryPath);
  } else if (targetFileSystem.cache.scanDirectory) {
    await targetFileSystem.cache.scanDirectory(directoryPath);
  }
  systemLogger.logCacheOperation(operation, { path: directoryPath }, req);
};
let securityMiddleware;
const refreshSecurity = () => { securityMiddleware = initializeSecurity(configManager); };
let isCacheReady = false;
const userActiveDirectories = new Map(); // Track active directory per user
let httpServerInstance = null;
let httpsServerInstance = null;
let tempUploadCleanupInterval = null;
const browserHandoffs = new Map();
const scheduleTempCleanup = () => {
  if (tempUploadCleanupInterval) clearInterval(tempUploadCleanupInterval);
  tempUploadCleanupInterval = setInterval(() => {
    uploadApi.cleanupTempUploads(configManager.get('maintenance.tempUploadRetentionDays')).catch(() => {});
  }, configManager.get('maintenance.tempUploadCleanupIntervalHours') * 60 * 60 * 1000);
  tempUploadCleanupInterval.unref?.();
};
const resetTokenClient = async () => {
  if (runtimeChanging) throw Object.assign(new Error('Storage configuration is changing'), { statusCode: 503 });
  const location = locationManager?.getLocations({ includeDisabled: false }).find(item => item.id === 'default')
    || locationManager?.getLocations({ includeDisabled: false })[0];
  return location ? (await getLocationFileSystem(location)).cache.redisClient : null;
};

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
for (const name of ['securityHeaders', 'requestLogger']) {
  app.use((req, res, next) => securityMiddleware ? securityMiddleware[name](req, res, next) : next());
}
app.use(cors({
  credentials: true,
  origin: true,
  exposedHeaders: ['Authorization'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Location-ID', 'X-Location-Revision', 'X-Upload-Batch-ID']
}));
// Increase JSON body limit to 100MB for large file metadata
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use((req, res, next) => securityMiddleware ? securityMiddleware.validateInput(req, res, next) : next());
app.use((req, res, next) => {
  if (securityMiddleware && /^\/api\/(?:files|upload|folders|archive)(?:\/|$)/.test(req.path)) {
    return securityMiddleware.fileLimiter(req, res, next);
  }
  next();
});
app.use((req, res, next) => {
  if (!/^\/api\/(?:files|upload|folders|archive|locations)(?:\/|$)/.test(req.path)) return next();
  if (runtimeChanging) return res.status(503).json({ error: 'Storage configuration is changing; retry shortly' });
  let release;
  const settled = new Promise(resolve => { release = resolve; });
  storageRequests.add(settled);
  const done = () => { storageRequests.delete(settled); release(); };
  res.once('finish', done);
  res.once('close', done);
  next();
});
app.use(express.static(publicDirectory, {
  setHeaders: (response, filePath) => {
    response.setHeader('Cache-Control', /\.(?:js|css)$/.test(filePath)
      ? 'public, max-age=31536000, immutable' : 'no-store');
  }
}));

// Use the UploadAPI router for all upload endpoints
const uploadApi = new UploadAPI();
app.use('/api', uploadApi.getRouter());

const configureLocationRuntime = async () => {
  if (runtimeChanging) throw Object.assign(new Error('Storage reconfiguration is already in progress'), { statusCode: 409 });
  const nextManager = new LocationManager(configManager.getConfig());
  runtimeChanging = true;
  try {
  await Promise.all([...storageRequests]);
  await uploadApi.waitForIdle();
  await Promise.allSettled([...initializingFileSystems.values()]);
  await Promise.all([...locationFileSystems.values()].map(instance => instance.close()));
  locationFileSystems.clear();
  userActiveDirectories.clear();

  locationManager = nextManager;
  locationPermissionManager = new LocationPermissionManager(locationManager);
  locationPermissionManager.setAccountResolver(resolveCurrentAccount);
  locationPermissionManager.setUserResolver((username) => userManager.getUser(username));
  locationPermissionManager.setRoleResolver((roleId) => roleManager.getRole(roleId));
  roleManager.setLocationPermissionManager(locationPermissionManager);
  shareRoutes.setLocationPermissionManager?.(locationPermissionManager);

  uploadApi.setCache(null);
  uploadApi.setLocationManager(locationManager, async (locationId) => {
    const location = locationManager.getLocation(locationId);
    if (!location) return null;
    const targetFileSystem = await getLocationFileSystem(location);
    return targetFileSystem.cache;
  }, locationPermissionManager);
  isCacheReady = true;
  } finally {
    runtimeChanging = false;
  }
};

// Share routes - /api/share/:token/download does NOT require authentication
// Other share routes require authentication via middleware
app.use('/api', shareRoutes);

// SSL management routes (admin only)
app.use('/api', sslRoutes);

// Routes
//
// Admin / Super Panel shells
// -------------------------------------------------------------------------
// Both pages are plain static shells with no embedded data: every piece of
// real information (users, roles, config, SSL, logs...) is fetched via
// authenticated API calls that are independently re-authorized server-side
// against the account's *current* role (requireAdmin/requireStaffRole, which
// call resolveCurrentAccount), never against a client-decoded JWT claim.
// A Bearer token - not a server session cookie - is what proves who is
// calling, and a plain browser navigation to these URLs carries no such
// token, so the server cannot reject the page *load* itself without
// breaking normal SPA navigation (e.g. reloading /admin after already
// signing in). What we do here to keep these paths from being handed out
// "for free" to anyone who guesses the URL:
//  - The HTML files live outside `frontend/public` (which express.static
//    serves in full), so they are unreachable at any static path/filename
//    and are ONLY reachable through these two explicit routes.
//  - Responses are marked no-store/no-index and disallow framing, so
//    proxies, browser caches, and clickjacking attempts can't reuse or
//    embed a captured response.
//  - Each page's own script calls /auth/verify immediately (which
//    re-resolves the caller's live role/active state) before rendering
//    anything, and redirects away otherwise, so a stale token or one whose
//    role was downgraded/deactivated since it was issued is rejected the
//    same way the underlying admin/staff APIs already are.
const PRIVATE_PAGES_DIR = path.join(__dirname, '../frontend/private');

const sendPrivatePage = (fileName) => (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow'
  });
  res.sendFile(path.join(PRIVATE_PAGES_DIR, fileName));
};

// Admin-only console: system configuration, SSL, cache, service restart,
// server log, plus everything requireStaffRole also allows.
app.get('/admin', sendPrivatePage('admin.html'));

// Superuser console: user (non-admin/superuser) account management and
// Permission Role management only - no config/SSL/cache/log/service
// controls exist on this page at all (not just hidden by CSS).
app.get('/super', sendPrivatePage('super.html'));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDirectory, 'index.html'));
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
        configManager.get('security.jwtSecret'),
        { expiresIn: '24h' }
      );
      setSessionCookie(req, res, token);

      res.json({
        success: true,
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

app.post('/auth/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ success: true });
});

app.post('/auth/browser-handoff', authenticate, requireStaffRole, (req, res) => {
  const authorization = req.get('Authorization');
  const token = getSessionToken(req) || (authorization?.startsWith('Bearer ') ? authorization.slice(7) : null);
  if (!token) return res.status(401).json({ error: 'Authorization token missing' });

  const code = crypto.randomBytes(32).toString('base64url');
  browserHandoffs.set(code, { token, expiresAt: Date.now() + 60_000 });
  res.set('Cache-Control', 'no-store');
  res.json({ url: `/auth/browser-handoff/${code}` });
});

app.get('/auth/browser-handoff/:code', async (req, res) => {
  const handoff = browserHandoffs.get(req.params.code);
  browserHandoffs.delete(req.params.code);
  if (!handoff || handoff.expiresAt < Date.now()) return res.status(410).send('This browser sign-in link has expired.');
  try {
    const decoded = require('jsonwebtoken').verify(handoff.token, configManager.get('security.jwtSecret'));
    const current = await resolveCurrentAccount(decoded);
    if (!current.exists || !current.active || !['admin', 'superuser'].includes(current.role)) {
      return res.status(401).send('This account can no longer open the console.');
    }
  } catch { return res.status(401).send('This browser sign-in session has expired.'); }
  const destination = req.query.destination === '/super' ? '/super' : '/admin';
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  setSessionCookie(req, res, handoff.token);
  res.redirect(303, destination);
});

// Change password endpoint
app.post('/auth/change-password', (req, res, next) => {
  // Apply auth limiter if security middleware is initialized
  if (securityMiddleware && securityMiddleware.authLimiter) {
    securityMiddleware.authLimiter(req, res, next);
  } else {
    next();
  }
}, authenticate, configurationChange(async (req, res) => {
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
      configManager.set('auth.password', hashedPassword);
      configManager.set('auth.passwordHashed', true);
      await configManager.save();
    } else {
      await userManager.changeOwnPassword(req.user.username, currentPassword, newPassword);
    }

    systemLogger.logSystem('INFO', `Password changed successfully for user: ${req.user.username}`);

    clearSessionCookie(req, res);
    res.json({
      success: true,
      message: 'Password changed successfully. Please login again with your new password.'
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Password change error: ${error.message}`);
    res.status(500).json({ error: 'Failed to change password' });
  }
}));

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
    const sessionToken = getSessionToken(req);

    if (!sessionToken && (!authHeader || !authHeader.startsWith('Bearer '))) {
      return res.status(401).json({ error: 'No valid authorization header' });
    }

    const token = sessionToken || authHeader.substring(7);
    const jwt = require('jsonwebtoken');
    const jwtSecret = configManager.get('security.jwtSecret');
    if (!jwtSecret) throw new Error('JWT secret is not configured');

    try {
      const decoded = jwt.verify(token, jwtSecret);

      // Re-resolve the account's *current* role/active state instead of
      // trusting the JWT's role claim, which is frozen at login time for up
      // to 24h. Without this, a user promoted to superuser (or demoted /
      // deactivated) would keep seeing their stale role on every page
      // reload until the old token expired - this is also what backs the
      // account menu's "Standard user" / "Superuser" / "Admin" label and
      // the /admin and /super entry points.
      const current = await resolveCurrentAccount(decoded);
      if (!current.exists || !current.active) {
        return res.status(401).json({ error: 'Account no longer exists or is inactive' });
      }

      // Return user information without sensitive data
      res.json({
        success: true,
        user: {
          id: decoded.id,
          username: decoded.username,
          role: current.role
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
    const redisClient = await resetTokenClient();
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
    const redisClient = await resetTokenClient();
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

    const context = await getStorageContext(req, '', 'list');

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

    const context = await getStorageContext(req, '', 'list');

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
    const context = await getStorageContext(req, '', null);
    const stats = await context.fileSystem.getCacheInfo ? await context.fileSystem.getCacheInfo() : { message: 'Cache stats not available' };
    const { storagePath: _privatePath, ...publicStats } = stats;
    res.json({ ...publicStats, locationId: context.locationId });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Cache stats error: ${error.message}`);
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Index status endpoint - shows global search index status
app.get('/api/files/index-status', authenticate, async (req, res) => {
  try {
    const context = await getStorageContext(req, '', null);
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

// Trigger manual index rebuild endpoint for authenticated infrastructure use.
app.post('/api/files/rebuild-index', authenticate, async (req, res) => {
  try {
    const context = await getStorageContext(req, '', null);
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
    const currentUser = req.user;
    const locations = await Promise.all(locationPermissionManager.getAccessibleLocations(currentUser).map(async (location) => {
      const health = await locationManager.getHealth(location.id);
      return { ...location, revision: locationManager.getRevision(location.id), status: health.status, errorCode: health.errorCode };
    }));
    res.json({ success: true, locations });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

app.post('/api/files/refresh-cache', authenticate, async (req, res) => {
  try {
    const { directoryPath } = req.body; // Allow partial refresh
    const context = await getStorageContext(req, directoryPath || '', null);

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

    if (res.destroyed) return;
    const fileStream = fsSync.createReadStream(fullPath, { flags: fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW });
    res.once('close', () => fileStream.destroy());
    systemLogger.logSystem('INFO', `DOWNLOAD STREAM OPEN - User: ${userName}, File: ${fileName}`);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      streamFailed = true;
      systemLogger.logSystem('ERROR', `DOWNLOAD STREAM FAILED - User: ${userName}, File: ${fileName}, Error: ${error.message}`);
      systemLogger.logDownload(fileName, 'authenticated', false, req, { error: error.message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download file' });
      } else res.destroy(error);
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
    const { path: requestPath, offset, limit, sort, order, directoriesFirst } = req.query;
    const hasPagination = offset !== undefined || limit !== undefined;
    const normalizedSort = normalizeSort(sort, order, directoriesFirst);
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

    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Request timeout')), 30000);
      timeout.unref?.();
    });

    // Fetch the complete directory before sorting so pagination cannot cut the
    // result set in the wrong order. The cache already stores full directories;
    // slicing is performed below after the shared comparator runs.
    const listOptions = {};
    const rawFiles = await Promise.race([
      locationFileSystem.list(targetPath, listOptions),
      timeoutPromise
    ]).finally(() => clearTimeout(timeout));

    const rawList = rawFiles && rawFiles.files !== undefined ? rawFiles.files : rawFiles;
    const transformedAllFiles = rawList.map(file => {
      const relativePath = path.relative(storageRoot, file.path);
      return {
        ...file,
        name: path.basename(file.path),
        path: relativePath,
        isDirectory: file.isDirectory === 'true' || file.isDirectory === true,
        size: Number(file.size) || 0,
        modified: modifiedTimestamp(file.modified)
      };
    });
    const sortedFiles = sortFiles(transformedAllFiles, normalizedSort.sort, normalizedSort.order, normalizedSort.directoriesFirst);
    let transformedFiles = sortedFiles;
    let paginationInfo;
    if (hasPagination) {
      const requestedOffset = Math.max(0, parseInt(offset) || 0);
      const requestedLimit = parseInt(limit);
      const effectiveLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : sortedFiles.length;
      transformedFiles = sortedFiles.slice(requestedOffset, requestedOffset + effectiveLimit);
      paginationInfo = {
        total: sortedFiles.length,
        offset: requestedOffset,
        limit: effectiveLimit,
        hasMore: requestedOffset + effectiveLimit < sortedFiles.length
      };
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

    if (typeof folderName !== 'string' || !folderName.trim()) {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    const relativePath = itemRelativePath({ name: folderName.trim() }, currentPath ?? '');
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
    const { items, currentPath = '' } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Items array is required' });
    }
    const paths = [...new Set(items.map(item => itemRelativePath(item, currentPath)))];
    const contexts = await Promise.all(paths.map(value => getStorageContext(req, value, 'delete')));
    for (const context of contexts) {
      if (context.targetPath === context.rootPath) throw Object.assign(new Error('Cannot delete a Location root'), { statusCode: 403 });
    }
    const targets = contexts.filter(context => !contexts.some(parent => parent !== context && context.targetPath.startsWith(parent.targetPath + path.sep)));
    const results = [];
    const deletedItems = [];
    await withOperationLocks(targets.map(context => context.targetPath), async () => {
      for (const context of targets) await assertSafeTree(context.targetPath);
      for (const context of targets) {
        const covered = contexts.filter(item => item.targetPath === context.targetPath || item.targetPath.startsWith(context.targetPath + path.sep));
        try {
          await context.fileSystem.delete(context.targetPath);
          for (const item of covered) {
            const relative = path.relative(item.rootPath, item.targetPath);
            results.push({ path: relative, success: true });
            deletedItems.push(path.basename(item.targetPath));
          }
        } catch (error) {
          for (const item of covered) results.push({ path: path.relative(item.rootPath, item.targetPath), success: false, error: publicErrorMessage(error) });
        }
      }
    });
    for (const context of targets) await refreshDirectoryCache(path.dirname(context.targetPath), 'refresh_after_delete', req, context.fileSystem).catch(() => {});
    const success = results.every(item => item.success);
    res.status(success ? 200 : 207).json({
      success,
      message: `${deletedItems.length} item(s) deleted successfully`,
      deletedItems, deletedCount: deletedItems.length, results,
      locationId: contexts[0].locationId
    });
  } catch (error) {
    systemLogger.logFileOperation('delete', req.body.currentPath || '/', false, req, {
      error: error.message, items: Array.isArray(req.body.items) ? req.body.items.map(item => item?.name) : undefined
    });
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Rename file or folder (specific route - must be before wildcard)
app.put('/api/files/rename', authenticate, async (req, res) => {
  try {
    const { oldName, oldPath, newName, currentPath = '' } = req.body;
    if ((!oldName && !oldPath) || (oldPath !== undefined && typeof oldPath !== 'string') || typeof newName !== 'string' || !newName) {
      return res.status(400).json({ error: 'Both old and new names are required' });
    }
    const source = itemRelativePath({ name: oldName || path.posix.basename(oldPath), path: oldPath }, currentPath);
    const destination = itemRelativePath({ name: newName }, path.posix.dirname(source));
    const oldContext = await getStorageContext(req, source, 'rename');
    const newContext = await getStorageContext(req, destination, 'rename');

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

    systemLogger.logFileOperation('rename', source, true, req, { newName, oldName });
    res.json({ success: true, locationId: oldContext.locationId, oldPath: source, path: destination, message: 'Item renamed successfully' });
  } catch (error) {
    systemLogger.logFileOperation('rename', req.body.oldPath || req.body.oldName || '', false, req, { error: error.message });
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Create new file (specific route - must be before wildcard)
app.post('/api/files/create', authenticate, async (req, res) => {
  try {
    const { fileName, currentPath, content = '' } = req.body;

    if (typeof fileName !== 'string' || !fileName.trim() || typeof content !== 'string') {
      return res.status(400).json({ error: 'File name is required' });
    }

    const relativePath = itemRelativePath({ name: fileName.trim() }, currentPath ?? '');
    const context = await getStorageContext(req, relativePath, 'write');

    await context.fileSystem.write(context.targetPath, content);

    await refreshDirectoryCache(path.dirname(context.targetPath), 'refresh_after_create', req, context.fileSystem);

    systemLogger.logFileOperation('create', relativePath, true, req, { fileName, size: Buffer.byteLength(content) });
    res.json({ success: true, locationId: context.locationId, message: 'File created successfully' });
  } catch (error) {
    systemLogger.logFileOperation('create', typeof req.body.currentPath === 'string' ? req.body.currentPath : '', false, req, { error: error.message });
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

// Copy/Move/Paste operations (specific routes - must be before wildcard)
const preflightStorageTransfer = async (sourceContext, destinationContext, moving) => {
  if ((moving && sourceContext.targetPath === sourceContext.rootPath) || destinationContext.targetPath === destinationContext.rootPath) {
    throw Object.assign(new Error('Cannot mutate a Location root'), { statusCode: 403 });
  }
  await assertTransferPaths(sourceContext.targetPath, destinationContext.targetPath);
  const sourceEntries = await assertSafeTree(sourceContext.targetPath);
  let destinationEntries = [];
  try {
    destinationEntries = await assertSafeTree(destinationContext.targetPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const sourceIdentities = new Set(sourceEntries.map(({ stats }) => `${stats.dev}:${stats.ino}`));
  const destinations = new Map(destinationEntries.map(entry => [entry.path, entry.stats]));
  for (const entry of sourceEntries) {
    const target = path.join(destinationContext.targetPath, path.relative(sourceContext.targetPath, entry.path));
    const stats = destinations.get(target);
    if (stats && (sourceIdentities.has(`${stats.dev}:${stats.ino}`) || stats.isDirectory() !== entry.stats.isDirectory())) {
      throw Object.assign(new Error('Destination aliases a source object or has an incompatible type'), { statusCode: 409 });
    }
  }
  return { sourceEntries, destinationEntries };
};

app.post('/api/files/copy', authenticate, async (req, res) => {
  try {
    const { sourcePath, destinationPath, sourceLocationId, targetLocationId, destinationLocationId } = req.body;
    if (typeof sourcePath !== 'string' || typeof destinationPath !== 'string') {
      return res.status(400).json({ success: false, error: 'Source and destination paths are required' });
    }
    const targetId = targetLocationId || destinationLocationId;
    const sourceContext = await getStorageContext(req, sourcePath, 'copy', sourceLocationId);
    const destinationContext = await getStorageContext(req, destinationPath, 'copy', targetId);
    await withOperationLocks([sourceContext.targetPath, destinationContext.targetPath], async () => {
      await preflightStorageTransfer(sourceContext, destinationContext, false);
      await destinationContext.fileSystem.copy(sourceContext.targetPath, destinationContext.targetPath);
      await refreshDirectoryCache(path.dirname(destinationContext.targetPath), 'refresh_after_copy', req, destinationContext.fileSystem).catch(() => {});
    });
    res.json({ success: true, locationId: destinationContext.locationId, sourceLocationId: sourceContext.locationId, targetLocationId: destinationContext.locationId });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: publicErrorMessage(error) });
  }
});

app.post('/api/files/move', authenticate, async (req, res) => {
  let copied = false;
  try {
    const { sourcePath, destinationPath, sourceLocationId, targetLocationId, destinationLocationId } = req.body;
    if (typeof sourcePath !== 'string' || typeof destinationPath !== 'string') {
      return res.status(400).json({ success: false, error: 'Source and destination paths are required' });
    }
    const targetId = targetLocationId || destinationLocationId;
    const sourceContext = await getStorageContext(req, sourcePath, 'move', sourceLocationId);
    const destinationContext = await getStorageContext(req, destinationPath, 'move', targetId);
    await withOperationLocks([sourceContext.targetPath, destinationContext.targetPath], async () => {
      await preflightStorageTransfer(sourceContext, destinationContext, true);
      try {
        if (sourceContext.locationId === destinationContext.locationId) {
          await sourceContext.fileSystem.move(sourceContext.targetPath, destinationContext.targetPath);
        } else {
          await destinationContext.fileSystem.copy(sourceContext.targetPath, destinationContext.targetPath);
          copied = true;
          await sourceContext.fileSystem.delete(sourceContext.targetPath);
        }
      } finally {
        await refreshDirectoryCache(path.dirname(sourceContext.targetPath), 'refresh_after_move_source', req, sourceContext.fileSystem).catch(() => {});
        await refreshDirectoryCache(path.dirname(destinationContext.targetPath), 'refresh_after_move_destination', req, destinationContext.fileSystem).catch(() => {});
      }
    });
    res.json({ success: true, locationId: destinationContext.locationId, sourceLocationId: sourceContext.locationId, targetLocationId: destinationContext.locationId });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, copied, error: publicErrorMessage(error) });
  }
});

// Paste (copy or move) files (specific route - must be before wildcard)
app.post('/api/files/paste', authenticate, async (req, res) => {
  const processedItems = [];
  const results = [];
  try {
    const { items, operation, targetPath, sourceLocationId, targetLocationId, destinationLocationId } = req.body;

    if (!Array.isArray(items) || items.length === 0 || !['copy', 'cut'].includes(operation)) {
      return res.status(400).json({ success: false, error: 'A non-empty items array and copy or cut operation are required', processedItems, results });
    }

    const pasteCapability = operation === 'copy' ? 'copy' : 'move';
    const targetId = targetLocationId || destinationLocationId;
    const targetContext = await getStorageContext(req, targetPath ?? '', pasteCapability, targetId);
    const operands = [];
    for (const item of items) {
      const sourcePath = itemRelativePath(item);
      const destinationPath = itemRelativePath({ name: item.name }, targetPath ?? '');
      const sourceContext = await getStorageContext(req, sourcePath, pasteCapability, item.sourceLocationId || sourceLocationId);
      const destinationContext = await getStorageContext(req, destinationPath, pasteCapability, targetContext.locationId);
      operands.push({ item, sourcePath, destinationPath, sourceContext, destinationContext });
    }

    await withOperationLocks(operands.flatMap(({ sourceContext, destinationContext }) => [sourceContext.targetPath, destinationContext.targetPath]), async () => {
      if (!(await fs.lstat(targetContext.targetPath)).isDirectory()) {
        throw Object.assign(new Error('Paste target must be a directory'), { statusCode: 400 });
      }
      const sourceIdentities = new Set();
      const destinationEntries = [];
      const destinationIdentities = new Map();
      const destinationNames = new Set();
      const sourcePaths = [];
      const treePaths = [];
      for (const { sourceContext, destinationContext } of operands) {
        const destinationName = destinationContext.targetPath.normalize('NFC').toLowerCase();
        if (destinationNames.has(destinationName)) throw Object.assign(new Error('Paste destinations must be distinct'), { statusCode: 409 });
        destinationNames.add(destinationName);
        const manifest = await preflightStorageTransfer(sourceContext, destinationContext, operation === 'cut');
        for (const entry of manifest.sourceEntries) sourceIdentities.add(`${entry.stats.dev}:${entry.stats.ino}`);
        for (const entry of manifest.destinationEntries) {
          const identity = `${entry.stats.dev}:${entry.stats.ino}`;
          if (destinationIdentities.has(identity) && destinationIdentities.get(identity) !== destinationName) {
            throw Object.assign(new Error('Paste destinations alias one another'), { statusCode: 409 });
          }
          destinationIdentities.set(identity, destinationName);
        }
        for (const entry of [...manifest.sourceEntries, ...manifest.destinationEntries]) treePaths.push(entry.path);
        destinationEntries.push(...manifest.destinationEntries);
        sourcePaths.push(sourceContext.targetPath);
      }
      // A later operand must not read a source changed by an earlier operand.
      for (const { destinationContext } of operands) {
        for (const source of sourcePaths) await assertTransferPaths(source, destinationContext.targetPath);
      }
      if (destinationEntries.some(({ stats }) => sourceIdentities.has(`${stats.dev}:${stats.ino}`))) {
        throw Object.assign(new Error('Paste destination aliases a selected source'), { statusCode: 409 });
      }
      if (operation === 'cut') {
        for (let i = 0; i < sourcePaths.length; i++) {
          for (let j = 0; j < i; j++) await assertTransferPaths(sourcePaths[i], sourcePaths[j]);
        }
      }

      await withOperationLocks(treePaths, async () => {
        for (const { item, sourcePath, destinationPath, sourceContext, destinationContext } of operands) {
          let copied = false;
          try {
            if (operation === 'copy' || sourceContext.locationId !== destinationContext.locationId) {
              await destinationContext.fileSystem.copy(sourceContext.targetPath, destinationContext.targetPath);
              copied = true;
              if (operation === 'cut') await sourceContext.fileSystem.delete(sourceContext.targetPath);
            } else {
              await sourceContext.fileSystem.move(sourceContext.targetPath, destinationContext.targetPath);
            }
            processedItems.push(item.name);
            results.push({ name: item.name, path: sourcePath, sourceLocationId: sourceContext.locationId, success: true });
          } catch (error) {
            results.push({ name: item.name, path: sourcePath, sourceLocationId: sourceContext.locationId, success: false, copied, error: publicErrorMessage(error) });
          } finally {
            await refreshDirectoryCache(targetContext.targetPath, 'refresh_after_paste', req, targetContext.fileSystem).catch(() => {});
            if (operation === 'cut') {
              await refreshDirectoryCache(path.dirname(sourceContext.targetPath), 'refresh_after_paste_source', req, sourceContext.fileSystem).catch(() => {});
            }
          }
          systemLogger.logFileOperation(pasteCapability, destinationPath, results[results.length - 1].success, req, {
            source: sourceContext.targetPath, target: destinationContext.targetPath
          });
        }
      });
    });

    const success = results.every(item => item.success);
    res.status(success ? 200 : processedItems.length ? 207 : 500).json({
      success,
      locationId: targetContext.locationId,
      message: `${processedItems.length} item(s) ${operation === 'copy' ? 'copied' : 'moved'} successfully`,
      ...(success ? {} : { error: 'One or more paste items failed' }),
      processedItems,
      results
    });
  } catch (error) {
    systemLogger.logFileOperation(req.body?.operation === 'copy' ? 'copy' : 'move', req.body?.targetPath || '/', false, req, { error: error.message });
    res.status(error.statusCode || (error.code === 'ENOENT' ? 404 : 500)).json({ success: false, error: publicErrorMessage(error), processedItems, results });
  }
});

// Archive endpoint - create zip of multiple files/folders
app.post('/api/archive', authenticate, async (req, res) => {
  let archiveFileName = 'archive.zip';
  let archiveFormat = 'zip';
  let items = [];
  try {
    const { items: requestedItems, currentPath = '', format = 'zip', sessionName = '' } = req.body;
    items = requestedItems;
    archiveFormat = format === 'tar.gz' ? 'tar.gz' : 'zip';

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items array is required' });
    }

    await getStorageContext(req, currentPath, 'read');
    const resolvedItems = [];
    for (const item of items) {
      const itemContext = await getStorageContext(req, itemRelativePath(item, currentPath), 'read');
      resolvedItems.push({ item, itemPath: itemContext.targetPath });
    }

    // WebUI does not provide a Session name; nFterm supplies one only when
    // an archive is being downloaded into its LOCAL pane.
    archiveFileName = archiveFilename(sessionName, archiveFormat);

    const totalArchiveSize = await withOperationLocks(resolvedItems.map(entry => entry.itemPath), async () => {
      const manifest = [];
      const names = new Set();
      for (const { item, itemPath } of resolvedItems) {
        for (const entry of await assertSafeTree(itemPath)) {
          const relative = path.relative(itemPath, entry.path);
          const name = relative ? `${item.name}/${relative.split(path.sep).join('/')}` : item.name;
          // Archive readers treat backslashes and drive prefixes as path syntax.
          if (name.split('/').some(part => /[\\\x00-\x1f]/.test(part) || /^[a-z]:/i.test(part))) {
            throw Object.assign(new Error('Unsafe archive entry name'), { statusCode: 400 });
          }
          if (names.has(name)) throw Object.assign(new Error('Archive entry names must be distinct'), { statusCode: 409 });
          names.add(name);
          manifest.push({ ...entry, name });
        }
      }

      return withOperationLocks(manifest.map(entry => entry.path), async () => {
        if (res.destroyed) throw Object.assign(new Error('Archive request closed'), { statusCode: 409 });
        const archive = archiveFormat === 'tar.gz'
          ? archiver('tar', { gzip: true, gzipOptions: { level: 9 } })
          : archiver('zip', { zlib: { level: 9 } });
        await new Promise((resolve, reject) => {
          let settled = false;
          let sourceStream;
          const fail = (error) => {
            if (settled) return;
            settled = true;
            sourceStream?.destroy();
            archive.unpipe(res);
            archive.abort();
            archive.destroy();
            if (res.headersSent) res.destroy();
            reject(error);
          };
          archive.on('warning', fail);
          archive.on('error', fail);
          res.once('error', fail);
          res.once('close', () => {
            if (!res.writableFinished) fail(new Error('Archive request closed'));
          });
          res.once('finish', () => {
            if (settled) return;
            settled = true;
            resolve();
          });
          const appendEntries = async () => {
            res.setHeader('Content-Type', archiveFormat === 'tar.gz' ? 'application/gzip' : 'application/zip');
            res.setHeader('Content-Disposition', contentDisposition(archiveFileName));
            archive.pipe(res);
            for (const entry of manifest) {
              if (settled) return;
              if (entry.stats.isDirectory()) {
                archive.append(Buffer.alloc(0), { name: `${entry.name}/`, type: 'directory', stats: entry.stats });
              } else {
                // Open one checked file at a time. Keep real Stats for tar sizes.
                sourceStream = fsSync.createReadStream(entry.path, { flags: fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW });
                await new Promise((fileResolve, fileReject) => {
                  sourceStream.once('error', fileReject);
                  sourceStream.once('close', fileResolve);
                  archive.append(sourceStream, { name: entry.name, stats: entry.stats });
                });
              }
            }
            if (!settled) await archive.finalize();
          };
          appendEntries().catch(fail);
        });
        return manifest.reduce((sum, entry) => sum + (entry.stats.isFile() ? entry.stats.size : 0), 0);
      });
    });

    // Log successful archive download
    systemLogger.logDownload(archiveFileName, 'archive', true, req, {
      fileCount: items.length,
      format: archiveFormat,
      size: totalArchiveSize
    });

  } catch (error) {
    systemLogger.logDownload(archiveFileName || 'archive.zip', 'archive', false, req, {
      fileCount: items?.length || 0,
      format: archiveFormat,
      error: error.message
    });
    if (!res.headersSent && !res.destroyed) {
      res.removeHeader('Content-Disposition');
      res.removeHeader('Content-Type');
      res.status(error.statusCode || (error.code === 'ENOENT' ? 404 : 500)).json({ error: publicErrorMessage(error) });
    } else if (!res.destroyed) {
      res.destroy();
    }
  }
});

// Recursively enumerate every individual file under a set of selected
// files/folders, without archiving them. Used by the "queue" (one-by-one)
// download mode as an alternative to the always-on archive download: the
// client needs a flat file list up front so it can queue one transfer per
// file and preserve the original folder structure at the destination.
const flattenPathEntries = async (absolutePath, relativePrefix, remotePrefix, results) => {
  const manifest = await assertSafeTree(absolutePath);
  for (const entry of manifest) {
    if (!entry.stats.isFile()) continue;
    const relative = path.relative(absolutePath, entry.path).split(path.sep).join('/');
    results.push({
      relativePath: relative ? `${relativePrefix}/${relative}` : relativePrefix,
      remotePath: relative ? `${remotePrefix}/${relative}` : remotePrefix,
      size: entry.stats.size
    });
  }
};

app.post('/api/files/flatten', authenticate, async (req, res) => {
  try {
    const { items, currentPath = '' } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items array is required' });
    }
    await getStorageContext(req, currentPath, 'read');

    const results = [];
    const resolvedItems = [];
    for (const item of items) {
      const remotePath = itemRelativePath(item, currentPath);
      const itemContext = await getStorageContext(req, remotePath, 'read');
      resolvedItems.push({ item, itemContext, remotePath });
    }
    await withOperationLocks(resolvedItems.map(({ itemContext }) => itemContext.targetPath), async () => {
      for (const { item, itemContext, remotePath } of resolvedItems) {
        await flattenPathEntries(itemContext.targetPath, item.name, remotePath, results);
      }
    });

    res.json({ files: results, totalFiles: results.length, totalBytes: results.reduce((sum, entry) => sum + entry.size, 0) });
  } catch (error) {
    res.status(error.statusCode || (error.code === 'ENOENT' ? 404 : 500)).json({ error: publicErrorMessage(error) });
  }
});

// UploadAPI owns progress and cancellation routes and their ownership checks.

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

app.put('/api/settings', requireAdmin, configurationChange(async (req, res) => {
  try {
    const allowed = ['enableRateLimit', 'enableSecurityHeaders', 'enableInputValidation',
      'enableFileUploadSecurity', 'enableRequestLogging', 'enableCSP'];
    if (!req.body || Array.isArray(req.body) || !Object.keys(req.body).length ||
        Object.entries(req.body).some(([key, value]) => !allowed.includes(key) || typeof value !== 'boolean')) {
      return res.status(400).json({ error: 'Supply supported boolean security settings' });
    }
    const previous = Object.fromEntries(Object.keys(req.body).map(key => [key, configManager.get(`security.${key}`)]));
    for (const [key, value] of Object.entries(req.body)) configManager.set(`security.${key}`, value);
    try { await configManager.save(); }
    catch (error) {
      for (const [key, value] of Object.entries(previous)) configManager.set(`security.${key}`, value);
      throw error;
    }
    refreshSecurity();
    systemLogger.logSystem('INFO', `Security settings updated by administrator: ${req.user.username}`);
    res.json({
      success: true,
      message: 'Settings saved and applied successfully.'
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Settings save error: ${error.message}`);
    res.status(500).json({ error: 'Failed to save settings' });
  }
}));

// Admin User Management Endpoints
//
// System roles: 'admin' (config.ini, full control), 'superuser' (manages
// regular 'user' accounts and Permission Roles only), and 'user' (no admin
// access). A superuser actor must never be able to view/create/modify/
// delete an admin or superuser account, or grant the superuser role -
// enforced below regardless of what the frontend sends.
function assertActorCanManageTargetUser(actorRole, targetUser) {
  const targetRole = targetUser?.role || 'user';
  if ((targetRole === 'admin' || targetRole === 'superuser') && actorRole !== 'admin') {
    const error = new Error('Forbidden: only an admin can manage admin or superuser accounts');
    error.statusCode = 403;
    throw error;
  }
}

function assertActorCanAssignRole(actorRole, role) {
  if (role === 'superuser' && actorRole !== 'admin') {
    const error = new Error('Forbidden: only an admin can grant the superuser role');
    error.statusCode = 403;
    throw error;
  }
}

app.get('/api/admin/users', requireStaffRole, async (req, res) => {
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

app.post('/api/admin/users', requireStaffRole, async (req, res) => {
  try {
    const { username, password, email, role = 'user', permissions, locationPermissions, roleId } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    assertActorCanAssignRole(req.user.role, role);

    if (roleId && !roleManager.getRole(roleId)) {
      return res.status(400).json({ error: `Role '${roleId}' not found` });
    }

    const normalizedLocationPermissions = locationPermissionManager.validateMapping(locationPermissions);
    const newUser = await userManager.createUser({
      username,
      password,
      email,
      role,
      permissions,
      locationPermissions: normalizedLocationPermissions,
      roleId: roleId || undefined
    });

    systemLogger.logSystem('INFO', `User '${username}' (role: ${role}) created by ${req.user.role}: ${req.user?.username}`);

    res.status(201).json({
      success: true,
      message: `User '${username}' created successfully`,
      user: newUser
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to create user: ${error.message}`);
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.get('/api/admin/users/:username/locations', requireStaffRole, async (req, res) => {
  try {
    const user = req.params.username === (configManager.get('auth.username') || 'admin')
      ? { role: 'admin', username: req.params.username, permissions: ['all'] }
      : await userManager.getUser(req.params.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    assertActorCanManageTargetUser(req.user.role, user);
    res.json({ success: true, username: req.params.username, locationPermissions: locationPermissionManager.getPublicPermissions(user) });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.put('/api/admin/users/:username/locations', requireStaffRole, async (req, res) => {
  try {
    const { locationPermissions } = req.body;
    const existingUser = req.params.username === (configManager.get('auth.username') || 'admin')
      ? { role: 'admin' }
      : await userManager.getUser(req.params.username);
    if (!existingUser) return res.status(404).json({ error: 'User not found' });
    assertActorCanManageTargetUser(req.user.role, existingUser);
    const normalized = locationPermissionManager.validateMapping(locationPermissions);
    const updatedUser = await userManager.updateUser(req.params.username, { locationPermissions: normalized });
    res.json({ success: true, username: req.params.username, user: updatedUser, locationPermissions: normalized });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.put('/api/admin/users/:username', requireStaffRole, async (req, res) => {
  try {
    const { username } = req.params;
    const existingUser = await userManager.getUser(username);
    if (!existingUser) return res.status(404).json({ error: 'User not found' });
    assertActorCanManageTargetUser(req.user.role, existingUser);

    const updates = { ...req.body };
    if (updates.role !== undefined) {
      assertActorCanAssignRole(req.user.role, updates.role);
    }
    if (updates.locationPermissions !== undefined) {
      updates.locationPermissions = locationPermissionManager.validateMapping(updates.locationPermissions);
    }
    if (updates.roleId !== undefined && updates.roleId !== null && updates.roleId !== '' && !roleManager.getRole(updates.roleId)) {
      return res.status(400).json({ error: `Role '${updates.roleId}' not found` });
    }
    if (updates.roleId === '') updates.roleId = null;
    
    const updatedUser = await userManager.updateUser(username, updates);

    systemLogger.logSystem('INFO', `User '${username}' updated by ${req.user.role}: ${req.user?.username}`);

    res.json({
      success: true,
      message: `User '${username}' updated successfully`,
      user: updatedUser
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to update user: ${error.message}`);
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.delete('/api/admin/users/:username', requireStaffRole, async (req, res) => {
  try {
    const { username } = req.params;
    const existingUser = await userManager.getUser(username);
    if (!existingUser) return res.status(404).json({ error: 'User not found' });
    assertActorCanManageTargetUser(req.user.role, existingUser);

    const result = await userManager.deleteUser(username);

    systemLogger.logSystem('INFO', `User '${username}' deleted by ${req.user.role}: ${req.user?.username}`);

    res.json({
      success: true,
      message: result.message
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to delete user: ${error.message}`);
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.post('/api/admin/users/:username/change-password', requireStaffRole, async (req, res) => {
  try {
    const { username } = req.params;
    const { newPassword } = req.body;
    
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }

    const existingUser = await userManager.getUser(username);
    if (!existingUser) return res.status(404).json({ error: 'User not found' });
    assertActorCanManageTargetUser(req.user.role, existingUser);

    await userManager.updateUser(username, { password: newPassword });

    systemLogger.logSystem('INFO', `Password changed for user '${username}' by ${req.user.role}: ${req.user?.username}`);

    res.json({
      success: true,
      message: `Password changed for user '${username}'`
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to change password: ${error.message}`);
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.get('/api/admin/users/:username', requireStaffRole, async (req, res) => {
  try {
    const { username } = req.params;
    const user = await userManager.getUser(username);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    assertActorCanManageTargetUser(req.user.role, user);
    
    res.json({ user, success: true });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to fetch user: ${error.message}`);
    res.status(error.statusCode || 500).json({ error: 'Failed to fetch user' });
  }
});

// Bulk User Management
//
// Applies system role / Permission Role / active state / Location
// permission changes to many accounts at once. Runs as a background job
// (see auth/bulk-user-job.js) so the request returns immediately with a
// jobId; the frontend polls GET .../bulk/:jobId for live progress and a
// final per-user succeeded/failed/skipped breakdown. No bulk password
// reset is offered. The config admin account can never be a target.
function mergeLocationPermissionsForBulk(existingPermissions, incomingPermissions, mode) {
  if (mode === 'replace') return { ...(incomingPermissions || {}) };
  const merged = { ...(existingPermissions || {}) };
  for (const [locationId, capabilities] of Object.entries(incomingPermissions || {})) {
    merged[locationId] = [...new Set([...(existingPermissions?.[locationId] || []), ...capabilities])];
  }
  return merged;
}

app.post('/api/admin/users/bulk', requireStaffRole, async (req, res) => {
  try {
    const { usernames, changes = {} } = req.body || {};
    if (!Array.isArray(usernames) || usernames.length === 0) {
      return res.status(400).json({ error: 'usernames must be a non-empty array' });
    }
    const uniqueUsernames = [...new Set(usernames.filter((name) => typeof name === 'string' && name))];
    if (uniqueUsernames.length === 0) {
      return res.status(400).json({ error: 'usernames must be a non-empty array' });
    }

    const hasRoleChange = Object.prototype.hasOwnProperty.call(changes, 'role');
    const hasRoleIdChange = Object.prototype.hasOwnProperty.call(changes, 'roleId');
    const hasActiveChange = Object.prototype.hasOwnProperty.call(changes, 'active');
    if (hasActiveChange && typeof changes.active !== 'boolean') {
      return res.status(400).json({ error: 'active must be a boolean' });
    }
    const hasLocationChange = changes.locationPermissions !== undefined
      && typeof changes.locationPermissions === 'object';
    const locationMode = changes.locationPermissionsMode === 'replace' ? 'replace' : 'merge';

    if (!hasRoleChange && !hasRoleIdChange && !hasActiveChange && !hasLocationChange) {
      return res.status(400).json({ error: 'changes must include at least one of: role, roleId, active, locationPermissions' });
    }
    if (hasRoleChange && !userManager.ASSIGNABLE_SYSTEM_ROLES.includes(changes.role)) {
      return res.status(400).json({ error: `Invalid role '${changes.role}'. Must be one of: ${userManager.ASSIGNABLE_SYSTEM_ROLES.join(', ')}` });
    }
    let normalizedIncomingLocationPermissions;
    if (hasLocationChange) {
      normalizedIncomingLocationPermissions = locationPermissionManager.validateMapping(changes.locationPermissions) || {};
    }
    if (hasRoleIdChange && changes.roleId && !roleManager.getRole(changes.roleId)) {
      return res.status(400).json({ error: `Role '${changes.roleId}' not found` });
    }

    const configUsername = configManager.get('auth.username') || 'admin';
    const job = bulkUserJobManager.createJob({
      actorUsername: req.user.username,
      actorRole: req.user.role,
      usernames: uniqueUsernames
    });

    // Respond immediately with the jobId; processing continues in the background.
    res.status(202).json({ success: true, jobId: job.id, total: job.total });

    bulkUserJobManager.run(job, uniqueUsernames, async (username) => {
      if (username === configUsername) {
        return { outcome: 'skipped', reason: 'The config administrator account cannot be a bulk target.' };
      }

      const targetUser = await userManager.getUser(username);
      if (!targetUser) {
        return { outcome: 'skipped', reason: 'User not found.' };
      }

      try {
        assertActorCanManageTargetUser(req.user.role, targetUser);
        if (hasRoleChange) assertActorCanAssignRole(req.user.role, changes.role);
      } catch (error) {
        return { outcome: 'skipped', reason: error.message };
      }

      const updates = {};
      const appliedFields = [];
      if (hasRoleChange) { updates.role = changes.role; appliedFields.push(`role=${changes.role}`); }
      if (hasRoleIdChange) { updates.roleId = changes.roleId || ''; appliedFields.push(`roleId=${changes.roleId || '(cleared)'}`); }
      if (hasActiveChange) { updates.active = !!changes.active; appliedFields.push(`active=${!!changes.active}`); }
      if (hasLocationChange) {
        updates.locationPermissions = mergeLocationPermissionsForBulk(
          targetUser.locationPermissions,
          normalizedIncomingLocationPermissions,
          locationMode
        );
        appliedFields.push(`locationPermissions(${locationMode})`);
      }

      try {
        await userManager.updateUser(username, updates);
        systemLogger.logSystem(
          'INFO',
          `Bulk update applied to user '${username}' by ${req.user.role} '${req.user.username}': ${appliedFields.join(', ')}`
        );
        return { outcome: 'succeeded' };
      } catch (error) {
        systemLogger.logSystem('ERROR', `Bulk update failed for user '${username}': ${error.message}`);
        return { outcome: 'failed', reason: error.message };
      }
    }).catch((error) => {
      systemLogger.logSystem('ERROR', `Bulk user job ${job.id} crashed: ${error.message}`);
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to start bulk user update: ${error.message}`);
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.get('/api/admin/users/bulk/:jobId', requireStaffRole, async (req, res) => {
  const job = bulkUserJobManager.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Bulk job not found (it may have finished more than 30 minutes ago, or the server restarted).' });
  res.json({ success: true, job: bulkUserJobManager.toPublicJson(job) });
});

// Admin Role Management Endpoints
// A Role is a named, reusable Location permission matrix (see RoleManager)
// that can be assigned to users via `roleId`, giving admins a single place
// to edit shared capability grants instead of repeating them per user.
app.get('/api/admin/roles', requireStaffRole, async (req, res) => {
  try {
    const users = await userManager.getAllUsers();
    const roleAssignments = users.reduce((counts, user) => {
      if (user.roleId) counts[user.roleId] = (counts[user.roleId] || 0) + 1;
      return counts;
    }, {});
    const roles = roleManager.getAllRoles().map((role) => ({
      ...role,
      assignedUserCount: roleAssignments[role.id] || 0
    }));
    const locations = locationManager.getLocations({ includeDisabled: true })
      .map(({ id, displayName, enabled, readOnly, order }) => ({ id, displayName, enabled, readOnly, order }));
    res.json({ success: true, roles, locations, capabilities: CAPABILITIES });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to fetch roles: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch roles' });
  }
});

app.post('/api/admin/roles', requireStaffRole, async (req, res) => {
  try {
    const { name, description, locationPermissions } = req.body;
    const role = await roleManager.createRole({ name, description, locationPermissions });
    systemLogger.logSystem('INFO', `Role '${role.name}' created by ${req.user.role}: ${req.user?.username}`);
    res.status(201).json({ success: true, message: `Role '${role.name}' created successfully`, role });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to create role: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/admin/roles/:id', requireStaffRole, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, locationPermissions } = req.body;
    const role = await roleManager.updateRole(id, { name, description, locationPermissions });
    systemLogger.logSystem('INFO', `Role '${role.name}' updated by ${req.user.role}: ${req.user?.username}`);
    res.json({ success: true, message: `Role '${role.name}' updated successfully`, role });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to update role: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/roles/:id', requireStaffRole, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await roleManager.deleteRole(id);
    const { changed } = await userManager.clearRoleFromUsers(id);
    systemLogger.logSystem('INFO', `Role '${id}' deleted by ${req.user.role}: ${req.user?.username}${changed ? ` (unassigned from ${changed} user(s))` : ''}`);
    res.json({ success: true, message: result.message, unassignedUsers: changed });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to delete role: ${error.message}`);
    res.status(400).json({ error: error.message });
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

app.put('/api/admin/config', requireAdmin, configurationChange(async (req, res) => {
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
        if (await userManager.getUser(auth.username.trim())) throw new Error('auth.username must not match an existing regular account');
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

    if (updatedFields.includes('fileSystem.locations') && runtimeChanging) {
      return res.status(409).json({ error: 'Storage reconfiguration is already in progress' });
    }
    const previous = pending.map(([key]) => [key, configManager.get(key)]);
    pending.forEach(([key, value]) => configManager.set(key, value));
    try { await configManager.save(); }
    catch (error) {
      previous.forEach(([key, value]) => configManager.set(key, value));
      throw error;
    }
    if (updatedFields.includes('fileSystem.locations')) await configureLocationRuntime();
    if (updatedFields.some(field => field.startsWith('security.') && field !== 'security.jwtSecret')) refreshSecurity();
    if (updatedFields.includes('logging.level')) systemLogger.setLogLevel(configManager.get('logging.level'));
    if (updatedFields.some(field => field.startsWith('maintenance.'))) scheduleTempCleanup();

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
}));

app.post('/api/admin/config/backup', requireAdmin, async (req, res) => {
  try {
    const backup = {
      timestamp: new Date().toISOString(),
      config: structuredClone(configManager.getConfig()),
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

app.post('/api/admin/config/reset', requireAdmin, configurationChange(async (req, res) => {
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

    if (section === 'security') refreshSecurity();
    systemLogger.logSystem('INFO', `Configuration section '${section}' reset to defaults by admin: ${req.user?.username}`);

    res.json({
      success: true,
      message: `Configuration section '${section}' reset to default values`
    });
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to reset config section: ${error.message}`);
    res.status(500).json({ error: 'Failed to reset configuration section' });
  }
}));

// Clear file cache endpoint
app.post('/api/admin/cache/clear', requireAdmin, async (req, res) => {
  try {
    const context = await getStorageContext(req, '', null);
    await context.fileSystem.clearCache();

    systemLogger.logSystem('INFO', `Cache cleared by admin: ${req.user?.username}`);

    res.json({
      success: true,
      locationId: context.locationId,
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
    checkBrowserBuild();
    if (runtimeChanging) return res.status(409).json({ error: 'Storage configuration is changing' });
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
    runtimeChanging = true;

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

        await Promise.all([...storageRequests]);
        await uploadApi.waitForIdle();
        await Promise.allSettled([...initializingFileSystems.values()]);
        await Promise.all([...locationFileSystems.values()].map(instance => instance.close()));
        locationFileSystems.clear();
        await database.close();

        systemLogger.logSystem('INFO', 'Graceful restart completed, restarting process...');

        // Restart the process
        const { spawn} = require('child_process');
        const child = spawn(process.argv[0], process.argv.slice(1), {
          detached: true,
          stdio: 'inherit',
          cwd: process.cwd(),
          env: process.env
        });

        await new Promise((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
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
const listenOnHost = (listener, port, host) => new Promise((resolve, reject) => {
  const failed = error => { listener.removeListener('error', failed); reject(error); };
  listener.once('error', failed);
  try {
    listener.listen(port, host, () => {
      listener.removeListener('error', failed);
      resolve(listener);
    });
  } catch (error) { failed(error); }
});

async function startServer() {
  try {
    checkBrowserBuild();
    // Load configuration first
    await configManager.load();
    systemLogger.setLogLevel(configManager.get('logging.level'));

    // Initialize database
    await database.initialize();
    systemLogger.logSystem('INFO', 'Database initialized successfully');

    // Initialize security middleware with configuration
    refreshSecurity();

    // Initialize components after config is loaded
    const jwtSecret = configManager.get('security.jwtSecret');
    if (!jwtSecret) throw new Error('JWT secret is not configured');

    authManager = new AuthManager({
      jwtSecret: jwtSecret
    });

    // Initialize user manager
    await userManager.initialize();

    // Initialize role manager
    await roleManager.initialize();

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
    scheduleTempCleanup();
    systemLogger.logSystem('INFO', `TEMP UPLOAD CLEANUP SCHEDULER - RetentionDays: ${tempUploadRetentionDays}, IntervalHours: ${tempUploadCleanupIntervalHours}`);

    const transferCleanupInterval = 15 * 60 * 1000;
    const transferCleanupTimer = setInterval(() => {
      const result = transferManager.cleanup();
      const legacyRemoved = transferProgress.cleanup();
      if (result.transfersRemoved || result.batchesRemoved || legacyRemoved) {
        systemLogger.logSystem('INFO', `TRANSFER PROGRESS CLEANUP - Transfers: ${result.transfersRemoved}, Batches: ${result.batchesRemoved}, Legacy: ${legacyRemoved}`);
      }
    }, transferCleanupInterval);
    transferCleanupTimer.unref?.();

    // Each authorized Location initializes once, on first access.
    await configureLocationRuntime();

    // Start periodic cache refresh for external changes (e.g., every 10 minutes)
    const cacheRefreshInterval = 10 * 60 * 1000;
    const cacheTimer = setInterval(() => {
      if (runtimeChanging) return;
      for (const instance of locationFileSystems.values()) {
        instance.cache.refreshCache().catch(error => systemLogger.logSystem('WARN', `Scheduled cache refresh failed: ${error.message}`));
      }
    }, cacheRefreshInterval);
    cacheTimer.unref?.();

    const port = configManager.get('server.port') || 3000;
    const host = configManager.get('server.host') || 'localhost';
    const httpsPort = configManager.get('ssl.httpsPort') || 9443;
    const enableHttpsRedirect = configManager.get('ssl.enableHttpsRedirect') !== false; // Default true

    console.log('Configuration loaded:');
    console.log('- HTTP Port:', port);
    console.log('- Username:', configManager.get('auth.username'));
    console.log('- Storage Path:', storagePath);
    console.log('- Server Timeout: 10 hours (for large file transfers)');

    console.log('- Bind address:', host);
    console.log('- Location caches: initialized on demand');

    // Generate local certificates on first startup when setup enabled it.
    let sslOptions = await loadSSLCertificates();
    if (!sslOptions && configManager.get('ssl.autoGenerateCerts') === true) {
      const sans = await sanManager.getSANList();
      const result = await certificateManager.generateFullCertificateSet(sans);
      if (result.success) {
        sslOptions = await loadSSLCertificates();
      } else {
        systemLogger.logSystem('ERROR', `Failed to auto-generate SSL certificates: ${result.message}`);
      }
    }
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

        await listenOnHost(httpsServer, httpsPort, host);
        systemLogger.logSystem('INFO', `HTTPS server listening on ${host}:${httpsPort}`);
      } catch (error) {
        systemLogger.logSystem('ERROR', `Failed to start HTTPS server: ${error.message}`);
        throw error;
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

    await listenOnHost(httpServer, port, host);
    {
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

        const cleanupTimer = setTimeout(async () => {
          try {
            const deleted = await shareManager.cleanupExpiredLinks();
            systemLogger.logSystem('INFO', `Share links cleanup completed. Deleted ${deleted} expired links.`);
          } catch (error) {
            systemLogger.logSystem('ERROR', `Share links cleanup failed: ${error.message}`);
          }
          // Schedule next cleanup
          scheduleCleanup();
        }, msToMidnight);
        cleanupTimer.unref?.();
      };

      // Start cleanup scheduler
      scheduleCleanup();
      systemLogger.logSystem('INFO', 'Share links cleanup scheduler started (runs daily at 3 AM)');
    }
  } catch (error) {
    systemLogger.logSystem('ERROR', `Failed to start server: ${error.message}`);
    process.exit(1);
  }
}

// Global error handlers to prevent silent crashes
function installProcessHandlers() {
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
}

async function gracefulShutdown() {
  try {
    runtimeChanging = true;
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
    await uploadApi.waitForIdle();
    await Promise.allSettled([...initializingFileSystems.values()]);
    await Promise.all([...locationFileSystems.values()].map(instance => instance.close()));
    await database.close();
    console.log('✅ File system cache closed');

    systemLogger.logSystem('INFO', 'Server shutdown completed successfully');
    console.log('🚀 Server shutdown complete');
    process.exit(0);
  } catch (error) {
    systemLogger.logSystem('ERROR', `Error during shutdown: ${error.message}`);
    process.exit(1);
  }
}

app.locals.configureLocationRuntime = configureLocationRuntime;
app.locals.refreshSecurity = refreshSecurity;
app.locals.listenOnHost = listenOnHost;

if (require.main === module) {
  installProcessHandlers();
  startServer();
}

module.exports = app;
