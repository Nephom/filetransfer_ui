#!/usr/bin/env node

const dependencies = ['bcrypt', 'sqlite3', 'ssh2', 'ws'];

for (const dependency of dependencies) {
  try {
    require(dependency);
  } catch (error) {
    console.error(`Native dependency check failed for ${dependency}: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.exitCode !== 1) {
  console.log(`Native dependencies loaded: ${dependencies.join(', ')}`);
}
