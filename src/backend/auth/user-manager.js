/**
 * User Management System
 * Handles CRUD operations for user accounts
 */

const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

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
      
      // Ensure admin user exists
      if (!this.users.has('admin')) {
        await this.createDefaultAdmin();
      }
      
      this.initialized = true;
      console.log(`User manager initialized with ${this.users.size} users`);
    } catch (error) {
      console.error('Failed to initialize user manager:', error);
      // Create default admin as fallback
      await this.createDefaultAdmin();
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
      if (error.code !== 'ENOENT') {
        console.warn('Error loading users file:', error);
      }
      // File doesn't exist or is corrupted, start fresh
      this.users.clear();
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
      console.error('Failed to save users:', error);
      throw new Error('Failed to save user data');
    }
  }

  /**
   * Create default admin user
   */
  async createDefaultAdmin() {
    const hashedPassword = await bcrypt.hash('password', this.saltRounds);
    const adminUser = {
      id: 1,
      username: 'admin',
      password: hashedPassword,
      role: 'admin',
      active: true,
      created: new Date().toISOString(),
      lastLogin: null,
      email: 'admin@localhost',
      permissions: ['all']
    };
    
    this.users.set('admin', adminUser);
    await this.saveUsers();
    console.log('Default admin user created');
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
    
    if (this.users.has(username)) {
      throw new Error(`User '${username}' already exists`);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, this.saltRounds);
    
    // Generate unique ID
    const id = this.users.size + 1;
    
    // Set default permissions based on role
    if (permissions.length === 0) {
      permissions = role === 'admin' ? ['all'] : ['read', 'upload'];
    }

    const newUser = {
      id,
      username,
      password: hashedPassword,
      email: email || `${username}@localhost`,
      role,
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

    const user = this.users.get(username);
    if (!user) {
      throw new Error(`User '${username}' not found`);
    }

    // Prevent admin from being disabled
    if (username === 'admin' && updates.active === false) {
      throw new Error('Cannot disable the admin user');
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

    if (username === 'admin') {
      throw new Error('Cannot delete the admin user');
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
   */
  async getAllUsers() {
    if (!this.initialized) {
      throw new Error('User manager not initialized');
    }

    return Array.from(this.users.values()).map(user => {
      const { password, ...userResponse } = user;
      return userResponse;
    });
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