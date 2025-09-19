// Security middleware for Express
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const SecurityManager = require('../security/security');

const securityManager = new SecurityManager();

// Rate limiting for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: {
    error: 'Too many authentication attempts, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    securityManager.logSecurityEvent('RATE_LIMIT_EXCEEDED', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      endpoint: req.path
    });
    
    res.status(429).json({
      error: 'Too many authentication attempts, please try again later.'
    });
  }
});

// Rate limiting for file operations
const fileLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 50, // Limit each IP to 50 file operations per minute
  message: {
    error: 'Too many file operations, please slow down.'
  }
});

// Security headers middleware with development/production modes
const isDevelopment = process.env.NODE_ENV !== 'production';

const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // Allow inline styles for themes
      scriptSrc: [
        "'self'",
        "'unsafe-inline'", // Allow inline scripts for React components
        "'unsafe-eval'" // Required for Babel JSX transformation
      ].concat(isDevelopment ? [
        // In development, allow CDN fallbacks
        "https://unpkg.com",
        "https://cdn.jsdelivr.net"
      ] : []),
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https:", "data:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      childSrc: ["'none'"],
      workerSrc: ["'none'"],
      manifestSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: isDevelopment ? null : []
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: isDevelopment ? false : {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
});

// Request logging middleware
const requestLogger = (req, res, next) => {
  const startTime = Date.now();
  
  // Log request
  console.log(`📥 ${req.method} ${req.path} - ${req.ip} - ${req.get('User-Agent')}`);
  
  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const statusColor = res.statusCode >= 400 ? '🔴' : '🟢';
    console.log(`📤 ${statusColor} ${res.statusCode} ${req.method} ${req.path} - ${duration}ms`);
    
    // Log security events for suspicious activity
    if (res.statusCode === 401) {
      securityManager.logSecurityEvent('UNAUTHORIZED_ACCESS', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        endpoint: req.path,
        method: req.method
      });
    }
    
    if (res.statusCode >= 500) {
      securityManager.logSecurityEvent('SERVER_ERROR', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        endpoint: req.path,
        method: req.method,
        statusCode: res.statusCode
      });
    }
  });
  
  next();
};

// Input validation middleware
const validateInput = (req, res, next) => {
  // Check for common attack patterns
  const suspiciousPatterns = [
    /\.\.\//g,  // Path traversal
    /<script/gi, // XSS
    /union.*select/gi, // SQL injection
    /javascript:/gi, // JavaScript injection
    /vbscript:/gi, // VBScript injection
    /onload=/gi, // Event handler injection
    /onerror=/gi, // Event handler injection
  ];
  
  const checkValue = (value) => {
    if (typeof value === 'string') {
      for (const pattern of suspiciousPatterns) {
        if (pattern.test(value)) {
          return true;
        }
      }
    }
    return false;
  };
  
  // Check all request data
  const allData = { ...req.query, ...req.body, ...req.params };
  
  for (const [key, value] of Object.entries(allData)) {
    if (checkValue(value)) {
      securityManager.logSecurityEvent('SUSPICIOUS_INPUT', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        endpoint: req.path,
        suspiciousField: key,
        suspiciousValue: value
      });
      
      return res.status(400).json({
        error: 'Invalid input detected'
      });
    }
  }
  
  next();
};

// File upload security middleware
const fileUploadSecurity = (req, res, next) => {
  if (req.files && req.files.length > 0) {
    const dangerousExtensions = [
      '.exe', '.bat', '.cmd', '.com', '.pif', '.scr', '.vbs', '.js', '.jar',
      '.php', '.asp', '.aspx', '.jsp', '.sh', '.ps1', '.py', '.rb'
    ];
    
    for (const file of req.files) {
      const ext = require('path').extname(file.originalname).toLowerCase();
      
      if (dangerousExtensions.includes(ext)) {
        securityManager.logSecurityEvent('DANGEROUS_FILE_UPLOAD', {
          ip: req.ip,
          userAgent: req.get('User-Agent'),
          filename: file.originalname,
          extension: ext
        });
        
        return res.status(400).json({
          error: `File type ${ext} is not allowed for security reasons`
        });
      }
      
      // Check file size (already handled by multer, but double-check)
      if (file.size > 100 * 1024 * 1024) { // 100MB
        return res.status(400).json({
          error: 'File size exceeds maximum allowed size'
        });
      }
    }
  }
  
  next();
};

module.exports = {
  authLimiter,
  fileLimiter,
  securityHeaders,
  requestLogger,
  validateInput,
  fileUploadSecurity,
  securityManager
};
