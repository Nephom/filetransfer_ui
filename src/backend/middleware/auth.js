/**
 * Authentication Middleware
 * Provides authentication and authorization for API routes
 */

const AuthManager = require('../auth');

class AuthMiddleware {
  /**
   * Initialize authentication middleware
   * @param {AuthManager} authManager - Instance of AuthManager
   */
  constructor(authManager) {
    this.authManager = authManager;
  }

  /**
   * Authentication middleware function
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Next middleware function
   * @returns {Promise<void>}
   */
  async authenticate(req, res, next) {
    try {
      // Extract token from Authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          error: 'Authorization header missing or invalid'
        });
      }

      const token = authHeader.substring(7); // Remove 'Bearer ' prefix

      // Verify token
      const decoded = this.authManager.verifyToken(token);

      // Attach user info to request
      req.user = decoded;

      next();
    } catch (error) {
      return res.status(401).json({
        error: 'Invalid or expired token'
      });
    }
  }

  /**
   * Authorization middleware function for specific roles
   * @param {Array} requiredRoles - Array of required roles
   * @returns {Function} Middleware function
   */
  authorize(requiredRoles) {
    return (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({
          error: 'Authentication required'
        });
      }

      if (!requiredRoles.includes(req.user.role)) {
        return res.status(403).json({
          error: 'Insufficient permissions'
        });
      }

      next();
    };
  }

  /**
   * Check if user is authenticated
   * @param {Object} req - Express request object
   * @returns {boolean} True if authenticated
   */
  isAuthenticated(req) {
    return !!req.user;
  }

  /**
   * Get current user from request
   * @param {Object} req - Express request object
   * @returns {Object|null} User object or null
   */
  getCurrentUser(req) {
    return req.user || null;
  }
}

// Create a simple authenticate function for direct use
const jwt = require('jsonwebtoken');

// This will be set by the server when it initializes
let jwtSecret = 'file-transfer-secret-key';

const setJwtSecret = (secret) => {
  jwtSecret = secret;
};

const authenticate = async (req, res, next) => {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Authorization header missing or invalid'
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify token using JWT directly
    const decoded = jwt.verify(token, jwtSecret);

    // Attach user info to request
    req.user = decoded;

    next();
  } catch (error) {
    return res.status(401).json({
      error: 'Invalid or expired token'
    });
  }
};

const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden: Admins only' });
  }
};

module.exports = { AuthMiddleware, authenticate, setJwtSecret, requireAdmin };