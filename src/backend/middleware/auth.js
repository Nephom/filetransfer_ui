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
const configManager = require('../config');
const userManager = require('../auth/user-manager');

// This will be set by the server when it initializes
let jwtSecret = null;

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

/**
 * Resolve a decoded token's *current* system role and active status by
 * looking the account up again in config.ini (for the single admin) or
 * users.json (for everyone else), instead of trusting the `role` claim
 * embedded in the JWT at login time. Tokens are valid for 24h, so without
 * this, an admin demoting a superuser to 'user' (or deactivating any
 * account) would not take effect until the caller's existing token expired.
 */
async function resolveCurrentAccount(decoded) {
  const configUsername = configManager.get('auth.username') || 'admin';
  if (decoded && decoded.username === configUsername) {
    return { exists: true, active: true, role: 'admin' };
  }
  try {
    const user = await userManager.getUser(decoded.username);
    if (!user) return { exists: false, active: false, role: null };
    return { exists: true, active: user.active !== false, role: user.role || 'user' };
  } catch (error) {
    return { exists: false, active: false, role: null };
  }
}

/**
 * Build a role-gated middleware that authenticates the bearer token and
 * then re-authorizes against the account's *current* role, not the token's
 * `role` claim. `req.user.role` is overwritten with the fresh value so
 * downstream handlers (e.g. bulk user management, per-target admin/
 * superuser checks) never act on stale claims either.
 */
function requireRole(allowedRoles) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authorization header missing or invalid' });
      }

      const token = authHeader.substring(7);
      let decoded;
      try {
        decoded = jwt.verify(token, jwtSecret);
      } catch (error) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      const current = await resolveCurrentAccount(decoded);
      if (!current.exists || !current.active) {
        return res.status(401).json({ error: 'Account no longer exists or is inactive' });
      }
      if (!allowedRoles.includes(current.role)) {
        return res.status(403).json({ error: 'Forbidden: insufficient privileges' });
      }

      req.user = { ...decoded, role: current.role };
      next();
    } catch (error) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

// Admin-only: config, service restart, SSL certificate management, and any
// admin/superuser account management enforced further inside the route
// handler (see /api/admin/users in server.js).
const requireAdmin = requireRole(['admin']);

// Admin OR superuser: user (non-admin/superuser) account management and
// Permission Role management. Route handlers must still block a superuser
// actor from touching admin/superuser targets or assigning the superuser
// role themselves.
const requireStaffRole = requireRole(['admin', 'superuser']);

module.exports = { AuthMiddleware, authenticate, setJwtSecret, requireAdmin, requireStaffRole, resolveCurrentAccount };
