const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createAdminLogsRouter } = require('./admin-logs');

const line = (timestamp, message, metadata = '') => `[${timestamp}] [INFO] ${message}${metadata}\n`;
const userMetadata = (username, role = 'user') => ` | URL: GET /api/files | User-Agent: fixture-agent | User: ${username} (${role})`;

async function fixture(t) {
  const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-logs-test-'));
  t.after(() => fs.rm(logsDir, { recursive: true, force: true }));

  const denied = (req, res, next) => {
    if (req.headers['x-fixture-admin'] !== 'yes') return res.status(403).json({ error: 'Forbidden' });
    req.user = { username: 'fixture-admin', role: 'admin' };
    next();
  };
  const app = express();
  app.use('/api/admin/logs', createAdminLogsRouter({ logsDir, auth: denied }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));

  const request = (url, admin = true) => fetch(`http://127.0.0.1:${server.address().port}/api/admin/logs${url}`, {
    headers: admin ? { 'x-fixture-admin': 'yes' } : {}
  });
  return { logsDir, request };
}

test('admin log APIs reject non-admin callers and only discover strict IPv4 log files', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.logsDir, '192_0_2_1.log'), line('2026-10-02 10:00:00', 'API LIST - Status: SUCCESS', userMetadata('ken')));
  await fs.writeFile(path.join(f.logsDir, '999_0_2_1.log'), line('2026-10-02 10:00:00', 'API LIST - Status: SUCCESS', userMetadata('ignored')));
  await fs.writeFile(path.join(f.logsDir, 'not-an-ip.log'), line('2026-10-02 10:00:00', 'API LIST - Status: SUCCESS', userMetadata('ignored')));

  const denied = await f.request('/users', false);
  assert.equal(denied.status, 403);

  const response = await f.request('/users');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.users.map(user => user.username), ['ken']);
  assert.equal(data.users[0].ipCount, 1);
});

test('user summaries group same-IP logs by account and sort IPs by latest user activity', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.logsDir, '192_0_2_8.log'), [
    line('2026-10-01 12:00:00', 'API LIST - Resource: /, Status: SUCCESS', userMetadata('ken')),
    line('2026-10-01 13:00:00', 'API SEARCH - Resource: report, Status: SUCCESS', userMetadata('lee')),
    line('2026-10-02 10:00:00', 'FILE DELETE - Path: report.txt, Status: FAILED', userMetadata('ken')),
    line('2026-10-02 11:00:00', 'DOWNLOAD - File: share.txt, Type: share-link, Status: SUCCESS', ' | URL: GET /api/share/share-token-sentinel/download?token=query-token-sentinel')
  ].join(''));
  await fs.writeFile(path.join(f.logsDir, '192_0_2_9.log'), line('2026-10-02 09:00:00', 'API SEARCH - Resource: notes, Status: SUCCESS', userMetadata('ken')));

  const usersResponse = await f.request('/users');
  const users = (await usersResponse.json()).users;
  assert.deepEqual(users.map(user => user.username), [null, 'ken', 'lee']);
  assert.equal(users[0].key, 'anonymous');

  const ipsResponse = await f.request('/ips?user=u-a2Vu');
  const ips = (await ipsResponse.json()).ips;
  assert.deepEqual(ips.map(entry => entry.ip), ['192.0.2.8', '192.0.2.9']);
  assert.deepEqual(ips.map(entry => entry.entryCount), [2, 1]);
  assert.equal(ips[0].latestAt, '2026-10-02 10:00:00');

  const leeIps = await (await f.request('/ips?user=u-bGVl')).json();
  assert.deepEqual(leeIps.ips.map(entry => entry.ip), ['192.0.2.8']);
  const anonymousIps = await (await f.request('/ips?user=anonymous')).json();
  assert.deepEqual(anonymousIps.ips.map(entry => entry.ip), ['192.0.2.8']);
});

