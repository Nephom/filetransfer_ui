const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ConfigManager = require('./index').constructor;

const AI_ENVIRONMENT_KEYS = ['AI_API_KEY', 'AI_ENABLED', 'AI_MODEL', 'AI_PROVIDER', 'AI_BASE_URL'];

test('AI config keeps startup safe without a key, falls back from blank env key, and round-trips model lists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'filetransfer-ai-config-'));
  const previousEnvironment = Object.fromEntries(AI_ENVIRONMENT_KEYS.map(key => [key, process.env[key]]));
  for (const key of AI_ENVIRONMENT_KEYS) delete process.env[key];
  process.env.AI_API_KEY = '';

  try {
    const configPath = path.join(root, 'config.ini');
    const storagePath = path.join(root, 'storage');
    const secret = 'fixture-jwt-secret-at-least-16-chars';
    await fs.writeFile(configPath, [
      '[fileSystem]',
      `storagePath=${storagePath}`,
      '[security]',
      `jwtSecret=${secret}`,
      '[ai]',
      'enabled=true',
      'baseUrl=http://127.0.0.1:11434/v1',
      'apiKey=config-file-key',
      'model=legacy-model'
    ].join('\n'));

    const manager = new ConfigManager({ configFile: configPath });
    await manager.load();
    assert.equal(manager.get('ai.apiKey'), 'config-file-key', 'a blank .env key must not mask the config.ini key');
    assert.deepEqual(manager.get('ai.models'), ['legacy-model'], 'older single-model configuration is migrated');

    process.env.AI_API_KEY = ' environment-key ';
    await manager.load();
    assert.equal(manager.get('ai.apiKey'), 'environment-key', 'environment keys are normalized before becoming effective');
    process.env.AI_API_KEY = '';
    await manager.load();
    assert.equal(manager.get('ai.apiKey'), 'config-file-key', 'the config.ini key is restored when the environment key is blank');

    manager.set('ai.models', ['model-a', 'model-b']);
    manager.set('ai.model', 'model-b');
    await manager.save();
    let parsed = manager._parseIniFile(await fs.readFile(configPath, 'utf8'));
    assert.deepEqual(parsed.ai.models, ['model-a', 'model-b']);
    assert.equal(parsed.ai.model, 'model-b');

    manager.set('ai.models', []);
    manager.set('ai.model', '');
    await manager.save();
    parsed = manager._parseIniFile(await fs.readFile(configPath, 'utf8'));
    assert.deepEqual(parsed.ai.models, []);
    assert.equal(parsed.ai.model, '', 'removing the final model remains empty after persistence');

    const noKeyPath = path.join(root, 'without-key.ini');
    await fs.writeFile(noKeyPath, [
      '[fileSystem]',
      `storagePath=${storagePath}`,
      '[security]',
      `jwtSecret=${secret}`,
      '[ai]',
      'enabled=true',
      'baseUrl=http://127.0.0.1:11434/v1'
    ].join('\n'));
    const noKeyManager = new ConfigManager({ configFile: noKeyPath });
    await assert.doesNotReject(noKeyManager.load(), 'missing AI credentials must not prevent server startup');
    assert.equal(noKeyManager.get('ai.apiKey'), '');
  } finally {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
