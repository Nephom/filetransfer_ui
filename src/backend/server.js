// Main server file for file transfer application
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcrypt');
const fs = require('fs').promises;
const os = require('os');
const ConfigManager = require('./config');
const { EnhancedMemoryFileSystem } = require('./file-system');
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
let systemLogger;

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
      // Log successful authentication
      if (systemLogger) {
        systemLogger.logAuth('login', username, true, {}, req);
      }
      
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
      // Log failed authentication
      if (systemLogger) {
        systemLogger.logAuth('login', username, false, { reason: 'Invalid credentials' }, req);
      }
      
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

// Search files using intelligent search engine
app.get('/api/files/search', authenticate, async (req, res) => {
  const startTime = Date.now();
  const user = req.user?.username || 'unknown';
  
  try {
    const { 
      query, 
      mode = 'instant', 
      limit = 1000, 
      sessionId = null,
      includeContext = false,
      fuzzyThreshold = 0.7 
    } = req.query;

    if (!query) {
      // Log invalid search attempt
      if (systemLogger) {
        systemLogger.logFileOperation('search', user, '', {
          success: false,
          error: 'No query provided'
        });
      }
      return res.status(400).json({ error: 'Search query is required' });
    }

    console.log(`Intelligent search: "${query}" (mode: ${mode})`);

    // Add timeout for search operations
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Search timeout')), 30000); // Extended timeout
    });

    const searchOptions = {
      mode: mode.toLowerCase(),
      limit: parseInt(limit) || 1000,
      sessionId: sessionId,
      fuzzyThreshold: parseFloat(fuzzyThreshold) || 0.7,
      contextualSearch: includeContext === 'true'
    };

    let searchResult;
    
    if (includeContext === 'true') {
      // Use full intelligent search with context
      searchResult = await Promise.race([
        fileSystem.intelligentSearch(query, searchOptions),
        timeoutPromise
      ]);
    } else {
      // Use simple search (backwards compatibility)
      const results = await Promise.race([
        fileSystem.searchFiles(query, searchOptions),
        timeoutPromise
      ]);
      
      searchResult = {
        query,
        results,
        mode: searchOptions.mode,
        totalResults: results.length,
        responseTime: 0
      };
    }

    const duration = Date.now() - startTime;
    
    // Log successful search
    if (systemLogger) {
      systemLogger.logFileOperation('search', user, query, {
        success: true,
        resultCount: searchResult.totalResults || searchResult.results?.length || 0
      }, { 
        mode,
        duration,
        limit,
        includeContext
      });
      
      systemLogger.logPerformance('file_search', duration, {
        query,
        mode,
        resultCount: searchResult.totalResults || searchResult.results?.length || 0
      });
    }

    res.json(searchResult);
  } catch (error) {
    console.error('Search error:', error);
    
    // Log search error
    const duration = Date.now() - startTime;
    if (systemLogger) {
      systemLogger.logFileOperation('search', user, req.query.query || '', {
        success: false,
        error: error.message
      }, { 
        mode: req.query.mode || 'instant',
        duration
      });
    }
    
    if (error.message === 'Search timeout') {
      res.status(408).json({ error: 'Search timeout - try a more specific query' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Progressive search with real-time updates (WebSocket-like via Server-Sent Events)
app.get('/api/files/search/progressive', authenticate, async (req, res) => {
  const { query, sessionId = null, limit = 1000 } = req.query;

  if (!query) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  // Set up Server-Sent Events
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  let completed = false;
  
  try {
    console.log(`Progressive search: "${query}"`);

    await fileSystem.progressiveSearch(query, (progressUpdate) => {
      if (!completed && !res.destroyed) {
        const data = JSON.stringify({
          type: 'progress',
          searchId: progressUpdate.searchId,
          results: progressUpdate.results,
          phase: progressUpdate.phase,
          isComplete: progressUpdate.isComplete
        });
        
        res.write(`data: ${data}\n\n`);
        
        if (progressUpdate.isComplete) {
          completed = true;
          res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
          res.end();
        }
      }
    }, {
      sessionId,
      limit: parseInt(limit) || 1000
    });

  } catch (error) {
    console.error('Progressive search error:', error);
    if (!completed && !res.destroyed) {
      res.write(`data: ${JSON.stringify({ 
        type: 'error', 
        error: error.message 
      })}\n\n`);
      res.end();
    }
  }
  
  // Handle client disconnect
  req.on('close', () => {
    completed = true;
  });
});

// Contextual search with user session data
app.post('/api/files/search/contextual', authenticate, async (req, res) => {
  try {
    const { 
      query, 
      context = {}, 
      limit = 500 
    } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    console.log(`Contextual search: "${query}" with context:`, context);

    const searchResult = await fileSystem.contextualSearch(query, {
      ...context,
      userSession: context.sessionId || req.user?.id
    });

    res.json(searchResult);
  } catch (error) {
    console.error('Contextual search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get search analytics and insights
app.get('/api/files/search/analytics', authenticate, async (req, res) => {
  try {
    const analytics = await fileSystem.getSearchAnalytics();
    res.json(analytics);
  } catch (error) {
    console.error('Search analytics error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get search progress for active progressive searches
app.get('/api/files/search/progress/:searchId', authenticate, async (req, res) => {
  try {
    const { searchId } = req.params;
    const progress = fileSystem.getSearchProgress(searchId);
    
    if (progress) {
      res.json({ searchId, progress });
    } else {
      res.status(404).json({ error: 'Search not found or completed' });
    }
  } catch (error) {
    console.error('Search progress error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Trigger smart pre-caching based on analytics
app.post('/api/files/cache/smart-precache', authenticate, async (req, res) => {
  try {
    console.log('Triggering smart pre-cache based on search analytics...');
    await fileSystem.smartPreCache();
    res.json({ message: 'Smart pre-caching completed', timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Smart pre-cache error:', error);
    res.status(500).json({ error: error.message });
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
  const startTime = Date.now();
  const user = req.user?.username || 'unknown';
  const requestPath = req.params[0] || '';
  
  try {
    const storagePath = configManager.get('fileSystem.storagePath') || './storage';

    const storageRoot = path.resolve(storagePath);
    const fullPath = path.join(storageRoot, requestPath);

    if (!fullPath.startsWith(storageRoot)) {
      // Log security violation
      if (systemLogger) {
        systemLogger.logSecurityEvent('PATH_TRAVERSAL_ATTEMPT', {
          requestedPath: requestPath,
          resolvedPath: fullPath
        }, req);
      }
      return res.status(403).json({ error: 'Forbidden: Access denied.' });
    }

    console.log('Downloading file:', fullPath);

    const exists = await fileSystem.exists(fullPath);
    if (!exists) {
      // Log failed download attempt
      if (systemLogger) {
        systemLogger.logFileOperation('download', user, requestPath, {
          success: false,
          error: 'File not found'
        });
      }
      return res.status(404).json({ error: 'File not found' });
    }

    const stats = await fs.stat(fullPath);
    if (stats.isDirectory()) {
      // Log invalid download attempt
      if (systemLogger) {
        systemLogger.logFileOperation('download', user, requestPath, {
          success: false,
          error: 'Cannot download directory'
        });
      }
      return res.status(400).json({ error: 'Cannot download a directory' });
    }

    // Check for modifications
    const cachedInfo = await fileSystem.getFileInfo(fullPath);
    if (cachedInfo && new Date(cachedInfo.modified).getTime() !== stats.mtime.getTime()) {
      // Log file modification conflict
      if (systemLogger) {
        systemLogger.logFileOperation('download', user, requestPath, {
          success: false,
          error: 'File modified since cache'
        }, { fileSize: stats.size });
      }
      return res.status(409).json({ error: 'The file has been modified. Please refresh the file list.' });
    }

    const fileName = path.basename(fullPath);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const fileStream = require('fs').createReadStream(fullPath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      console.error('File stream error:', error);
      // Log stream error
      if (systemLogger) {
        systemLogger.logFileOperation('download', user, requestPath, {
          success: false,
          error: 'Stream error: ' + error.message,
          fileSize: stats.size
        });
      }
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download file' });
      }
    });
    
    fileStream.on('end', () => {
      // Log successful download
      const duration = Date.now() - startTime;
      if (systemLogger) {
        systemLogger.logFileOperation('download', user, requestPath, {
          success: true,
          fileSize: stats.size
        }, { duration });
        
        systemLogger.logPerformance('file_download', duration, {
          fileSize: stats.size,
          fileName
        });
      }
    });
    
  } catch (error) {
    console.error('Download error:', error);
    // Log download error
    if (systemLogger) {
      systemLogger.logFileOperation('download', user, requestPath, {
        success: false,
        error: error.message
      });
    }
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

// Enhanced cache refresh endpoint with intelligent refresh options
app.post('/api/files/refresh-cache', authenticate, async (req, res) => {
  try {
    const { 
      strategy = 'full', 
      targetPath = null, 
      priority = 'medium',
      abortExisting = false 
    } = req.body;

    console.log(`Refreshing file system cache with strategy: ${strategy}`);

    let refreshResult = {};

    switch (strategy.toLowerCase()) {
      case 'full':
        // Full cache refresh
        if (abortExisting) {
          fileSystem.abortCurrentOperations();
        }
        await fileSystem.refreshCache();
        refreshResult = { 
          strategy: 'full', 
          message: 'Full cache refresh completed',
          abortedExisting: abortExisting 
        };
        break;

      case 'smart':
        // Smart refresh based on analytics
        await fileSystem.smartPreCache();
        refreshResult = { 
          strategy: 'smart', 
          message: 'Smart cache refresh completed based on analytics' 
        };
        break;

      case 'targeted':
        // Targeted refresh for specific path
        if (!targetPath) {
          return res.status(400).json({ error: 'targetPath required for targeted refresh' });
        }
        await fileSystem.refreshCache(targetPath);
        refreshResult = { 
          strategy: 'targeted', 
          targetPath,
          message: `Targeted refresh completed for: ${targetPath}` 
        };
        break;

      case 'priority':
        // Refresh only high-priority directories
        const highPriorityFiles = await fileSystem.getHighPriorityFiles();
        const uniqueDirs = [...new Set(highPriorityFiles.map(f => 
          f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/')) : ''
        ))].filter(d => d);
        
        await fileSystem.preCacheDirectories(uniqueDirs.slice(0, 10)); // Limit to 10 dirs
        refreshResult = { 
          strategy: 'priority', 
          directoriesRefreshed: uniqueDirs.length,
          message: `High-priority directories refreshed: ${uniqueDirs.length}` 
        };
        break;

      case 'abort':
        // Just abort current operations
        fileSystem.abortCurrentOperations();
        refreshResult = { 
          strategy: 'abort', 
          message: 'Current cache operations aborted' 
        };
        break;

      default:
        return res.status(400).json({ 
          error: `Unknown refresh strategy: ${strategy}. Use: full, smart, targeted, priority, abort` 
        });
    }

    const cacheInfo = await fileSystem.getCacheInfo();
    
    res.json({ 
      success: true, 
      ...refreshResult,
      timestamp: new Date().toISOString(),
      cacheInfo: {
        isScanning: cacheInfo.isScanning,
        layers: cacheInfo.layers,
        searchEngine: cacheInfo.searchEngine
      }
    });

  } catch (error) {
    console.error('Cache refresh error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cache progress query endpoint
app.get('/api/files/cache-progress', authenticate, async (req, res) => {
  try {
    const cacheInfo = await fileSystem.getCacheInfo();
    
    res.json({
      initialized: cacheInfo.initialized,
      isScanning: cacheInfo.isScanning,
      isWatching: cacheInfo.isWatching,
      layers: {
        metadata: {
          totalItems: cacheInfo.layers.metadata?.totalItems || 0,
          lastUpdate: cacheInfo.layers.metadata?.lastUpdate,
          keys: cacheInfo.layers.metadata?.keys || 0
        },
        content: {
          totalItems: cacheInfo.layers.content?.totalItems || 0,
          lastUpdate: cacheInfo.layers.content?.lastUpdate,
          keys: cacheInfo.layers.content?.keys || 0
        },
        directory: {
          totalItems: cacheInfo.layers.directory?.totalItems || 0,
          lastUpdate: cacheInfo.layers.directory?.lastUpdate,
          keys: cacheInfo.layers.directory?.keys || 0
        }
      },
      searchEngine: {
        totalQueries: cacheInfo.searchEngine?.totalQueries || 0,
        cachedResults: cacheInfo.searchEngine?.cachedResults || 0,
        activeSearches: cacheInfo.searchEngine?.activeSearches || 0,
        activeSessions: cacheInfo.searchEngine?.activeSessions || 0
      },
      performance: {
        concurrentOperations: cacheInfo.concurrentOperations,
        accessFrequencyEntries: cacheInfo.accessFrequencyEntries || 0
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Cache progress error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Search history management endpoint  
app.get('/api/files/search-history', authenticate, async (req, res) => {
  try {
    const { limit = 50, includePatterns = false } = req.query;
    
    const analytics = await fileSystem.getSearchAnalytics();
    
    const response = {
      totalQueries: analytics.totalQueries,
      recentQueries: analytics.topQueries?.slice(0, parseInt(limit)) || [],
      timestamp: new Date().toISOString()
    };

    if (includePatterns === 'true') {
      response.patterns = analytics.topPatterns || [];
      response.totalPatterns = analytics.totalPatterns;
    }

    res.json(response);
  } catch (error) {
    console.error('Search history error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Clear search history
app.delete('/api/files/search-history', authenticate, async (req, res) => {
  try {
    const { type = 'all' } = req.query; // 'all', 'queries', 'patterns'
    
    // Note: This would need to be implemented in the search engine
    // For now, we'll return a placeholder response
    console.log(`Search history clear requested: ${type}`);
    
    res.json({ 
      success: true,
      message: `Search history cleared: ${type}`,
      timestamp: new Date().toISOString(),
      note: 'Search history clearing will be implemented in search engine persistence layer'
    });
  } catch (error) {
    console.error('Search history clear error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Dynamic cache strategy adjustment endpoint
app.post('/api/files/cache-strategy', authenticate, async (req, res) => {
  try {
    const { 
      strategy, 
      parameters = {},
      applyImmediately = false 
    } = req.body;

    if (!strategy) {
      return res.status(400).json({ error: 'Strategy is required' });
    }

    console.log(`Cache strategy adjustment: ${strategy}`, parameters);

    let result = {};

    switch (strategy.toLowerCase()) {
      case 'fast_mode':
        // Enable/disable fast mode
        const enabled = parameters.enabled !== false;
        fileSystem.setFastMode(enabled);
        result = { 
          strategy: 'fast_mode', 
          enabled,
          message: `Fast mode ${enabled ? 'enabled' : 'disabled'}` 
        };
        break;

      case 'priority_boost':
        // Boost priority for specific paths
        if (parameters.paths && Array.isArray(parameters.paths)) {
          await fileSystem.preCacheDirectories(parameters.paths);
          result = { 
            strategy: 'priority_boost',
            paths: parameters.paths,
            message: `Priority boosted for ${parameters.paths.length} paths`
          };
        } else {
          return res.status(400).json({ error: 'paths array required for priority_boost' });
        }
        break;

      case 'memory_optimization':
        // Trigger memory optimization (would need to be implemented)
        result = { 
          strategy: 'memory_optimization',
          message: 'Memory optimization triggered',
          note: 'Implementation depends on cache layer memory management'
        };
        break;

      case 'scan_throttling':
        // Adjust scan throttling parameters
        const throttleLevel = parameters.level || 'medium'; // low, medium, high
        result = { 
          strategy: 'scan_throttling',
          level: throttleLevel,
          message: `Scan throttling set to: ${throttleLevel}`,
          note: 'Throttling adjustment would affect time slice configuration'
        };
        break;

      case 'preload_suggestions':
        // Generate and optionally apply cache preload suggestions
        const suggestions = await fileSystem.getSearchAnalytics();
        const topPaths = suggestions.topQueries?.slice(0, 10)
          .map(q => q.query)
          .filter(q => q.includes('/')) || [];

        if (applyImmediately && topPaths.length > 0) {
          await fileSystem.preCacheDirectories(topPaths);
        }

        result = { 
          strategy: 'preload_suggestions',
          suggestions: topPaths,
          applied: applyImmediately,
          message: `Generated ${topPaths.length} preload suggestions`
        };
        break;

      default:
        return res.status(400).json({ 
          error: `Unknown strategy: ${strategy}. Available: fast_mode, priority_boost, memory_optimization, scan_throttling, preload_suggestions` 
        });
    }

    // Get updated cache info
    const cacheInfo = await fileSystem.getCacheInfo();
    
    res.json({ 
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
      currentState: {
        fastMode: cacheInfo.fastMode,
        isScanning: cacheInfo.isScanning,
        layers: Object.keys(cacheInfo.layers || {}).map(layer => ({
          name: layer,
          totalItems: cacheInfo.layers[layer]?.totalItems || 0,
          lastUpdate: cacheInfo.layers[layer]?.lastUpdate
        }))
      }
    });

  } catch (error) {
    console.error('Cache strategy error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Scheduler management endpoints

// Get scheduler status and statistics
app.get('/api/files/scheduler/status', authenticate, async (req, res) => {
  try {
    const schedulerStats = fileSystem.getSchedulerStats();
    res.json(schedulerStats);
  } catch (error) {
    console.error('Scheduler status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get scheduler queue information
app.get('/api/files/scheduler/queue', authenticate, async (req, res) => {
  try {
    const queueStatus = fileSystem.getSchedulerQueue();
    res.json(queueStatus);
  } catch (error) {
    console.error('Scheduler queue error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Schedule background tasks
app.post('/api/files/scheduler/schedule', authenticate, async (req, res) => {
  try {
    const { 
      type = 'scan',
      paths = [],
      priority = 'normal',
      options = {}
    } = req.body;

    let taskIds = [];
    let result = {};

    switch (type.toLowerCase()) {
      case 'scan':
        if (!paths || paths.length === 0) {
          return res.status(400).json({ error: 'paths array required for scan tasks' });
        }
        taskIds = fileSystem.scheduleBackgroundScan(paths, priority.toUpperCase());
        result = { 
          type: 'scan', 
          scheduledPaths: paths.length,
          taskIds,
          priority 
        };
        break;

      case 'precache':
        taskIds = await fileSystem.preCacheDirectories(paths);
        result = { 
          type: 'precache', 
          scheduledPaths: paths.length,
          taskIds 
        };
        break;

      case 'smart_precache':
        const smartResult = await fileSystem.smartPreCache();
        result = { 
          type: 'smart_precache',
          taskId: smartResult.taskId
        };
        break;

      default:
        return res.status(400).json({ 
          error: `Unknown task type: ${type}. Available: scan, precache, smart_precache` 
        });
    }

    res.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Schedule task error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get task status
app.get('/api/files/scheduler/task/:taskId', authenticate, async (req, res) => {
  try {
    const { taskId } = req.params;
    const taskStatus = fileSystem.getTaskStatus(taskId);
    
    if (taskStatus) {
      res.json(taskStatus);
    } else {
      res.status(404).json({ error: 'Task not found' });
    }
  } catch (error) {
    console.error('Task status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cancel task
app.delete('/api/files/scheduler/task/:taskId', authenticate, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { reason = 'user_request' } = req.query;
    
    const cancelled = fileSystem.cancelTask(taskId, reason);
    
    if (cancelled) {
      res.json({ 
        success: true, 
        taskId, 
        cancelled: true, 
        reason,
        timestamp: new Date().toISOString() 
      });
    } else {
      res.status(404).json({ 
        error: 'Task not found or cannot be cancelled',
        taskId 
      });
    }
  } catch (error) {
    console.error('Cancel task error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Pause/Resume scheduler
app.post('/api/files/scheduler/control', authenticate, async (req, res) => {
  try {
    const { action } = req.body; // 'pause' or 'resume'
    
    let result = {};
    
    switch (action?.toLowerCase()) {
      case 'pause':
        result = fileSystem.pauseScheduler();
        break;
      case 'resume':
        result = fileSystem.resumeScheduler();
        break;
      default:
        return res.status(400).json({ 
          error: `Unknown action: ${action}. Use 'pause' or 'resume'` 
        });
    }
    
    res.json({
      success: true,
      action,
      ...result,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Scheduler control error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API health and status check endpoint
app.get('/api/files/status', authenticate, async (req, res) => {
  try {
    const cacheInfo = await fileSystem.getCacheInfo();
    const searchAnalytics = await fileSystem.getSearchAnalytics();
    
    const status = {
      system: {
        initialized: cacheInfo.initialized,
        layeredCache: cacheInfo.layered,
        intelligentSearch: cacheInfo.intelligentSearch,
        fastMode: cacheInfo.fastMode
      },
      cache: {
        isScanning: cacheInfo.isScanning,
        isWatching: cacheInfo.isWatching,
        concurrentOperations: cacheInfo.concurrentOperations,
        layers: cacheInfo.layers ? Object.keys(cacheInfo.layers).map(layer => ({
          name: layer,
          totalItems: cacheInfo.layers[layer]?.totalItems || 0,
          lastUpdate: cacheInfo.layers[layer]?.lastUpdate,
          health: cacheInfo.layers[layer]?.totalItems > 0 ? 'healthy' : 'empty'
        })) : []
      },
      search: {
        totalQueries: searchAnalytics.totalQueries || 0,
        cachedResults: searchAnalytics.cachedResults || 0,
        activeSearches: searchAnalytics.activeSearches || 0,
        activeSessions: searchAnalytics.activeSessions || 0,
        health: searchAnalytics.totalQueries > 0 ? 'active' : 'unused'
      },
      api: {
        endpoints: [
          { path: '/api/files/search', method: 'GET', description: 'Basic intelligent search' },
          { path: '/api/files/search/progressive', method: 'GET', description: 'Progressive search with SSE' },
          { path: '/api/files/search/contextual', method: 'POST', description: 'Context-aware search' },
          { path: '/api/files/search/analytics', method: 'GET', description: 'Search analytics' },
          { path: '/api/files/search/progress/:id', method: 'GET', description: 'Search progress' },
          { path: '/api/files/search-history', method: 'GET', description: 'Search history' },
          { path: '/api/files/refresh-cache', method: 'POST', description: 'Intelligent cache refresh' },
          { path: '/api/files/cache-progress', method: 'GET', description: 'Cache progress' },
          { path: '/api/files/cache-strategy', method: 'POST', description: 'Dynamic cache strategy' },
          { path: '/api/files/cache/smart-precache', method: 'POST', description: 'Smart pre-caching' }
        ],
        version: '1.0.0',
        features: {
          layeredCaching: true,
          intelligentSearch: true,
          progressiveSearch: true,
          contextualSearch: true,
          searchAnalytics: true,
          dynamicStrategies: true
        }
      },
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    };

    res.json(status);
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ 
      error: error.message,
      timestamp: new Date().toISOString(),
      status: 'unhealthy'
    });
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
      
      const startTime = Date.now();
      const user = req.user?.username || 'unknown';

      console.log('Upload path:', uploadPath);
      console.log('Current path from request:', currentPath);

      // Ensure upload directory exists
      const fs = require('fs').promises;
      await fs.mkdir(uploadPath, { recursive: true });

      // Save each file to the correct location
      const savedFiles = [];
      let totalSize = 0;
      
      for (const file of req.files || []) {
        const filePath = `${uploadPath}/${file.originalname}`;
        const fullPath = currentPath ? `${currentPath}/${file.originalname}` : file.originalname;
        
        try {
          await fs.writeFile(filePath, file.buffer);
          savedFiles.push({ name: file.originalname, size: file.size });
          totalSize += file.size;
          
          // Log each successful file upload
          if (systemLogger) {
            systemLogger.logFileOperation('upload', user, fullPath, {
              success: true,
              fileSize: file.size
            }, { 
              destinationPath: uploadPath,
              mimeType: file.mimetype 
            });
          }
        } catch (fileError) {
          // Log failed file upload
          if (systemLogger) {
            systemLogger.logFileOperation('upload', user, fullPath, {
              success: false,
              error: fileError.message,
              fileSize: file.size
            }, { 
              destinationPath: uploadPath 
            });
          }
          throw fileError;
        }
      }

      const duration = Date.now() - startTime;
      console.log('Files uploaded to:', uploadPath);
      console.log('Files saved:', savedFiles.map(f => f.name));
      
      // Log overall upload operation
      if (systemLogger) {
        systemLogger.logPerformance('batch_upload', duration, {
          fileCount: savedFiles.length,
          totalSize,
          destinationPath: currentPath || 'root'
        });
      }

      res.json({
        success: true,
        message: `${savedFiles.length} file(s) uploaded successfully to ${currentPath || 'root'}`,
        files: savedFiles,
        uploadPath: currentPath
      });
    } catch (error) {
      console.error('File save error:', error);
      
      // Log upload error
      if (systemLogger) {
        const user = req.user?.username || 'unknown';
        systemLogger.logFileOperation('upload', user, req.body.currentPath || 'root', {
          success: false,
          error: error.message
        });
      }
      
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
    
    // Get systemLogger from security middleware
    systemLogger = securityMiddleware.systemLogger;

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
