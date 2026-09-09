const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { SystemLogger, redactUrl, redactLogData } = require('./logger');

test('logger import performs no mkdir or appendFile operations', () => {
  const mkdir = fs.mkdir;
  const appendFile = fs.appendFile;
  fs.mkdir = fs.appendFile = () => { throw new Error('Import must not write'); };
  try {
    delete require.cache[require.resolve('./logger')];
    require('./logger');
  } finally {
    fs.mkdir = mkdir;
    fs.appendFile = appendFile;
  }
});

test('URL redaction handles encoded and malformed share/handoff paths and query values', () => {
  for (const url of [
    '/api/share/path-sentinel/download?password=query-sentinel',
    '/api/files/share/path-sentinel/info?unknown=query-sentinel',
    '/api/admin/share-links/path-sentinel/history',
    '/auth/browser-handoff/path-sentinel',
    '/api/%73hare%2fpath-sentinel/download?pass%77ord=query-sentinel',
    '%2Fauth%2Fbrowser-handoff%2Fpath-sentinel?bad=%E0%A4%A&token=query-sentinel',
    'http://user:query-sentinel@example.test/share.html?token=path-sentinel#query-sentinel',
    '/api/share/path-sentinel/download?password=query-sentinel%26extra=query-sentinel',
    '/api/share/path-sentinel/download?password=%26query-sentinel%3Dhidden'
  ]) {
    assert.doesNotMatch(redactUrl(url), /path-sentinel|query-sentinel/);
  }
  assert.equal(redactUrl('/api/files/list?locationId=default'), '/api/files/list?locationId=[REDACTED]');
  assert.match(redactUrl('/api/share/test/download'), /\/api\/share\/\[REDACTED\]\/download/);
});

test('structured data and every supported sink redact credentials without mutating inputs', async () => {
  const files = [];
  const consoles = [];
  const logger = new SystemLogger({ fileSink: async (file, entry) => files.push({ file, entry }), consoleSink: entry => consoles.push(entry) });
  const details = {
    password: 'password-sentinel', shareToken: 'token-sentinel', size: 123, fileCount: 2,
    headers: { cookie: 'cookie-sentinel', authorization: 'Bearer bearer-sentinel' },
    nested: [{ access_token: 'access-sentinel', apiKey: 'key-sentinel' }],
    url: '/auth/browser-handoff/handoff-sentinel?unknown=query-sentinel',
    body: { arbitrary: 'body-sentinel' }, query: { arbitrary: 'query-sentinel' },
    error: new Error('GET /api/share/path-sentinel/download?password=password-sentinel'), operation: 'download'
  };
  const req = { method: 'POST', originalUrl: '/api/share/path-sentinel/download?password=password-sentinel',
    headers: { 'x-forwarded-for': '192.0.2.1', cookie: 'cookie-sentinel', authorization: 'Bearer bearer-sentinel' },
    user: { username: 'fixture-user', role: 'user' }, body: { password: 'password-sentinel' }
  };
  const original = JSON.stringify({ details, req });
  await logger.logSystem('INFO', details);
  await logger.logToServerFile('WARN', details);
  await logger.logToIPFile('192.0.2.1', 'INFO', details, req);
  await logger.logAuth('login', 'fixture-user', false, details, req);
  await logger.logAPI('download', '/api/share/path-sentinel/download', true, req, details);
  await logger.logFileOperation('read', 'file.txt', true, req, details);
  await logger.logSecurity('blocked', details, req);
  await logger.logCacheOperation('read', details, req);
  await logger.logUpload('file.txt', false, req, details);
  await logger.logDownload('file.txt', 'share-link', false, req, details);
  await logger.log('WARN', details, req);
  await logger.logError(details, req);
  await logger.logSystem('INFO', 'Bearer bearer-sentinel password=password-sentinel /auth/browser-handoff/handoff-sentinel');
  await logger.logSystem('INFO', 'request Cookie: first=cookie-sentinel; second=token-sentinel');
  await logger.logSystem('INFO', 'request Authorization: Basic bearer-sentinel');
  await logger.logSystem('INFO', `request ${JSON.stringify({ password: 'password-sentinel' })}`);
  const output = JSON.stringify({ files, consoles });
  assert.doesNotMatch(output, /(?:password|token|cookie|bearer|access|key|handoff|query|body|path)-sentinel/);
  assert.match(output, /fixture-user/);
  assert.match(output, /123/);
  assert.match(output, /download/);
  assert.ok(files.length >= 12);
  assert.ok(consoles.length >= 2);
  assert.equal(JSON.stringify({ details, req }), original);
  const circular = { password: 'password-sentinel' }; circular.self = circular;
  assert.doesNotThrow(() => JSON.stringify(redactLogData(circular)));
});

test('sink failures do not echo raw error details to console', async () => {
  const output = [];
  const logger = new SystemLogger({ fileSink: async () => { throw new Error('password-sentinel'); }, consoleSink: entry => output.push(entry) });
  await logger.logSystem('INFO', { token: 'token-sentinel' });
  await logger.logToIPFile('192.0.2.1', 'INFO', { password: 'password-sentinel' });
  assert.doesNotMatch(JSON.stringify(output), /password-sentinel|token-sentinel/);
});
