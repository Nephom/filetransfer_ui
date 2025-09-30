// Authentication system implementation
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const ConfigManager = require('../config/config');

class Auth {
  constructor() {
    this.secret = process.env.JWT_SECRET;
  }

  async hashPassword(password) {
    const saltRounds = 10;
    return await bcrypt.hash(password, saltRounds);
  }

  async comparePassword(password, hashedPassword) {
    return await bcrypt.compare(password, hashedPassword);
  }

  generateToken(user) {
    const payload = {
      id: user.id,
      username: user.username
    };

    return jwt.sign(payload, this.secret, { expiresIn: '24h' });
  }

  verifyToken(token) {
    try {
      return jwt.verify(token, this.secret);
    } catch (error) {
      throw new Error('Invalid token');
    }
  }

  async authenticateUser(username, password) {
    // In a real app, this would check against a database
    const config = ConfigManager.getAll();

    if (username === config.username) {
      let isValidPassword = false;

      if (config.passwordHashed === 'true') {
        isValidPassword = await this.comparePassword(password, config.password);
      } else {
        // If password is not hashed, it is considered invalid for security reasons.
        isValidPassword = false;
      }

      if (isValidPassword) {
        return {
          id: 1,
          username: username
        };
      }
    }

    throw new Error('Invalid credentials');
  }

  async registerUser(username, password) {
    // In a real app, this would create a new user in the database
    const hashedPassword = await this.hashPassword(password);

    // For demo purposes, we'll just validate the credentials
    if (!username || !password) {
      throw new Error('Username and password required');
    }

    // In a real implementation, we'd save the user to a database
    return { success: true };
  }
}

module.exports = new Auth();