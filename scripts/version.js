const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');

function readValue(fileName) {
  try {
    return fs.readFileSync(path.join(rootDir, fileName), 'utf8').trim();
  } catch {
    return '';
  }
}

function getCommit() {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT.trim();
  try {
    return childProcess.execFileSync('git', ['-C', rootDir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

function getVersion() {
  const baseVersion = readValue('VERSION');
  const commit = getCommit();
  const releaseDate = readValue('RELEASE_DATE');
  const version = baseVersion ? (commit ? `${baseVersion}-${commit}` : baseVersion) : commit;
  return { baseVersion, commit, releaseDate, version, display: version ? (releaseDate ? `${version} (${releaseDate})` : version) : '' };
}

if (require.main === module) process.stdout.write(`${JSON.stringify(getVersion())}\n`);

module.exports = { getVersion };
