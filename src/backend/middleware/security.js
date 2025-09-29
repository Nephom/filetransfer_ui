// Security middleware for Express
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const SecurityManager = require('../security/security');
const SystemLogger = require('../logging/system-logger');

// Configuration manager will be injected
let configManager = null;
let systemLogger = null;

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
    if (systemLogger) {
      systemLogger.logSecurityEvent('RATE_LIMIT_EXCEEDED', {
        endpoint: req.path,
        limit: 'auth'
      }, req);
    } else {
      securityManager.logSecurityEvent('RATE_LIMIT_EXCEEDED', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        endpoint: req.path
      });
    }
    
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

// Function to create configurable security headers
const createSecurityHeaders = (config) => {
  const isDevelopment = process.env.NODE_ENV !== 'production';
  const enableCSP = config?.get('security.enableCSP') === true; // Only enable if explicitly set to true
  const enableSecurityHeaders = config?.get('security.enableSecurityHeaders') === true; // Only enable if explicitly set to true

  if (!enableSecurityHeaders) {
    // Minimal security headers - only essential ones
    return helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      hsts: false,
      xFrameOptions: false,
      xContentTypeOptions: false,
      xDnsPrefetchControl: false,
      xDownloadOptions: false,
      xPermittedCrossDomainPolicies: false,
      xPoweredBy: false,
      xXssProtection: false
    });
  }

  return helmet({
    contentSecurityPolicy: enableCSP ? {
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
    } : false,
    crossOriginEmbedderPolicy: false,
    hsts: isDevelopment ? false : {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  });
};

// Configurable request logging middleware
const createRequestLogger = (config) => {
  const enableLogging = config?.get('security.enableRequestLogging') === true ||
                       config?.get('logging.enableDetailedLogging') === true;

  if (!enableLogging) {
    return (req, res, next) => next(); // No-op middleware
  }

  // Use SystemLogger if available, fallback to console logging
  if (systemLogger) {
    return systemLogger.createRequestMiddleware();
  }

  return (req, res, next) => {
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
};

// Configurable input validation middleware
const createInputValidator = (config) => {
  const enableValidation = config?.get('security.enableInputValidation') === true;

  if (!enableValidation) {
    return (req, res, next) => next(); // No-op middleware
  }

  return (req, res, next) => {
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
          if (systemLogger) {
            systemLogger.logSecurityEvent('SUSPICIOUS_INPUT', {
              suspiciousField: key,
              suspiciousValue: value
            }, req);
          } else {
            securityManager.logSecurityEvent('SUSPICIOUS_INPUT', {
              ip: req.ip,
              userAgent: req.get('User-Agent'),
              endpoint: req.path,
              suspiciousField: key,
              suspiciousValue: value
            });
          }

          return res.status(400).json({
            error: 'Invalid input detected'
          });
        }
      }

    next();
  };
};

// Configurable file upload security middleware
const createFileUploadSecurity = (config) => {
  const enableSecurity = config?.get('security.enableFileUploadSecurity') === true;

  if (!enableSecurity) {
    return (req, res, next) => next(); // No-op middleware
  }

  return (req, res, next) => {
    if (req.files && req.files.length > 0) {
      const dangerousExtensions = [
        '.exe', '.bat', '.cmd', '.com', '.pif', '.scr', '.vbs', '.js', '.jar',
        '.php', '.asp', '.aspx', '.jsp', '.sh', '.ps1', '.py', '.rb'
      ];

      for (const file of req.files) {
        const ext = require('path').extname(file.originalname).toLowerCase();

        if (dangerousExtensions.includes(ext)) {
          if (systemLogger) {
            systemLogger.logSecurityEvent('DANGEROUS_FILE_UPLOAD', {
              filename: file.originalname,
              extension: ext
            }, req);
          } else {
            securityManager.logSecurityEvent('DANGEROUS_FILE_UPLOAD', {
              ip: req.ip,
              userAgent: req.get('User-Agent'),
              filename: file.originalname,
              extension: ext
            });
          }

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
};

// Function to create configurable rate limiters
const createRateLimiters = (config) => {
  const enableRateLimit = config?.get('security.enableRateLimit') === true;

  if (!enableRateLimit) {
    // Return no-op middleware
    return {
      authLimiter: (req, res, next) => next(),
      fileLimiter: (req, res, next) => next()
    };
  }

  return {
    authLimiter,
    fileLimiter
  };
};

// Initialize security middleware with configuration
const initializeSecurity = (config) => {
  configManager = config;
  systemLogger = new SystemLogger(config);
  
  const rateLimiters = createRateLimiters(config);

  return {
    authLimiter: rateLimiters.authLimiter,
    fileLimiter: rateLimiters.fileLimiter,
    securityHeaders: createSecurityHeaders(config),
    requestLogger: createRequestLogger(config),
    validateInput: createInputValidator(config),
    fileUploadSecurity: createFileUploadSecurity(config),
    securityManager,
    systemLogger // Export systemLogger for use in other modules
  };
};

module.exports = {
  initializeSecurity,
  // Export individual components for backward compatibility
  authLimiter,
  fileLimiter,
  securityManager
};
