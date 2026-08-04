#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const DEFAULT_LEGACY_VERSION = '3.1.1';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    args[key] = argv[index + 1] && !argv[index + 1].startsWith('--')
      ? argv[++index]
      : true;
  }
  return args;
}

function parseVersion(value) {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    preRelease: match[4] || ''
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (!a.preRelease && b.preRelease) return 1;
  if (a.preRelease && !b.preRelease) return -1;
  return a.preRelease.localeCompare(b.preRelease);
}

function parseIni(content) {
  const sections = new Map();
  let section = '';
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (!sections.has(section)) sections.set(section, new Map());
      continue;
    }
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex <= 0) continue;
    const key = trimmed.slice(0, equalIndex).trim();
    const value = trimmed.slice(equalIndex + 1).trim();
    if (!sections.has(section)) sections.set(section, new Map());
    sections.get(section).set(key, value);
  }
  return sections;
}

function getValue(sections, section, key) {
  return sections.get(section)?.get(key);
}

function setValue(sections, section, key, value) {
  if (!sections.has(section)) sections.set(section, new Map());
  sections.get(section).set(key, value);
}

function getConfigVersion(sections) {
  return getValue(sections, 'meta', 'configVersion') || DEFAULT_LEGACY_VERSION;
}

function parseTemplate(template) {
  const sections = parseIni(template);
  const keys = new Set();
  // The example intentionally keeps definitions commented so setup does not
  // create a Location pointing at an unknown deployment path.
  keys.add('locations\u0000definitions');
  for (const [section, values] of sections) {
    for (const key of values.keys()) keys.add(`${section}\u0000${key}`);
  }
  return { sections, keys };
}

function isSensitive(section, key) {
  return section === 'auth' && key === 'password'
    || section === 'security' && ['jwtSecret', 'secret'].includes(key)
    || /password|secret|token|privatekey/i.test(key);
}

function displayValue(section, key, value) {
  return isSensitive(section, key) ? '[hidden]' : value;
}

function getLocationDefinitions(sections) {
  const raw = getValue(sections, 'locations', 'definitions');
  if (!raw) return null;
  try {
    const locations = JSON.parse(raw);
    return Array.isArray(locations) ? locations : null;
  } catch {
    return null;
  }
}

function needsLocationTypeMigration(sections) {
  const locations = getLocationDefinitions(sections);
  return Array.isArray(locations) && locations.some((location) => !location?.storageType);
}

function formatIni(template, values, deprecated) {
  const output = [];
  let section = '';
  const emittedSections = new Set();
  let hasLocationsDefinitions = false;

  for (const line of template.split(/\r?\n/)) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const locations = values.get('locations\u0000definitions');
      if (section === 'locations' && !hasLocationsDefinitions && locations !== undefined) {
        output.push(`definitions=${locations}`);
        hasLocationsDefinitions = true;
      }
      section = sectionMatch[1].trim();
      emittedSections.add(section);
      output.push(line);
      continue;
    }

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex > 0 && !trimmed.startsWith('#') && !trimmed.startsWith(';')) {
      const key = trimmed.slice(0, equalIndex).trim();
      const value = values.get(`${section}\u0000${key}`);
      if (section === 'locations' && key === 'definitions') hasLocationsDefinitions = true;
      output.push(value === undefined ? line : `${key}=${value}`);
    } else {
      output.push(line);
    }
  }

  if (!emittedSections.has('meta')) {
    output.unshift('[meta]', `configVersion=${values.get('meta\u0000configVersion')}`, '');
  }

  const locations = values.get('locations\u0000definitions');
  if (locations !== undefined && !hasLocationsDefinitions) {
    if (section === 'locations') {
      output.push(`definitions=${locations}`);
    } else {
      output.push('', '[locations]', 'definitions=' + locations);
    }
  }

  if (deprecated.length > 0) {
    output.push('', '# Deprecated configuration retained for reference.');
    for (const item of deprecated) {
      output.push(`# [${item.section}] ${item.key}=${item.value}`);
      if (item.replacement) output.push(`# Replacement: ${item.replacement}`);
      if (item.reason) output.push(`# Reason: ${item.reason}`);
    }
  }

  return `${output.join('\n').replace(/\n+$/, '')}\n`;
}