test('per-IP entries are filtered to selected user, redacted, and paginated newest-first', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.logsDir, '192_0_2_8.log'), [
    line('2026-10-01 12:00:00', 'API LIST - Resource: /, Status: SUCCESS', userMetadata('ken')),
    line('2026-10-01 13:00:00', 'API SEARCH - Resource: report, Status: SUCCESS', userMetadata('lee')),
    line('2026-10-02 10:00:00', 'FILE DELETE - Path: report.txt, Status: FAILED', userMetadata('ken')),
    line('2026-10-02 11:00:00', 'DOWNLOAD - File: share.txt, Type: share-link, Status: FAILED', ' | URL: GET /api/share/share-token-sentinel/download?token=query-token-sentinel')
  ].join(''));

  const firstResponse = await f.request('/entries?user=u-a2Vu&ip=192.0.2.8&limit=1');
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.entries.length, 1);
  assert.match(first.entries[0].operation, /FILE DELETE/);
  assert.doesNotMatch(first.entries[0].operation, /ken|192\.0\.2\.8|fixture-agent/);
  assert.equal(first.hasMore, true);

  const olderResponse = await f.request(`/entries?user=u-a2Vu&ip=192.0.2.8&limit=1&before=${first.nextCursor}`);
  const older = await olderResponse.json();
  assert.equal(older.entries.length, 1);
  assert.match(older.entries[0].operation, /API LIST/);
  assert.equal(older.hasMore, false);
  assert.equal(older.nextCursor, null);

  const anonymous = await (await f.request('/entries?user=anonymous&ip=192.0.2.8')).json();
  assert.equal(anonymous.entries.length, 1);
  assert.doesNotMatch(anonymous.entries[0].operation, /share-token-sentinel|query-token-sentinel/);
});

test('entry API validates user, IPv4, page size and cursor without accepting arbitrary paths', async t => {
  const f = await fixture(t);
  for (const url of [
    '/ips?user=../../etc/passwd',
    '/entries?user=u-a2Vu&ip=../../etc/passwd',
    '/entries?user=u-a2Vu&ip=192.0.2.8&limit=101',
    '/entries?user=u-a2Vu&ip=192.0.2.8&before=-1'
  ]) {
    assert.equal((await f.request(url)).status, 400, url);
  }
});

test('custom filters match inclusive server-log dates and exact normalized operation types', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.logsDir, '192_0_2_8.log'), [
    line('2026-10-01 23:59:59', 'FILE RENAME - Path: before.txt, Status: SUCCESS', userMetadata('ken')),
    line('2026-10-02 08:00:00', 'FILE RENAME - Path: old.txt, Status: SUCCESS', userMetadata('ken')),
    line('2026-10-02 09:00:00', 'API RENAME - Resource: old.txt, Status: SUCCESS', userMetadata('ken')),
    line('2026-10-02 10:00:00', 'FILE DELETE - Path: rename-notes.txt, Status: SUCCESS', userMetadata('ken')),
    line('2026-10-02 11:00:00', 'API SEARCH - Resource: rename, Status: SUCCESS', userMetadata('ken')),
    line('2026-10-03 00:00:00', 'FILE RENAME - Path: after.txt, Status: SUCCESS', userMetadata('ken'))
  ].join(''));
  await fs.writeFile(path.join(f.logsDir, '192_0_2_9.log'), line('2026-10-02 12:00:00', 'API DELETE - Resource: file, Status: SUCCESS', userMetadata('ken')));

  const query = 'user=u-a2Vu&from=2026-10-02&to=2026-10-02&operation=rename';
  const summary = await (await f.request(`/ips?${query}`)).json();
  assert.deepEqual(summary.ips.map(entry => [entry.ip, entry.entryCount, entry.latestAt]), [
    ['192.0.2.8', 2, '2026-10-02 09:00:00']
  ]);
  assert.deepEqual(summary.operations, ['DELETE', 'RENAME', 'SEARCH']);

  const entries = await (await f.request(`/entries?${query}&ip=192.0.2.8`)).json();
  assert.deepEqual(entries.entries.map(entry => [entry.timestamp, entry.operationType]), [
    ['2026-10-02 09:00:00', 'RENAME'],
    ['2026-10-02 08:00:00', 'RENAME']
  ]);

  for (const invalid of [
    '/ips?user=u-a2Vu&from=2026-02-30',
    '/ips?user=u-a2Vu&from=2026-10-03&to=2026-10-02',
    '/entries?user=u-a2Vu&ip=192.0.2.8&operation=rename%20or%20delete'
  ]) {
    assert.equal((await f.request(invalid)).status, 400, invalid);
  }
});
