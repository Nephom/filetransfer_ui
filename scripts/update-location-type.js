const fs = require('node:fs').promises;
const path = require('node:path');

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    values[key.slice(2)] = argv[++index];
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(__dirname, '..');
  const configFile = path.resolve(rootDir, args.config || 'src/config.ini');
  const backupDir = path.resolve(rootDir, args['backup-dir'] || 'data/backups');
  const locationId = String(args.location || '');
  const storageType = String(args.type || '');
  if (!locationId || !['local', 'nfs'].includes(storageType)) {
    throw new Error('Usage: node scripts/update-location-type.js --location <id> --type local|nfs [--config path]');
  }

  const original = await fs.readFile(configFile, 'utf8');
  const lines = original.split(/\r?\n/);
  let changed = false;
  const updated = lines.map((line) => {
    if (!/^definitions\s*=/.test(line.trim())) return line;
    const definitions = JSON.parse(line.slice(line.indexOf('=') + 1).trim());
    if (!Array.isArray(definitions)) throw new Error('[locations] definitions must be a JSON array');
    const matches = definitions.filter((location) => location?.id === locationId);
    if (matches.length !== 1) throw new Error(`Location not found or not unique: ${locationId}`);
    const next = definitions.map((location) => location.id === locationId ? { ...location, storageType } : location);
    changed = JSON.stringify(next) !== JSON.stringify(definitions);
    return `definitions=${JSON.stringify(next)}`;
  });

  if (!changed) {
    console.log(`Location ${locationId} is already ${storageType}.`);
    return;
  }

  const stat = await fs.stat(configFile);
  await fs.mkdir(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `config.ini.before-location-type.${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.copyFile(configFile, backupFile);
  const temporary = `${configFile}.location-type-${process.pid}.tmp`;
  await fs.writeFile(temporary, updated.join('\n'), { mode: stat.mode & 0o777 });
  await fs.rename(temporary, configFile);
  console.log(`Updated Location ${locationId} to ${storageType}.`);
  console.log(`Previous configuration backup: ${backupFile}`);
}

main().catch((error) => {
  console.error(`Location type update failed: ${error.message}`);
  process.exitCode = 1;
});
