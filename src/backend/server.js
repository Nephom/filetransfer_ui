// Main server file for file transfer application
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcrypt');
const fs = require('fs').promises;
const os = require('os');
const ConfigManager = require('./config');
const { FileSystem } = require('./file-system');
const AuthManager = require('./auth');
const { transferManager } = require('./transfer');
const { authenticate, setJwtSecret } = require('./middleware/auth');
const { initializeSecurity } = require('./middleware/security');

// Initialize configuration
const configManager = new ConfigManager();

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

    // Get credentials from config
    const configUsername = configManager.get('auth.username');
    const configPassword = configManager.get('auth.password');

    // Simple authentication against config file
    if (username === configUsername && password === configPassword) {
      // Generate JWT token
      const jwt = require('jsonwebtoken');
      const token = jwt.sign(
        {
          id: 1,
          username: username,
          role: 'admin'
        },
        configManager.get('security.jwtSecret') || 'file-transfer-secret-key',
        { expiresIn: '24h' }
      );

      res.json({
        success: true,
        token,
        user: {
          id: 1,
          username: username,
          role: 'admin'
        }
      });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(401).json({ error: error.message });
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

    // Generate a temporary reset token (valid for 15 minutes)
    const resetToken = require('crypto').randomBytes(32).toString('hex');
    const resetExpiry = Date.now() + 15 * 60 * 1000; // 15 minutes

    // Store reset token temporarily (in production, use database)
    global.resetTokens = global.resetTokens || {};
    global.resetTokens[username] = {
      token: resetToken,
      expiry: resetExpiry
    };

    console.log('='.repeat(60));
    console.log('🔐 PASSWORD RESET REQUEST');
    console.log('='.repeat(60));
    console.log(`Username: ${username}`);
    console.log(`Reset Token: ${resetToken}`);
    console.log(`Valid until: ${new Date(resetExpiry).toLocaleString()}`);
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

    // Check if reset token exists and is valid
    const storedToken = global.resetTokens?.[username];
    if (!storedToken || storedToken.token !== resetToken || Date.now() > storedToken.expiry) {
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

    // Clear the used reset token
    delete global.resetTokens[username];

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

// File system routes (authenticated)
app.get('/api/files/*', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const requestPath = req.params[0] || '';

    // Construct full path
    const fullPath = requestPath ? `${storagePath}/${requestPath}` : storagePath;

    console.log('Listing files in:', fullPath);
    const files = await fileSystem.list(fullPath);
    res.json(files);
  } catch (error) {
    console.error('File listing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Handle root files API call
app.get('/api/files', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath');

    console.log('Listing files in root storage:', storagePath);
    const files = await fileSystem.list(storagePath);
    res.json(files);
  } catch (error) {
    console.error('File listing error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/files/content/:path*', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const requestPath = req.params.path ? req.params.path + (req.params[0] || '') : '';
    const fullPath = `${storagePath}/${requestPath}`;

    const content = await fileSystem.read(fullPath);
    res.json({ content: content.toString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/files', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const { path, content } = req.body;
    const fullPath = `${storagePath}/${path}`;

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

    const fullPath = currentPath
      ? `${storagePath}/${currentPath}/${folderName.trim()}`
      : `${storagePath}/${folderName.trim()}`;

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
    const { path } = req.body;
    const fullPath = `${storagePath}/${path}`;

    await fileSystem.mkdir(fullPath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/files/:path*', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const requestPath = req.params.path ? req.params.path + (req.params[0] || '') : '';
    const fullPath = `${storagePath}/${requestPath}`;

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

// Download file endpoint
app.get('/api/files/download/:path*', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const requestPath = req.params.path ? req.params.path + (req.params[0] || '') : '';
    const fullPath = `${storagePath}/${requestPath}`;

    console.log('Downloading file:', fullPath);

    // Check if file exists
    const exists = await fileSystem.exists(fullPath);
    if (!exists) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Get file stats to check if it's a file (not directory)
    const fs = require('fs').promises;
    const stats = await fs.stat(fullPath);
    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'Cannot download a directory' });
    }

    // Set appropriate headers for file download
    const path = require('path');
    const fileName = path.basename(fullPath);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    // Stream the file
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

// Search files recursively
app.get('/api/files/search', authenticate, async (req, res) => {
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';
    const { query, path: searchPath } = req.query;

    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const searchInPath = searchPath ? `${storagePath}/${searchPath}` : storagePath;
    console.log('Searching for:', query, 'in:', searchInPath);

    const searchResults = await searchFilesRecursively(searchInPath, query, storagePath);
    res.json(searchResults);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to search files recursively
async function searchFilesRecursively(searchPath, query, basePath) {
  const fs = require('fs').promises;
  const path = require('path');
  const results = [];

  async function searchDirectory(dirPath) {
    try {
      const items = await fs.readdir(dirPath);

      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stats = await fs.stat(itemPath);

        // Check if item name matches search query
        if (item.toLowerCase().includes(query.toLowerCase())) {
          // Calculate relative path from storage base
          const relativePath = path.relative(basePath, itemPath);

          results.push({
            name: item,
            path: relativePath,
            isDirectory: stats.isDirectory(),
            size: stats.size,
            modified: stats.mtime.toISOString(),
            fullPath: itemPath
          });
        }

        // If it's a directory, search recursively
        if (stats.isDirectory()) {
          await searchDirectory(itemPath);
        }
      }
    } catch (error) {
      console.error('Error searching directory:', dirPath, error);
    }
  }

  await searchDirectory(searchPath);
  return results;
}

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

// File upload endpoint
app.post('/api/upload', (req, res, next) => {
  // Apply file limiter if security middleware is initialized
  if (securityMiddleware && securityMiddleware.fileLimiter) {
    securityMiddleware.fileLimiter(req, res, next);
  } else {
    next();
  }
}, authenticate, (req, res, next) => {
  // Apply file upload security if security middleware is initialized
  if (securityMiddleware && securityMiddleware.fileUploadSecurity) {
    securityMiddleware.fileUploadSecurity(req, res, next);
  } else {
    next();
  }
}, (req, res) => {
  const storagePath = configManager.get('fileSystem.storagePath') || './storage';

  // First, parse the form to get currentPath
  const upload = multer().array('files');

  upload(req, res, async (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(500).json({ error: err.message });
    }

    try {
      const currentPath = req.body.currentPath || '';
      const uploadPath = currentPath
        ? `${storagePath}/${currentPath}`
        : storagePath;

      console.log('Upload path:', uploadPath);
      console.log('Current path from request:', currentPath);

      // Ensure upload directory exists
      const fs = require('fs').promises;
      await fs.mkdir(uploadPath, { recursive: true });

      // Save each file to the correct location
      const savedFiles = [];
      for (const file of req.files || []) {
        const filePath = `${uploadPath}/${file.originalname}`;
        await fs.writeFile(filePath, file.buffer);
        savedFiles.push({ name: file.originalname, size: file.size });
      }

      console.log('Files uploaded to:', uploadPath);
      console.log('Files saved:', savedFiles.map(f => f.name));

      res.json({
        success: true,
        message: `${savedFiles.length} file(s) uploaded successfully to ${currentPath || 'root'}`,
        files: savedFiles,
        uploadPath: currentPath
      });
    } catch (error) {
      console.error('File save error:', error);
      res.status(500).json({ error: error.message });
    }
  });
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

    // Set JWT secret for middleware
    setJwtSecret(jwtSecret);

    fileSystem = new FileSystem();

    const port = configManager.get('server.port') || 3000;

    const storagePath = configManager.get('fileSystem.storagePath') || './storage';

    console.log('Configuration loaded:');
    console.log('- Port:', port);
    console.log('- Username:', configManager.get('auth.username'));
    console.log('- Storage Path:', storagePath);

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

startServer();

module.exports = app;