async function ask(rl, question, defaultAnswer = 'y') {
  const suffix = defaultAnswer === 'y' ? ' [Y/n]' : ' [y/N]';
  const answer = (await rl.question(`${question}${suffix} `)).trim().toLowerCase();
  if (!answer) return defaultAnswer === 'y';
  return answer === 'y' || answer === 'yes';
}

async function chooseValue(rl, section, key, currentValue, newValue) {
  console.log(`\nConfiguration value differs: [${section}] ${key}`);
  console.log(`  Current: ${displayValue(section, key, currentValue)}`);
  console.log(`  New default: ${displayValue(section, key, newValue)}`);
  while (true) {
    const answer = (await rl.question('  Keep current [k], use new [n], or edit [e]? [k] ')).trim().toLowerCase();
    if (!answer || answer === 'k' || answer === 'keep') return currentValue;
    if (answer === 'n' || answer === 'new') return newValue;
    if (answer === 'e' || answer === 'edit') {
      const edited = await rl.question(`  New value${isSensitive(section, key) ? ' (hidden input is not supported)' : ''}: `);
      return edited;
    }
    console.log('  Please choose k, n, or e.');
  }
}

async function migrate({ configFile, templateFile, targetVersion, backupDir, nonInteractive = false }) {
  const oldContent = await fsp.readFile(configFile, 'utf8');
  const template = await fsp.readFile(templateFile, 'utf8');
  const oldSections = parseIni(oldContent);
  const { sections: templateSections, keys: templateKeys } = parseTemplate(template);
  const currentVersion = getConfigVersion(oldSections);
  const comparison = compareVersions(currentVersion, targetVersion);

  if (comparison === null) throw new Error(`Unsupported config version: ${currentVersion}`);
  if (comparison >= 0 && !needsLocationTypeMigration(oldSections)) {
    console.log(`Configuration is already at ${currentVersion}.`);
    return false;
  }

  const rl = nonInteractive ? null : readline.createInterface({ input: stdin, output: stdout });
  try {
    const values = new Map();
    for (const [section, entries] of templateSections) {
      for (const [key, defaultValue] of entries) {
        const oldValue = getValue(oldSections, section, key);
        if (oldValue !== undefined) {
          const value = !nonInteractive && section !== 'meta' && oldValue !== defaultValue
            ? await chooseValue(rl, section, key, oldValue, defaultValue)
            : oldValue;
          values.set(`${section}\u0000${key}`, value);
        } else {
          values.set(`${section}\u0000${key}`, defaultValue);
          if (!nonInteractive && section !== 'meta') {
            console.log(`\nNew configuration option [${section}] ${key}`);
            console.log(`  New default: ${displayValue(section, key, defaultValue)}`);
            const answer = await rl.question('  Use this default, or enter a replacement value [default]: ');
            if (answer.trim()) values.set(`${section}\u0000${key}`, answer.trim());
          }
        }
      }
    }

    const oldEntries = [];
    for (const [section, entries] of oldSections) {
      for (const [key, value] of entries) {
        if (!templateKeys.has(`${section}\u0000${key}`) && !(section === 'fileSystem' && key === 'storagePath')) {
          oldEntries.push({ section, key, value, reason: 'This option is not part of the 3.2.0 configuration schema.' });
        }
      }
    }

    const oldLocations = getValue(oldSections, 'locations', 'definitions');
    if (oldLocations) {
      try {
        const locations = JSON.parse(oldLocations);
        const globalStorageType = getValue(oldSections, 'fileSystem', 'type');
        const migratedLocations = Array.isArray(locations)
          ? locations.map((location) => location?.storageType ? location : { ...location, storageType: globalStorageType === 'nfs' ? 'nfs' : 'local' })
          : locations;
        values.set('locations\u0000definitions', JSON.stringify(migratedLocations));
      } catch {
        values.set('locations\u0000definitions', oldLocations);
      }
    }
    const oldStoragePath = getValue(oldSections, 'fileSystem', 'storagePath');
    const hasLocations = Boolean(getLocationDefinitions(oldSections));
    if (oldStoragePath) {
      if (!hasLocations) {
        values.set('locations\u0000definitions', JSON.stringify([{
          id: 'default',
          displayName: 'Default',
          rootPath: oldStoragePath,
          storageType: getValue(oldSections, 'fileSystem', 'type') === 'nfs' ? 'nfs' : 'local',
          enabled: true,
          readOnly: false,
          order: 0
        }]));
      }
      oldEntries.push({
        section: 'fileSystem',
        key: 'storagePath',
        value: oldStoragePath,
        replacement: '[locations] definitions (default.rootPath)',
        reason: 'Locations are now the canonical source for server-side roots.'
      });
    }

    if (oldEntries.length > 0 && !nonInteractive) {
      console.log('\nDeprecated or removed configuration:');
      for (const item of oldEntries) {
        console.log(`  [${item.section}] ${item.key}=${displayValue(item.section, item.key, item.value)}`);
        if (item.replacement) console.log(`    Replacement: ${item.replacement}`);
        console.log(`    ${item.reason}`);
      }
      const proceed = await ask(rl, 'Continue and comment these options in config.ini?', 'y');
      if (!proceed) throw new Error('Configuration upgrade cancelled by user.');
    }

    values.set('meta\u0000configVersion', targetVersion);
    const backupPath = path.join(backupDir, `config.ini.${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await fsp.mkdir(backupDir, { recursive: true });
    await fsp.copyFile(configFile, backupPath);
    const deprecated = oldEntries.map((item) => ({
      ...item,
      value: displayValue(item.section, item.key, item.value)
    }));
    const updated = formatIni(template, values, deprecated);
    const temporary = `${configFile}.upgrade-${process.pid}.tmp`;
    await fsp.writeFile(temporary, updated, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(temporary, configFile);
    console.log(`Configuration upgraded from ${currentVersion} to ${targetVersion}.`);
    console.log(`Previous configuration backup: ${backupPath}`);
    return true;
  } finally {
    rl?.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(args.root || path.join(__dirname, '..'));
  const configFile = path.resolve(args.config || path.join(rootDir, 'src/config.ini'));
  const templateFile = path.resolve(args.template || path.join(rootDir, 'src/config.ini.example'));
  const targetVersion = String(args['target-version'] || require(path.join(rootDir, 'package.json')).version);
  const backupDir = path.resolve(args['backup-dir'] || path.join(rootDir, 'data/backups'));

  if (args['print-version']) {
    if (!fs.existsSync(configFile)) {
      console.log('missing');
    } else {
      console.log(getConfigVersion(parseIni(await fsp.readFile(configFile, 'utf8'))));
    }
    return;
  }

  if (args['needs-upgrade']) {
    if (!fs.existsSync(configFile)) {
      console.log('no');
      return;
    }
    const currentVersion = getConfigVersion(parseIni(await fsp.readFile(configFile, 'utf8')));
    const comparison = compareVersions(currentVersion, targetVersion);
    if (comparison === null) throw new Error(`Unsupported config version: ${currentVersion}`);
    console.log(comparison < 0 || needsLocationTypeMigration(parseIni(await fsp.readFile(configFile, 'utf8'))) ? 'yes' : 'no');
    return;
  }

  if (!fs.existsSync(configFile)) {
    throw new Error(`Configuration file not found: ${configFile}`);
  }
  await migrate({
    configFile,
    templateFile,
    targetVersion,
    backupDir,
    nonInteractive: Boolean(args['non-interactive'])
  });
}

main().catch((error) => {
  console.error(`Configuration upgrade failed: ${error.message}`);
  process.exitCode = 1;
});
