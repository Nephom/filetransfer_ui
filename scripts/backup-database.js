#!/usr/bin/env node

const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const destination = process.argv[2];
if (!destination) {
  console.error('Usage: node scripts/backup-database.js <destination>');
  process.exit(2);
}

const source = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'app.db');
const database = new sqlite3.Database(source, (error) => {
  if (error) {
    console.error(`Database backup failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  database.run('VACUUM INTO ?', [path.resolve(destination)], (vacuumError) => {
    database.close((closeError) => {
      const failure = vacuumError || closeError;
      if (failure) {
        console.error(`Database backup failed: ${failure.message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Database backup created: ${path.resolve(destination)}`);
    });
  });
});
