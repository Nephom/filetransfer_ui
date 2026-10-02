import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const html = await fs.readFile(path.join(root, 'src/frontend/private/admin.html'), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const failures = [];
  const requests = [];
  let failFirstEntry = true;
  page.on('pageerror', error => failures.push(error.message));
  page.on('dialog', dialog => dialog.accept());

  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ path: url.pathname, query: url.searchParams, method: request.method() });
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

    if (url.pathname === '/admin') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/auth/verify') return json({ user: { id: 0, username: 'fixture-admin', role: 'admin' } });
    if (url.pathname === '/api/admin/users') return json({ users: [], stats: { total: 0 } });
    if (url.pathname === '/api/files/cache-stats') return json({ initialized: true, totalFiles: 0 });
    if (url.pathname === '/api/admin/config') return json({ config: { server: { port: 9400 }, ssl: {} } });
    if (url.pathname === '/server.log') return route.fulfill({ contentType: 'text/plain', body: '[2026-10-02 08:00:00] [INFO] fixture server event\n' });
    if (url.pathname === '/api/admin/logs/users') return json({ users: [
      { key: 'u-a2Vu', username: 'ken', latestAt: '2026-10-02 12:00:00', entryCount: 3, ipCount: 2 },
      { key: 'u-bGVl', username: 'lee', latestAt: '2026-10-01 10:00:00', entryCount: 1, ipCount: 1 }
    ] });
    if (url.pathname === '/api/admin/logs/ips') {
      const filtered = url.searchParams.get('operation') === 'RENAME' && url.searchParams.get('from')
        ? [{ ip: '192.0.2.2', latestAt: '2026-10-02 11:00:00', entryCount: 1, operations: ['RENAME'] }]
        : [
          { ip: '192.0.2.1', latestAt: '2026-10-02 12:00:00', entryCount: 2, operations: ['DELETE', 'RENAME'] },
          { ip: '192.0.2.2', latestAt: '2026-10-02 11:00:00', entryCount: 1, operations: ['RENAME'] }
        ];
      return json({ username: 'ken', ips: filtered, operations: ['DELETE', 'RENAME'] });
    }
    if (url.pathname === '/api/admin/logs/entries') {
      if (failFirstEntry) {
        failFirstEntry = false;
        return json({ error: 'fixture temporary log read failure' }, 500);
      }
      return json({ entries: [{
        sequence: 42,
        timestamp: `${url.searchParams.get('from')} 11:00:00`,
        level: 'INFO',
        operationType: 'RENAME',
        operation: 'FILE RENAME - Path: old.txt, Status: SUCCESS · PUT /api/files/rename'
      }], hasMore: false, nextCursor: null });
    }
    return json({ success: true, users: [], roles: [], locations: [] });
  });

  await page.goto('http://fixture.test/admin');
  await page.waitForFunction(() => currentUserRole === 'admin');
  await page.evaluate(() => openLogViewer());
  await page.getByRole('tab', { name: 'User / IP activity' }).click();
  await page.waitForFunction(() => document.querySelector('#logUserSelect')?.value === 'u-a2Vu');
  await page.waitForFunction(() => document.querySelectorAll('#ipLogGroups details').length === 2);

  assert.deepEqual(await page.locator('#ipLogGroups .log-ip-address').allTextContents(), ['192.0.2.1', '192.0.2.2']);
  assert.equal(await page.locator('#ipLogGroups details[open]').count(), 0, 'IP groups start collapsed');

  const today = await page.evaluate(() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  });
  await page.locator('#logDateFrom').fill(today);
  await page.locator('#logDateTo').fill(today);
  await page.locator('#logOperationSelect').selectOption('RENAME');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#ipLogGroups details').length === 1);
  assert.equal(await page.locator('#ipLogGroups .log-ip-address').textContent(), '192.0.2.2');

  const matchingIp = page.locator('#ipLogGroups details').first();
  await matchingIp.locator('summary').click();
  await page.getByText(/Unable to load operations: fixture temporary log read failure/).waitFor();
  await matchingIp.getByRole('button', { name: 'Retry' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#ipLogGroups .log-event-row').length === 1);
  const rowText = await page.locator('#ipLogGroups .log-event-row').textContent();
  assert.match(rowText, /FILE RENAME/);
  assert.match(rowText, new RegExp(today));
  assert.doesNotMatch(rowText, /ken|192\.0\.2\.2/);
  assert.ok(requests.some(request => request.path === '/api/admin/logs/ips' &&
    request.query.get('from') === today && request.query.get('to') === today && request.query.get('operation') === 'RENAME'));
  assert.ok(requests.some(request => request.path === '/api/admin/logs/entries' &&
    request.query.get('from') === today && request.query.get('to') === today && request.query.get('operation') === 'RENAME'));

  await page.getByRole('tab', { name: 'System log' }).click();
  await page.getByText('fixture server event').waitFor();
  assert.deepEqual(failures, []);
} finally {
  await browser.close();
}
