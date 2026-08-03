#!/usr/bin/env node

const database = require('../src/backend/database/db');

database.initialize()
  .then(async () => {
    console.log(`Database migrations applied: ${database.dbPath}`);
    await database.close();
  })
  .catch(async (error) => {
    console.error(`Database migration failed: ${error.message}`);
    await database.close();
    process.exitCode = 1;
  });
