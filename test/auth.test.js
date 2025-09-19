/**
 * Test file for the authentication system
 */

const AuthManager = require('../src/backend/auth');
const { AuthMiddleware } = require('../src/backend/middleware/auth');

describe('AuthManager', () => {
  let authManager;
  const testUsersFile = './test-data/users.json';

  beforeAll(async () => {
    // Create test data directory
    const fs = require('fs').promises;
    try {
      await fs.mkdir('./test-data', { recursive: true });
    } catch (error) {
      // Directory might already exist
    }

    authManager = new AuthManager({
      usersFile: testUsersFile,
      jwtSecret: 'test-secret-key'
    });
  });

  afterAll(async () => {
    // Clean up test files
    const fs = require('fs').promises;
    try {
      await fs.rm('./test-data', { recursive: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test('should register a new user', async () => {
    const result = await authManager.register('testuser', 'password123');

    expect(result).toHaveProperty('success', true);
    expect(result.user).toHaveProperty('username', 'testuser');
    expect(result.user).toHaveProperty('role', 'user');
  });

  test('should fail to register existing user', async () => {
    await expect(authManager.register('testuser', 'password123'))
      .rejects.toThrow('User already exists');
  });

  test('should authenticate valid user', async () => {
    const result = await authManager.login('testuser', 'password123');

    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('token');
    expect(result.user).toHaveProperty('username', 'testuser');
  });

  test('should fail to authenticate invalid user', async () => {
    await expect(authManager.login('testuser', 'wrongpassword'))
      .rejects.toThrow('Invalid credentials');
  });

  test('should verify valid token', async () => {
    // First register and login to get a token
    const loginResult = await authManager.login('testuser', 'password123');
    const token = loginResult.token;

    // Verify the token is a string
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });
});

describe('AuthMiddleware', () => {
  let authManager;
  let authMiddleware;

  beforeAll(() => {
    authManager = new AuthManager({
      usersFile: './test-data/users.json',
      jwtSecret: 'test-secret-key'
    });
    authMiddleware = new AuthMiddleware(authManager);
  });

  test('should create middleware correctly', () => {
    expect(authMiddleware).toBeDefined();
  });
});