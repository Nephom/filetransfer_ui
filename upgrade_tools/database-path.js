#!/usr/bin/env node

const { resolveDatabasePath } = require('../src/backend/database/path');

if (require.main === module) {
  console.log(resolveDatabasePath());
}

module.exports = { resolveDatabasePath };
