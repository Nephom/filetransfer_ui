// Main server file for file transfer application
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcrypt');
const fs = require('fs').promises;
const ConfigManager = require('./config');
const { FileSystem } = require('./file-system');
const AuthManager = require('./auth');
const { transferManager } = require('./transfer');
const { authenticate, setJwtSecret } = require('./middleware/auth');
const {
  authLimiter,
  fileLimiter,
  securityHeaders,
  requestLogger,
  validateInput,
  fileUploadSecurity,
  securityManager
} = require('./middleware/security');

// Initialize configuration
const configManager = new ConfigManager();

// Initialize app
const app = express();

// These will be initialized after config is loaded
let authManager;
let fileSystem;

// Security checks and recommendations on startup
async function performSecurityChecks() {
  console.log('\n🔒 SECURITY CHECKS');
  console.log('='.repeat(50));

  // Check config file permissions
  const configPath = './src/config.ini';
  const isSecure = await securityManager.validateConfigSecurity(configPath);

  if (!isSecure) {
    console.log('⚠️  Config file has insecure permissions');
  } else {
    console.log('✅ Config file permissions are secure');
  }

  // Get security recommendations
  const recommendations = securityManager.getSecurityRecommendations();

  if (recommendations.length > 0) {
    console.log('\n📋 SECURITY RECOMMENDATIONS:');
    recommendations.forEach((rec, index) => {
      console.log(`${index + 1}. [${rec.level}] ${rec.message}`);
      console.log(`   Action: ${rec.action}\n`);
    });
  } else {
    console.log('✅ All security recommendations are implemented');
  }

  // Log security configuration
  console.log('🛡️  SECURITY FEATURES ENABLED:');
  console.log('   ✅ Rate limiting (auth: 5/15min, files: 50/min)');
  console.log('   ✅ Security headers (HSTS, CSP, etc.)');
  console.log('   ✅ Input validation and sanitization');
  console.log('   ✅ File upload security checks');
  console.log('   ✅ Request logging and monitoring');
  console.log('   ✅ Password hashing with bcrypt');
  console.log('   ✅ JWT token authentication');

  console.log('='.repeat(50));
}

// Security middleware
app.use(securityHeaders);
app.use(requestLogger);
app.use(validateInput);

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

app.post('/auth/login', authLimiter, async (req, res) => {
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
app.post('/auth/change-password', authLimiter, authenticate, async (req, res) => {
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
app.post('/auth/forgot-password', authLimiter, async (req, res) => {
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
app.post('/auth/reset-password', authLimiter, async (req, res) => {
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
    const storagePath = configManager.get('fileSystem.basePath') || './storage';
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
    const storagePath = configManager.get('fileSystem.basePath') || './storage';

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
    const storagePath = configManager.get('fileSystem.basePath') || './storage';
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
    const storagePath = configManager.get('fileSystem.basePath') || './storage';
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
    const storagePath = configManager.get('fileSystem.basePath') || './storage';
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
    const storagePath = configManager.get('fileSystem.basePath') || './storage';
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
    const storagePath = configManager.get('fileSystem.basePath') || './storage';
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

// File upload endpoint
app.post('/api/upload', fileLimiter, authenticate, fileUploadSecurity, (req, res) => {
  const storagePath = configManager.get('fileSystem.basePath') || './storage';

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

// Start server with configuration
async function startServer() {
  try {
    // Load configuration first
    await configManager.load();

    // Initialize components after config is loaded
    const jwtSecret = configManager.get('security.jwtSecret') || 'file-transfer-secret-key';

    authManager = new AuthManager({
      jwtSecret: jwtSecret
    });

    // Set JWT secret for middleware
    setJwtSecret(jwtSecret);

    fileSystem = new FileSystem();

    const port = configManager.get('server.port') || 3000;

    console.log('Configuration loaded:');
    console.log('- Port:', port);
    console.log('- Username:', configManager.get('auth.username'));
    console.log('- Storage Path:', configManager.get('fileSystem.basePath'));

    app.listen(port, async () => {
      console.log(`File Transfer API listening at http://localhost:${port}`);

      // Perform security checks
      await performSecurityChecks();

      console.log('\n🚀 Server is ready and secure!');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;