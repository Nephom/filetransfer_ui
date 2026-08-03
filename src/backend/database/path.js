const path = require('node:path');

function resolveDatabasePath({ rootDir = path.resolve(__dirname, '../../..'), value = process.env.DATABASE_PATH } = {}) {
  const configured = value || path.join('src', 'data', 'app.db');
  return path.resolve(rootDir, configured);
}

module.exports = { resolveDatabasePath };
