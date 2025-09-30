/**
 * Authentication System
 * Handles user authentication, session management, and access control
 */

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const fs = require('fs').promises;
const path = require('path');

class AuthManager {
  /**
   * Initialize authentication manager
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.options = options;
    this.usersFile = options.usersFile || './data/users.json';
    this.jwtSecret = options.jwtSecret || process.env.JWT_SECRET;
    this.sessionTimeout = options.sessionTimeout || 3600; // 1 hour
  }

  /**
   * Register a new user
   * @param {string} username - User's username
   * @param {string} password - User's password
   * @returns {Promise<Object>} Registration result
   */
  async register(username, password) {
    // Check if user already exists
    const existingUser = await this._getUser(username);
    if (existingUser) {
      throw new Error('User already exists');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user object
    const user = {
      id: this._generateId(),
      username,
      password: hashedPassword,
      role: 'user',
      createdAt: new Date().toISOString(),
      lastLogin: null
    };

    // Save user
    await this._saveUser(user);

    return {
      success: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    };
  }

  /**
   * Authenticate a user
   * @param {string} username - User's username
   * @param {string} password - User's password
   * @returns {Promise<Object>} Authentication result
   */
  async login(username, password) {
    const user = await this._getUser(username);
    if (!user) {
      throw new Error('Invalid credentials');
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      throw new Error('Invalid credentials');
    }

    // Update last login
    user.lastLogin = new Date().toISOString();
    await this._saveUser(user);

    // Generate JWT token
    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role
      },
      this.jwtSecret,
      { expiresIn: this.sessionTimeout }
    );

    return {
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    };
  }

  /**
   * Verify JWT token
   * @param {string} token - JWT token to verify
   * @returns {Promise<Object>} Decoded token payload
   */
  verifyToken(token) {
    try {
      return jwt.verify(token, this.jwtSecret);
    } catch (error) {
      throw new Error('Invalid or expired token');
    }
  }

  /**
   * Logout user (invalidate session)
   * @param {string} token - JWT token to invalidate
   * @returns {Promise<void>}
   */
  async logout(token) {
    // In a real implementation, we might add to a blacklist
    // For now, we'll just return as JWTs are stateless
    return true;
  }

  /**
   * Get user profile
   * @param {string} username - Username to get profile for
   * @returns {Promise<Object>} User profile
   */
  async getProfile(username) {
    const user = await this._getUser(username);
    if (!user) {
      throw new Error('User not found');
    }

    return {
      id: user.id,
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin
    };
  }

  /**
   * Update user profile
   * @param {string} username - Username to update
   * @param {Object} updates - Profile updates
   * @returns {Promise<Object>} Updated profile
   */
  async updateProfile(username, updates) {
    const user = await this._getUser(username);
    if (!user) {
      throw new Error('User not found');
    }

    // Update fields
    Object.assign(user, updates);
    user.updatedAt = new Date().toISOString();

    await this._saveUser(user);

    return {
      id: user.id,
      username: user.username,
      role: user.role,
      updatedAt: user.updatedAt
    };
  }

  /**
   * Change user password
   * @param {string} username - Username to change password for
   * @param {string} oldPassword - Current password
   * @param {string} newPassword - New password
   * @returns {Promise<boolean>} Success status
   */
  async changePassword(username, oldPassword, newPassword) {
    const user = await this._getUser(username);
    if (!user) {
      throw new Error('User not found');
    }

    const isValid = await bcrypt.compare(oldPassword, user.password);
    if (!isValid) {
      throw new Error('Current password is incorrect');
    }

    // Hash and update password
    user.password = await bcrypt.hash(newPassword, 10);
    user.updatedAt = new Date().toISOString();

    await this._saveUser(user);

    return true;
  }

  /**
   * Get user by username
   * @private
   */
  async _getUser(username) {
    try {
      const usersData = await fs.readFile(this.usersFile, 'utf8');
      const users = JSON.parse(usersData);
      return users.find(user => user.username === username);
    } catch (error) {
      // If file doesn't exist or is empty, return null
      return null;
    }
  }

  /**
   * Save user to storage
   * @private
   */
  async _saveUser(user) {
    let users = [];
    try {
      const usersData = await fs.readFile(this.usersFile, 'utf8');
      users = JSON.parse(usersData);
    } catch (error) {
      // File doesn't exist, start with empty array
    }

    // Update existing user or add new one
    const existingIndex = users.findIndex(u => u.username === user.username);
    if (existingIndex >= 0) {
      users[existingIndex] = user;
    } else {
      users.push(user);
    }

    await fs.writeFile(this.usersFile, JSON.stringify(users, null, 2));
  }

  /**
   * Generate unique ID
   * @private
   */
  _generateId() {
    return Math.random().toString(36).substr(2, 9);
  }
}

module.exports = AuthManager;