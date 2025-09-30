// Main server file for file transfer application
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcrypt');
const fs = require('fs').promises;
const os = require('os');
const configManager = require('./config/index.js');
const { EnhancedMemoryFileSystem } = require('./file-system');
const AuthManager = require('./auth');
const UserManager = require('./auth/user-manager');
const UploadAPI = require('./api/upload.js');
const { transferManager } = require('./transfer');
const { authenticate, setJwtSecret } = require('./middleware/auth');
const { initializeSecurity } = require('./middleware/security');



// Initialize user manager
const userManager = new UserManager();

// Initialize app
const app = express();

// These will be initialized after config is loaded
let authManager;
let fileSystem;
let securityMiddleware;

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
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
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
      if (systemLogger) {
        systemLogger.logAuth('login', username, true, { role: user.role }, req);
      }
      
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
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    console.error('Login error:', error);
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

    console.log('Password changed successfully for user:', req.user.username);

    res.json({
      success: true,
      message: 'Password changed successfully. Please login again with your new password.'
    });
  } catch (error) {
    console.error('Password change error:', error);
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
    console.error('Forgot password error:', error);
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

    console.log('Password reset successfully for user:', username);

    res.json({
      success: true,
      message: 'Password reset successfully. Please login with your new password.'
    });
  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Search files using cache (must be before wildcard route)
app.get('/api/files/search', authenticate, async (req, res) => {
  try {
    const { query } = req.query;

    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    console.log('Searching for:', query, 'using in-memory cache');

    // Add timeout for search operations
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Search timeout')), 15000);
    });

    const searchResults = await Promise.race([
      fileSystem.searchFiles(query),
      timeoutPromise
    ]);

    res.json(searchResults);
  } catch (error) {
    console.error('Search error:', error);
    if (error.message === 'Search timeout') {
      res.status(408).json({ error: 'Search timeout - try a more specific query' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// IMPORTANT: Specific routes must come before the general '/api/files/*' wildcard route.

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
      return res.status(403).json({ error: 'Forbidden: Access denied.' });
    }

    console.log('Downloading file:', fullPath);

    const exists = await fileSystem.exists(fullPath);
    if (!exists) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stats = await fs.stat(fullPath);
    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'Cannot download a directory' });
    }

    // Check for modifications
    const cachedInfo = await fileSystem.getFileInfo(fullPath);
    if (cachedInfo && new Date(cachedInfo.modified).getTime() !== stats.mtime.getTime()) {
      return res.status(409).json({ error: 'The file has been modified. Please refresh the file list.' });
    }

    const fileName = path.basename(fullPath);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const fileStream = require('fs').createReadStream(fullPath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      console.error('File stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download file' });
      }
    });
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List files in a directory (or root)
app.get('/api/files/*', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const requestPath = req.params[0] || '';

    const storageRoot = path.resolve(storagePath);
    const fullPath = path.join(storageRoot, requestPath);

    if (!fullPath.startsWith(storageRoot)) {
      return res.status(403).json({ error: 'Forbidden: Access denied.' });
    }

    console.log('Listing files in:', fullPath);

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), 30000);
    });

    const files = await Promise.race([
      fileSystem.list(fullPath),
      timeoutPromise
    ]);

    res.json(files);
  } catch (error) {
    console.error('File listing error:', error);
    if (error.message === 'Request timeout') {
      res.status(408).json({ error: 'Request timeout - file system may be busy' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Handle root files API call
app.get('/api/files', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath');
    const storageRoot = path.resolve(storagePath);

    console.log('Listing files in root storage:', storageRoot);

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), 30000);
    });

    const files = await Promise.race([
      fileSystem.list(storageRoot),
      timeoutPromise
    ]);

    res.json(files);
  } catch (error) {
    console.error('File listing error:', error);
    if (error.message === 'Request timeout') {
      res.status(408).json({ error: 'Request timeout - file system may be busy' });
    } else {
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
      return res.status(403).json({ error: 'Forbidden: Access denied.' });
    }

    console.log('Creating folder:', fullPath);
    await fileSystem.mkdir(fullPath);
    res.json({ success: true, message: 'Folder created successfully' });
  } catch (error) {
    console.error('Folder creation error:', error);
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

// Cache refresh endpoint (for manual cache updates)
app.post('/api/files/refresh-cache', authenticate, async (req, res) => {
  try {
    console.log('Refreshing file system cache...');
    await fileSystem.refreshCache();
    res.json({ success: true, message: 'Cache refreshed successfully' });
  } catch (error) {
    console.error('Cache refresh error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cache statistics endpoint
app.get('/api/files/cache-stats', authenticate, async (req, res) => {
  try {
    const stats = await fileSystem.getCacheInfo ? await fileSystem.getCacheInfo() : { message: 'Cache stats not available' };
    res.json(stats);
  } catch (error) {
    console.error('Cache stats error:', error);
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

    console.log('Creating file:', fullPath);
    await fileSystem.write(fullPath, content);
    res.json({ success: true, message: 'File created successfully' });
  } catch (error) {
    console.error('File creation error:', error);
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

    const oldPath = currentPath
      ? `${storagePath}/${currentPath}/${oldName}`
      : `${storagePath}/${oldName}`;

    const newPath = currentPath
      ? `${storagePath}/${currentPath}/${newName}`
      : `${storagePath}/${newName}`;

    console.log('Renaming:', oldPath, 'to', newPath);
    await fileSystem.rename(oldPath, newPath);
    res.json({ success: true, message: 'Item renamed successfully' });
  } catch (error) {
    console.error('Rename error:', error);
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

    const deletedItems = [];
    for (const item of items) {
      const fullPath = currentPath
        ? `${storagePath}/${currentPath}/${item.name}`
        : `${storagePath}/${item.name}`;

      console.log('Deleting:', fullPath);
      await fileSystem.delete(fullPath);
      deletedItems.push(item.name);
    }

    res.json({
      success: true,
      message: `${deletedItems.length} item(s) deleted successfully`,
      deletedItems
    });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: error.message });
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

    const processedItems = [];
    for (const item of items) {
      const sourcePath = item.sourcePath || (item.currentPath
        ? `${storagePath}/${item.currentPath}/${item.name}`
        : `${storagePath}/${item.name}`);

      const targetFullPath = targetPath
        ? `${storagePath}/${targetPath}/${item.name}`
        : `${storagePath}/${item.name}`;

      console.log(`${operation === 'copy' ? 'Copying' : 'Moving'}:`, sourcePath, 'to', targetFullPath);

      if (operation === 'copy') {
        await fileSystem.copy(sourcePath, targetFullPath);
      } else if (operation === 'cut') {
        await fileSystem.move(sourcePath, targetFullPath);
      }

      processedItems.push(item.name);
    }

    res.json({
      success: true,
      message: `${processedItems.length} item(s) ${operation === 'copy' ? 'copied' : 'moved'} successfully`,
      processedItems
    });
  } catch (error) {
    console.error('Paste error:', error);
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
    console.error('Settings fetch error:', error);
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

    console.log('Security settings updated by user:', req.user?.username);
    console.log('New settings:', {
      enableRateLimit,
      enableSecurityHeaders,
      enableInputValidation,
      enableFileUploadSecurity,
      enableRequestLogging,
      enableCSP
    });

    res.json({
      success: true,
      message: 'Settings saved successfully. Server restart may be required for some changes to take effect.'
    });
  } catch (error) {
    console.error('Settings save error:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

<<<<<<< HEAD
=======
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
    console.error('Failed to fetch users:', error);
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

    console.log(`User '${username}' created by admin:`, req.user?.username);
    
    res.status(201).json({
      success: true,
      message: `User '${username}' created successfully`,
      user: newUser
    });
  } catch (error) {
    console.error('Failed to create user:', error);
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/admin/users/:username', requireAdmin, async (req, res) => {
  try {
    const { username } = req.params;
    const updates = req.body;
    
    const updatedUser = await userManager.updateUser(username, updates);
    
    console.log(`User '${username}' updated by admin:`, req.user?.username);
    
    res.json({
      success: true,
      message: `User '${username}' updated successfully`,
      user: updatedUser
    });
  } catch (error) {
    console.error('Failed to update user:', error);
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/users/:username', requireAdmin, async (req, res) => {
  try {
    const { username } = req.params;
    
    const result = await userManager.deleteUser(username);
    
    console.log(`User '${username}' deleted by admin:`, req.user?.username);
    
    res.json({
      success: true,
      message: result.message
    });
  } catch (error) {
    console.error('Failed to delete user:', error);
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
    
    console.log(`Password changed for user '${username}' by admin:`, req.user?.username);
    
    res.json({
      success: true,
      message: `Password changed for user '${username}'`
    });
  } catch (error) {
    console.error('Failed to change password:', error);
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
    console.error('Failed to fetch user:', error);
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
    console.error('Failed to fetch config:', error);
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
    
    console.log(`Configuration updated by admin: ${req.user?.username}`);
    console.log('Updated fields:', updatedFields);
    
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
    console.error('Failed to update config:', error);
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
    delete backup.config.jwtSecret;
    
    const backupName = `config-backup-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.json`;
    
    res.setHeader('Content-Disposition', `attachment; filename="${backupName}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(backup);
  } catch (error) {
    console.error('Failed to create config backup:', error);
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
    
    console.log(`Configuration section '${section}' reset to defaults by admin:`, req.user?.username);
    
    res.json({
      success: true,
      message: `Configuration section '${section}' reset to default values`
    });
  } catch (error) {
    console.error('Failed to reset config section:', error);
    res.status(500).json({ error: 'Failed to reset configuration section' });
  }
});

>>>>>>> 7418473 (Implement comprehensive User Management and Configuration Editing features)
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
    fileSystem.initialize();

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
    });
  } catch (error) {
    console.error('Failed to start server:', error);
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
    console.log('Closing file system cache...');
    if (fileSystem && fileSystem.close) {
      await fileSystem.close();
    }
    console.log('✅ File system cache closed');

    console.log('🚀 Server shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
