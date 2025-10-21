/**
 * User Management System
 * Handles CRUD operations for user accounts
 */

const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const configManager = require('../config');
const { systemLogger } = require('../utils/logger');

class UserManager {
  constructor() {
    this.usersFilePath = path.join(__dirname, '../../users.json');
    this.saltRounds = 12;
    this.users = new Map();
    this.initialized = false;
  }

  /**
   * Initialize user manager and load existing users
   */
  async initialize() {
    try {
      await this.loadUsers();

      // Remove admin user from users.json if it exists (admin should only be in config.ini)
      if (this.users.has('admin')) {
        systemLogger.logSystem('INFO', 'Removing admin user from users.json (admin is managed by config.ini)');
        this.users.delete('admin');
        await this.saveUsers();
      }

      // Also remove 'root' user if it exists (redundant admin account)
      if (this.users.has('root')) {
        systemLogger.logSystem('INFO', 'Removing root user from users.json (use admin from config.ini instead)');
        this.users.delete('root');
        await this.saveUsers();
      }

      this.initialized = true;
      const configUsername = configManager.get('auth.username') || 'admin';
      systemLogger.logSystem('INFO', `User manager initialized with ${this.users.size} users (excluding config admin: ${configUsername})`);
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to initialize user manager: ${error.message}`);
      this.initialized = true;
    }
  }

  /**
   * Load users from storage file
   */
  async loadUsers() {
    try {
      const data = await fs.readFile(this.usersFilePath, 'utf8');
      const userData = JSON.parse(data);

      // Convert array to Map for better performance
      this.users.clear();
      userData.users.forEach(user => {
        this.users.set(user.username, user);
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, create initial empty file
        systemLogger.logSystem('INFO', 'users.json not found, creating new file');
        this.users.clear();
        await this.saveUsers();
      } else {
        // File exists but is corrupted, start fresh
        systemLogger.logSystem('WARN', `Error loading users file: ${error.message}`);
        this.users.clear();
        await this.saveUsers();
      }
    }
  }

  /**
   * Save users to storage file
   */
  async saveUsers() {
    try {
      const userData = {
        lastUpdated: new Date().toISOString(),
        users: Array.from(this.users.values())
      };

      await fs.writeFile(this.usersFilePath, JSON.stringify(userData, null, 2));
    } catch (error) {
      systemLogger.logSystem('ERROR', `Failed to save users: ${error.message}`);
      throw new Error('Failed to save user data');
    }
  }

  /**
   * Create default admin user (DEPRECATED - admin is now in config.ini)
   * This method is kept for backward compatibility but does nothing
   */
  async createDefaultAdmin() {
    systemLogger.logSystem('INFO', 'Note: Admin user is managed by config.ini, not users.json');
    // Do nothing - admin is managed through config.ini
  }

  /**
   * Create a new user
   */
  async createUser({ username, password, email, role = 'user', permissions = [] }) {
    if (!this.initialized) {
      throw new Error('User manager not initialized');
    }

    // Validate input
    if (!username || username.length < 3) {
      throw new Error('Username must be at least 3 characters long');
    }

    if (!password || password.length < 6) {
      throw new Error('Password must be at least 6 characters long');
    }

    // Prevent creating admin or config username
    const configUsername = configManager.get('auth.username') || 'admin';
    if (username === configUsername || username === 'admin' || username === 'root') {
      throw new Error(`Cannot create user '${username}' - this username is reserved for system admin (managed in config.ini)`);
    }

    if (this.users.has(username)) {
      throw new Error(`User '${username}' already exists`);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, this.saltRounds);

    // Generate unique ID
    const id = this.users.size + 1;

    // Set default permissions based on role
    // Note: Only 'user' role is allowed for users.json accounts
    if (role === 'admin') {
      throw new Error('Cannot create admin users through this interface. Admin is managed in config.ini');
    }

    if (permissions.length === 0) {
      permissions = ['read', 'upload', 'delete'];
    }

    const newUser = {
      id,
      username,
      password: hashedPassword,
      email: email || `${username}@localhost`,
      role: 'user', // Force role to be 'user'
      permissions,
      active: true,
      created: new Date().toISOString(),
      lastLogin: null
    };

    this.users.set(username, newUser);
    await this.saveUsers();

    // Return user without password
    const { password: _, ...userResponse } = newUser;
    return userResponse;
  }

  /**
   * Update an existing user
   */
  async updateUser(username, updates) {
    if (!this.initialized) {
      throw new Error('User manager not initialized');
    }

    // Prevent updating admin user (managed in config.ini)
    const configUsername = configManager.get('auth.username') || 'admin';
    if (username === configUsername || username === 'admin') {
      throw new Error('Cannot update admin user through this interface. Admin is managed in config.ini');
    }

    const user = this.users.get(username);
    if (!user) {
      throw new Error(`User '${username}' not found`);
    }

    // Prevent role escalation to admin
    if (updates.role === 'admin') {
      throw new Error('Cannot change user role to admin. Admin is managed in config.ini');
    }

    // Handle password change
    if (updates.password) {
      if (updates.password.length < 6) {
        throw new Error('Password must be at least 6 characters long');
      }
      updates.password = await bcrypt.hash(updates.password, this.saltRounds);
    }

    // Update user
    const updatedUser = {
      ...user,
      ...updates,
      role: 'user', // Ensure role stays as 'user'
      updated: new Date().toISOString()
    };

    this.users.set(username, updatedUser);
    await this.saveUsers();

    // Return user without password
    const { password: _, ...userResponse } = updatedUser;
    return userResponse;
  }

  /**
   * Delete a user
   */
  async deleteUser(username) {
    if (!this.initialized) {
      throw new Error('User manager not initialized');
    }

    // Prevent deleting admin user (managed in config.ini)
    const configUsername = configManager.get('auth.username') || 'admin';
    if (username === configUsername || username === 'admin' || username === 'root') {
      throw new Error('Cannot delete admin user. Admin is managed in config.ini');
    }

    const user = this.users.get(username);
    if (!user) {
      throw new Error(`User '${username}' not found`);
    }

    this.users.delete(username);
    await this.saveUsers();

    return { message: `User '${username}' deleted successfully` };
  }

  /**
   * Get all users (without passwords)
   * Includes the config admin user from config.ini
   */
  async getAllUsers() {
    if (!this.initialized) {
      throw new Error('User manager not initialized');
    }

    // Get users from users.json (excluding any admin entries)
    const regularUsers = Array.from(this.users.values())
      .filter(user => user.username !== 'admin' && user.username !== 'root')
      .map(user => {
        const { password, ...userResponse } = user;
        return userResponse;
      });

    // Add the config admin user
    const configUsername = configManager.get('auth.username') || 'admin';
    const configAdmin = {
      id: 0,
      username: configUsername,
      email: `${configUsername}@localhost`,
      role: 'admin',
      permissions: ['all'],
      active: true,
      created: 'System Default',
      lastLogin: null,
      isConfigUser: true // Flag to indicate this is from config.ini
    };

    // Return config admin first, then regular users
    return [configAdmin, ...regularUsers];
  }

  /**
   * Get a specific user by username
   */
  async getUser(username) {
    if (!this.initialized) {
      throw new Error('User manager not initialized');
    }

    const user = this.users.get(username);
    if (!user) {
      return null;
    }

    const { password, ...userResponse } = user;
    return userResponse;
  }

  /**
   * Authenticate user credentials
   */
  async authenticateUser(username, password) {
    if (!this.initialized) {
      throw new Error('User manager not initialized');
    }

    const configUsername = configManager.get('auth.username');

    // If authenticating the admin user, use config.ini as the source of truth.
    if (username === configUsername) {
        const configPassword = configManager.get('auth.password');
        const passwordHashed = configManager.get('auth.passwordHashed');

        let isValid = false;
        if (passwordHashed === true || passwordHashed === 'true') {
            isValid = await bcrypt.compare(password, configPassword);
        } else {
            isValid = (password === configPassword);
        }

        if (isValid) {
            // Password is valid according to config.ini.
            // Return admin user WITHOUT saving to users.json
            const user = {
                id: 0,
                username: configUsername,
                role: 'admin',
                active: true,
                email: `${configUsername}@localhost`,
                permissions: ['all'],
                lastLogin: new Date().toISOString(),
                isConfigUser: true
            };

            return user;
        } else {
            // If password for config admin is incorrect, fail immediately.
            return null;
        }
    }

    // For any other user, use the standard users.json logic.
    const user = this.users.get(username);
    if (!user || !user.active) {
      return null;
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return null;
    }

    // Update last login
    user.lastLogin = new Date().toISOString();
    this.users.set(username, user);
    await this.saveUsers();

    // Return user without password
    const { password: _, ...userResponse } = user;
    return userResponse;
  }

  /**
   * Change user password
   */
  async changePassword(username, currentPassword, newPassword) {
    if (!this.initialized) {
      throw new Error('User manager not initialized');
    }

    const user = this.users.get(username);
    if (!user) {
      throw new Error('User not found');
    }

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      throw new Error('Current password is incorrect');
    }

    // Validate new password
    if (!newPassword || newPassword.length < 6) {
      throw new Error('New password must be at least 6 characters long');
    }

    // Hash and update password
    const hashedPassword = await bcrypt.hash(newPassword, this.saltRounds);
    user.password = hashedPassword;
    user.passwordChanged = new Date().toISOString();

    this.users.set(username, user);
    await this.saveUsers();

    return { message: 'Password changed successfully' };
  }

  /**
   * Get user statistics
   */
  async getUserStats() {
    if (!this.initialized) {
      throw new Error('User manager not initialized');
    }

    const users = Array.from(this.users.values());
    
    return {
      total: users.length,
      active: users.filter(u => u.active).length,
      inactive: users.filter(u => !u.active).length,
      admins: users.filter(u => u.role === 'admin').length,
      regularUsers: users.filter(u => u.role === 'user').length,
      recentLogins: users.filter(u => {
        if (!u.lastLogin) return false;
        const lastLogin = new Date(u.lastLogin);
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        return lastLogin > weekAgo;
      }).length
    };
  }
}

module.exports = UserManager;