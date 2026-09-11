import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import build from '../../../scripts/build-browser.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const baselineRef = process.env.BROWSER_BASELINE_REF || 'ac222f0f65cf8b8846645af2fcfdc9f158e8cb97';
await build.buildBrowser();
const manifest = build.checkBrowserBuild();
const records = Array.from({ length: 10000 }, (_, index) => ({ name: `file${index}.txt`, path: `file${index}.txt`, size: index, modified: '2026-09-09T00:00:00Z', isDirectory: false }));
const duplicates = ['a', 'b'].map(parent => ({ name: 'same.txt', path: `${parent}/same.txt`, size: 12, isDirectory: false }));
const capabilities = ['list', 'read', 'upload', 'mkdir', 'move', 'rename', 'share', 'delete'];
const locations = ['A', 'B'].map(id => ({ id, revision: `${id}-root-1`, displayName: `Location ${id}`, capabilities, status: 'online' }));
let availableLocations = locations;
const malicious = `x'\"/><img src=x onerror="window.__xss=1">/account`;
const fixtureUser = { username: malicious, email: malicious, role: 'user', active: true, roleId: 'role-fixture', permissions: [] };
const shareCases = [
    { name: 'passwordless', hasPassword: false, supportsDirectDownload: true, directDownloadMethod: 'GET', allowDirect: true },
    { name: 'protected', hasPassword: true, supportsDirectDownload: false, directDownloadMethod: 'POST' },
    { name: 'unknown' },
    { name: 'conflicting-password', hasPassword: true, supportsDirectDownload: true, directDownloadMethod: 'GET' },
    { name: 'unsupported', hasPassword: false, supportsDirectDownload: false, directDownloadMethod: 'GET' },
    { name: 'post-only', hasPassword: false, supportsDirectDownload: true, directDownloadMethod: 'POST' },
    { name: 'partial-metadata', hasPassword: false }
];
let fixtureShare;
let pasteMode = 'success';
let pasteDelay = 0;
let shareDelay = 0;
const requests = [];
const batches = new Map();
let uploadMode = 'running';
let progressFailures = 0;
let settleCancellation = false;
let delaySearch = false;
let delayRefresh = false;
let deletePartial = false;
let reserveDelay = 0;
let authenticated = true;
const baselineAssets = new Map();
function original(name) {
    if (!baselineAssets.has(name)) baselineAssets.set(name, execFileSync('git', ['show', `${baselineRef}:src/frontend/public/${name}`], { cwd: root, maxBuffer: 10 * 1024 * 1024 }));
    return baselineAssets.get(name);
}
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        const jsonBody = req.headers['content-type']?.includes('application/json') && body ? JSON.parse(body) : null;
        requests.push({ path: url.pathname, query: url.search, method: req.method, body: jsonBody, raw: body, headers: req.headers });
        const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
        const send = (bytes, type) => { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(bytes); };
        const requestedLocation = availableLocations.find(location => location.id === req.headers['x-location-id']);
        // The header is scoped to its Location; cross-Location operands carry
        // independently captured revisions in the JSON body.
        if (req.headers['x-location-revision'] && req.headers['x-location-revision'] !== requestedLocation?.revision) return json({ error: 'Location changed; refresh before retrying' }, 409);
        for (const side of ['source', 'target']) {
            const id = jsonBody?.[`${side}LocationId`];
            const revision = jsonBody?.[`${side}LocationRevision`];
            if (revision !== undefined && revision !== availableLocations.find(location => location.id === id)?.revision) return json({ error: 'Location changed; refresh before retrying', results: [] }, 409);
        }
        if (url.pathname === '/auth/verify') {
            const role = req.headers.cookie?.includes('fixtureRole=admin') || req.headers.authorization === 'Bearer fixture-admin' ? 'admin' : req.headers.cookie?.includes('fixtureRole=superuser') || req.headers.authorization === 'Bearer fixture-superuser' ? 'superuser' : 'user';
            return json({ user: { id: `fixture-${role}`, username: 'fixture', role } }, authenticated ? 200 : 401);
        }
        if (url.pathname === '/auth/login') { authenticated = true; return json({ user: { id: 'fixture-user', username: 'fixture', role: 'user' } }); }
        if (url.pathname === '/auth/logout') { authenticated = false; return json({ success: true }); }
        if (url.pathname === '/api/version') return json({ display: 'fixture version' });
        if (url.pathname === '/api/locations') return json({ locations: availableLocations });
        if (url.pathname === '/api/files') return json({ currentPath: url.searchParams.get('path') || '', files: requestedLocation?.revision === 'A-root-2' ? [{ name: 'replacement-root.txt', path: 'replacement-root.txt', size: 4 }] : req.headers['x-location-id'] === 'B' ? [{ name: 'B-only.txt', path: 'B-only.txt', size: 8 }] : records });
        if (url.pathname === '/api/files/search') {
            if (delaySearch) await new Promise(resolve => setTimeout(resolve, 700));
            if (url.searchParams.get('query') === 'late-error') return json({ message: 'fixture stale error' }, 500);
            return json({ files: duplicates });
        }
        if (url.pathname === '/api/files/refresh-cache') {
            if (delayRefresh) await new Promise(resolve => setTimeout(resolve, 700));
            return json({ success: true });
        }
        if (url.pathname === '/api/archive') {
            return send(jsonBody?.format === 'tar.gz' ? Buffer.from([0x1f, 0x8b, 0x08, 0x00]) : Buffer.from([0x50, 0x4b, 0x03, 0x04]), jsonBody?.format === 'tar.gz' ? 'application/gzip' : 'application/zip');
        }
        if (url.pathname === '/api/files/delete') {
            if (deletePartial && jsonBody.currentPath === 'b') return json({ deletedCount: 0, error: 'fixture delete failure' }, 500);
            return json({ deletedCount: jsonBody.items.length });
        }
        if (url.pathname === '/api/files/rename') return json({ success: true });
        if (url.pathname === '/api/files/paste') {
            const results = jsonBody.items.map((item, index) => ({ name: item.name, path: item.path, sourceLocationId: item.sourceLocationId, success: pasteMode === 'success' || (pasteMode === 'partial' && index === 0), ...(pasteMode === 'partial' && index === 1 ? { copied: true, error: 'fixture source cleanup failed' } : {}) }));
            if (pasteDelay) await new Promise(resolve => setTimeout(resolve, pasteDelay));
            if (pasteMode === 'unknown') return json({ success: false, results: results.slice(0, 1) }, 500);
            return json({ success: pasteMode === 'success', results }, pasteMode === 'success' ? 200 : pasteMode === 'partial' ? 207 : 500);
        }
        if (url.pathname === '/api/files/shares') return json({ success: true, data: [fixtureShare] });
        if (url.pathname === '/api/files/share' && req.method === 'POST') {
            if (shareDelay) await new Promise(resolve => setTimeout(resolve, shareDelay));
            return json({ success: true, data: { ...fixtureShare, fullUrl: `http://${req.headers.host}${fixtureShare.shareUrl}`, directDownloadFullUrl: `http://${req.headers.host}${fixtureShare.directDownloadUrl}` } });
        }
        if (url.pathname === '/api/upload/batches') {
            const batchId = `fixture-batch-${batches.size + 1}`;
            const batch = { batchId, status: 'reserved', phase: 'reserved', locationId: req.headers['x-location-id'], expiresAt: Date.now() + 60000, totalSize: 12, totalSizeKnown: true, transferredSize: 0, progress: 0, successCount: 0, failedCount: 0, cancelledCount: 0, pendingCount: 1, uploads: 0, cancelCalls: 0 };
            batches.set(batchId, batch);
            if (reserveDelay) await new Promise(resolve => setTimeout(resolve, reserveDelay));
            return json(batch, 201);
        }
        if (url.pathname === '/api/upload/multiple') {
            const batch = batches.get(req.headers['x-upload-batch-id']);
            assert.ok(batch, 'upload must reserve first');
            assert.equal(req.headers['x-location-id'], batch.locationId);
            batch.uploads++;
            batch.status = 'processing'; batch.phase = 'writing'; batch.transferredSize = 5; batch.progress = 5 / 12 * 100;
            if (uploadMode === 'lost') {
                // Lose the acceptance body after headers, not an idle keep-alive socket
                // (Chromium can transparently replay the latter below the application).
                res.writeHead(202, { 'Content-Type': 'application/json', 'Content-Length': '100' });
                res.write('{"batchId":');
                setTimeout(() => res.destroy(), 10);
                return;
            }
            if (uploadMode === 'held') await new Promise(resolve => setTimeout(resolve, 1500));
            return json({ batchId: batch.batchId }, 202);
        }
        if (url.pathname.startsWith('/api/progress/batch/')) {
            const batch = batches.get(url.pathname.split('/')[4]);
            assert.ok(batch, 'known reserved batch');
            assert.equal(req.headers['x-location-id'], batch.locationId);
            if (url.pathname.endsWith('/cancel')) { batch.cancelCalls++; batch.status = 'cancelling'; batch.phase = 'cancelling'; return json(batch, 202); }
            if (progressFailures > 0) { progressFailures--; return json({ error: 'fixture progress outage' }, 503); }
            if (batch.cancelCalls && settleCancellation) { batch.status = 'cancelled'; batch.phase = 'cancelled'; batch.cancelledCount = 1; batch.pendingCount = 0; }
            return json(batch);
        }
        if (url.pathname === '/api/admin/users') return json({ users: [fixtureUser], stats: {} });
        if (url.pathname.startsWith('/api/admin/users/')) return json({ user: fixtureUser, success: true });
        if (url.pathname === '/api/admin/roles') return json({ roles: [{ id: 'role-fixture', name: malicious, description: malicious, locationPermissions: {} }], locations: [{ id: malicious, displayName: malicious }], capabilities: ['read'] });
        if (url.pathname.startsWith('/api/admin/') || url.pathname === '/api/files/cache-stats') return json({ config: {}, cache: {}, stats: {} });
        if (url.pathname.endsWith('/info') && url.pathname.startsWith('/api/share/')) return json({ success: true, data: { fileName: 'fixture.txt', hasPassword: true, isActive: true } });
        if (url.pathname.endsWith('/download') && url.pathname.startsWith('/api/share/')) { await new Promise(resolve => setTimeout(resolve, 100)); return send('fixture data', 'application/octet-stream'); }
        if (url.pathname === '/admin' || url.pathname === '/super') return send(fs.readFileSync(path.join(root, `src/frontend/private/${url.pathname.slice(1)}.html`)), 'text/html');
        if (url.pathname === '/baseline') return send(original('index.html'), 'text/html');
        if (/^\/(lib\/|components\/|queue\/|app\.js)/.test(url.pathname)) return send(original(url.pathname.slice(1)), 'text/javascript');
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (['index.html', 'share.html', 'favicon.ico', manifest.entry].includes(name)) return send(fs.readFileSync(path.join(build.publicDirectory, name)), name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : 'image/x-icon');
        res.writeHead(404); res.end('Fixture route not found');
    } catch (error) { console.error('Fixture error:', error); res.writeHead(500); res.end('Fixture error'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const report = { browser: '', baselineRef, checks: [], metrics: {} };
const waitFor = async (predicate, message, timeout = 10000) => {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout) throw new Error(message);
        await new Promise(resolve => setTimeout(resolve, 25));
    }
};
try {
    browser = await chromium.launch({ headless: true });
    report.browser = browser.version();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('dialog', dialog => dialog.accept());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    async function loadMetrics(route) {
        const start = performance.now();
        await page.goto(`${origin}${route}`);
        await page.locator('.file-row').first().waitFor();
        await frames();
        const renderMs = performance.now() - start;
        const metrics = await page.evaluate(() => {
            const row = document.querySelector('.file-row');
            const style = getComputedStyle(row);
            return { mountedRows: document.querySelectorAll('.file-row').length, assetBytes: performance.getEntriesByType('resource').filter(entry => entry.initiatorType === 'script').reduce((sum, entry) => sum + entry.encodedBodySize, 0) + performance.getEntriesByType('navigation')[0].encodedBodySize, runtimeBabel: !!window.Babel, rowHeight: row.getBoundingClientRect().height, font: style.font, color: style.color, background: getComputedStyle(document.body).backgroundColor };
        });
        const inputStart = performance.now();
        await page.getByRole('textbox', { name: 'Search files' }).fill('typing');
        await frames();
        metrics.inputMs = performance.now() - inputStart;
        metrics.renderMs = renderMs;
        await page.getByRole('textbox', { name: 'Search files' }).fill('');
        return metrics;
    }
    report.metrics.baseline = await loadMetrics('/baseline');
    await page.getByRole('button', { name: 'Grid', exact: true }).click();
    await frames();
    report.metrics.baselineGrid = await page.locator('.file-grid').evaluate(grid => ({ mountedCards: grid.querySelectorAll('.file-tile').length, columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length, cardHeight: grid.querySelector('.file-tile').getBoundingClientRect().height }));
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await page.goto('about:blank');
    const browserStart = requests.length;
    report.metrics.production = await loadMetrics('/');
    assert.equal(report.metrics.baseline.mountedRows, 10000);
    assert.ok(report.metrics.production.mountedRows < 100);
    assert.equal(report.metrics.production.runtimeBabel, false);
    for (const key of ['rowHeight', 'font', 'color', 'background']) assert.equal(report.metrics.production[key], report.metrics.baseline[key], `preserved ${key}`);
    assert.ok(requests.slice(browserStart).filter(request => request.path.startsWith('/api/')).every(request => !request.headers.authorization), 'cookie requests omit Bearer null');
    report.checks.push('production cold load, baseline comparison, cookie-only auth, unchanged table styling');

    await page.locator('.file-row').nth(0).click();
    await page.locator('.file-row').nth(1).click({ modifiers: ['Control'] });
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    await page.locator('input[name="downloadMode"]').nth(1).check();
    await page.getByRole('button', { name: 'Start download', exact: true }).click();
    await waitFor(() => requests.filter(request => request.path === '/api/archive').length >= 1, 'ZIP archive request was not sent');
    assert.equal(requests.findLast(request => request.path === '/api/archive').body.format, 'zip');

    await page.getByRole('button', { name: 'Download', exact: true }).click();
    await page.locator('input[name="downloadMode"]').nth(0).check();
    await page.getByRole('button', { name: 'Start download', exact: true }).click();
    await waitFor(() => requests.filter(request => request.path === '/api/archive').length >= 2, 'tar.gz archive request was not sent');
    assert.equal(requests.findLast(request => request.path === '/api/archive').body.format, 'tar.gz');
    report.checks.push('archive format selection sends the confirmed ZIP and tar.gz formats');

    await page.goto(`${origin}/`);
    await page.locator('.file-row').first().waitFor();
    await frames();
    await page.locator('.file-area').evaluate(area => { area.scrollTop = 50000; });
    await frames();
    const tableGeometry = await page.locator('.file-table').evaluate(table => {
        const row = table.querySelector('.file-row');
        const index = Number(row.dataset.fileIndex);
        return { index, delta: row.getBoundingClientRect().top - table.getBoundingClientRect().top - 36 - index * 40 };
    });
    assert.ok(tableGeometry.index > 1200);
    assert.ok(Math.abs(tableGeometry.delta) < 1, 'spacer height equals actual offscreen table rows');
    await page.locator('.file-area').evaluate(area => { area.scrollTop = 0; });
    await frames();

    await page.locator('.file-row').first().click();
    await page.keyboard.press('Shift+End');
    await page.waitForFunction(() => document.querySelector('.selection-count')?.textContent === '10000 selected');
    assert.equal(await page.locator('[data-file-index="9999"]').evaluate(element => element === document.activeElement), true);
    assert.ok(await page.locator('.file-row').count() < 100);
    await page.getByRole('button', { name: 'Grid', exact: true }).click();
    await frames();
    const gridMetrics = await page.locator('.file-grid').evaluate(grid => ({ mountedCards: grid.querySelectorAll('.file-tile').length, columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length, cardHeight: grid.querySelector('.file-tile').getBoundingClientRect().height, scrollHeight: grid.parentElement.scrollHeight }));
    report.metrics.grid = gridMetrics;
    assert.equal(gridMetrics.cardHeight, report.metrics.baselineGrid.cardHeight);
    assert.equal(gridMetrics.columns, report.metrics.baselineGrid.columns);
    const gridDelta = await page.locator('.file-grid').evaluate(grid => {
        const tile = grid.querySelector('.file-tile');
        const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
        return tile.getBoundingClientRect().top - grid.getBoundingClientRect().top - 4 - Math.floor(Number(tile.dataset.fileIndex) / columns) * 162;
    });
    assert.ok(Math.abs(gridDelta) < 1, 'spacer height equals actual offscreen grid rows');
    assert.ok(gridMetrics.mountedCards < 150);
    assert.ok(gridMetrics.scrollHeight > 100000);
    assert.equal(await page.locator('.selection-count').textContent(), '10000 selected');
    await page.locator('[data-file-index="9999"]').click();
    await page.locator('[data-file-index="9999"]').dragTo(page.getByRole('button', { name: 'Location B', exact: true }));
    await waitFor(() => requests.some(request => request.path === '/api/files/paste'), 'drag/drop must dispatch a move');
    const move = requests.findLast(request => request.path === '/api/files/paste');
    assert.equal(move.body.items[0].path, 'file9999.txt');
    assert.equal(move.body.sourceLocationId, 'A'); assert.equal(move.body.targetLocationId, 'B');
    assert.equal(move.headers['x-location-revision'], 'A-root-1');
    assert.equal(move.body.sourceLocationRevision, 'A-root-1');
    assert.equal(move.body.targetLocationRevision, 'B-root-1');
    assert.equal(move.query, '');
    report.checks.push('10,000-item full range selection, keyboard End focus, bounded grid, native drag/drop full identity');

    for (const width of [1024, 720, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await frames();
        assert.ok(await page.locator('.file-tile').count() < 150, `bounded cards at ${width}px: ${await page.locator('.file-tile').count()}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        const geometry = await page.locator('.file-grid').evaluate(grid => ({ width: grid.getBoundingClientRect().width, columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length, cardWidth: grid.querySelector('.file-tile').getBoundingClientRect().width }));
        report.metrics[`grid${width}`] = geometry;
        assert.ok(geometry.cardWidth >= (width <= 720 ? 130 : 165));
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    const search = page.getByRole('textbox', { name: 'Search files' });
    async function searchSame() {
        await search.fill('same'); await search.press('Enter');
        await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('2 items'));
    }
    await searchSame();
    assert.equal(await page.locator('.file-row').count(), 2);
    await page.locator('.file-row').nth(1).click();
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.locator('input[name="newName"]').fill('renamed.txt');
    await page.locator('.modal button[type="submit"]').click();
    await waitFor(() => requests.some(request => request.path === '/api/files/rename'), 'rename dispatched');
    const rename = requests.findLast(request => request.path === '/api/files/rename');
    assert.deepEqual(rename.body, { oldPath: 'b/same.txt', oldName: 'same.txt', newName: 'renamed.txt', currentPath: 'b' });
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('10000 items'));
    await searchSame();
    await page.locator('.file-row').nth(0).click();
    await page.locator('.file-row').nth(1).click({ modifiers: ['ControlOrMeta'] });
    deletePartial = true;
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByText('Deleted 1 of 2 selected items.').waitFor();
    assert.match(await page.locator('.error-notice').textContent(), /fixture delete failure/);
    const deletes = requests.filter(request => request.path === '/api/files/delete');
    assert.deepEqual(deletes.map(request => [request.body.currentPath, request.body.items[0].path]), [['a', 'a/same.txt'], ['b', 'b/same.txt']]);
    report.checks.push('resize and narrow layout, duplicate-basename rename, grouped legacy-compatible delete, partial outcomes');

    delaySearch = true;
    await search.fill('late'); await search.press('Enter');
    await page.getByRole('button', { name: 'Location B', exact: true }).click();
    await page.locator('.file-row').filter({ hasText: 'B-only.txt' }).waitFor();
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.file-row').count(), 1);
    assert.equal(await page.locator('.file-row').first().innerText().then(text => text.includes('B-only.txt')), true);
    await search.fill('late-clear'); await search.press('Enter'); await search.press('Escape');
    await page.waitForTimeout(800);
    assert.ok((await page.locator('.file-row').first().innerText()).includes('B-only.txt'));
    delaySearch = false;
    delayRefresh = true;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: 'Location A', exact: true }).click();
    await page.waitForTimeout(800);
    assert.match(await page.locator('.statusbar').textContent(), /10000 items/);
    delayRefresh = false;
    report.checks.push('late search across Location, clear-search during request, stale refresh completion');

    availableLocations = [];
    await page.evaluate(() => window.dispatchEvent(new Event('locations-updated')));
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('0 items'));
    assert.equal(await page.locator('.file-row').count(), 0);
    availableLocations = locations;
    await page.evaluate(() => window.dispatchEvent(new Event('locations-updated')));
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('10000 items'));

    delaySearch = true;
    await search.fill('late-error'); await search.press('Enter');
    await page.getByRole('button', { name: 'Location B', exact: true }).click();
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.error-notice').count(), 0);
    delaySearch = false;
    await page.getByRole('button', { name: 'Location A', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('10000 items'));

    await page.locator('input[type="file"]').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture data') });
    await waitFor(() => batches.size === 1 && [...batches.values()][0].uploads === 1, 'reserved upload dispatched');
    await page.getByRole('button', { name: 'Location B', exact: true }).click();
    await page.locator('.queue-panel-item button').filter({ hasText: /^Cancel$/ }).click();
    await waitFor(() => [...batches.values()][0].cancelCalls === 1, 'separate backend cancellation request');
    assert.equal(await page.locator('.queue-status-cancelled').count(), 0, '202 is not cancellation settlement');
    await page.waitForTimeout(1100);
    assert.equal(await page.locator('.queue-status-cancelled').count(), 0);
    settleCancellation = true;
    await page.locator('.queue-status-cancelled').waitFor();
    assert.match(await page.locator('.queue-status-cancelled').innerText(), /0 completed, 0 failed, 1 cancelled/);
    assert.match(await page.locator('.file-row').first().innerText(), /B-only/);
    assert.equal([...batches.values()][0].uploads, 1);
    assert.equal([...batches.values()][0].transferredSize, 5);
    report.checks.push('reservation header, captured upload Location, separate cancel fetch, 202 versus settlement, measured partial bytes');

    uploadMode = 'lost'; progressFailures = 5;
    await page.locator('input[type="file"]').setInputFiles({ name: 'lost.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture data') });
    await page.locator('.queue-status-needs_user_action').waitFor();
    const lost = [...batches.values()][1];
    assert.equal(lost.uploads, 1);
    lost.status = 'completed'; lost.phase = 'completed'; lost.transferredSize = 12; lost.progress = 100; lost.successCount = 1; lost.pendingCount = 0;
    await page.locator('.queue-status-needs_user_action button').filter({ hasText: 'Reconcile' }).click();
    await page.locator('.queue-status-completed').waitFor();
    assert.equal(lost.uploads, 1);
    report.checks.push('lost acceptance and polling outage reconcile existing batch, no duplicate upload on manual retry');

    reserveDelay = 600;
    await page.locator('input[type="file"]').setInputFiles({ name: 'reserve-cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture data') });
    await waitFor(() => batches.size === 3, 'reservation is in flight');
    await page.locator('.queue-status-running button').filter({ hasText: /^Cancel$/ }).click();
    await waitFor(() => [...batches.values()][2].cancelCalls > 0, 'cancel after reservation response');
    await page.waitForFunction(() => document.querySelectorAll('.queue-status-cancelled').length === 2);
    assert.equal([...batches.values()][2].uploads, 0);
    reserveDelay = 0; uploadMode = 'held';
    await page.locator('input[type="file"]').setInputFiles({ name: 'transport-cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture data') });
    await waitFor(() => batches.size === 4 && [...batches.values()][3].uploads === 1, 'upload acceptance is in flight');
    await page.locator('.queue-status-running button').filter({ hasText: /^Cancel$/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.queue-status-cancelled').length === 3);
    assert.equal([...batches.values()][3].cancelCalls, 1);
    assert.equal([...batches.values()][3].uploads, 1);
    report.checks.push('stale errors ignored, cancel during reservation sends no bytes, aborted transport uses live separate control fetch');

    delaySearch = true;
    await search.fill('logout-late'); await search.press('Enter');
    await page.locator('.account').click(); await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await page.getByPlaceholder('Username', { exact: true }).waitFor();
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.file-row').count(), 0);
    await page.getByPlaceholder('Username', { exact: true }).fill('fixture');
    await page.getByPlaceholder('Password', { exact: true }).fill('fixture-only-not-a-real-credential');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.locator('.file-row').first().waitFor();
    delaySearch = false;
    report.checks.push('logout aborts old view, login renders unchanged form and starts a new session');

    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    for (const scenario of shareCases) {
        const { name, allowDirect, ...metadata } = scenario;
        fixtureShare = { ...metadata, shareToken: `fixture-${name}`, fileName: `${name}.txt`, locationId: 'A', isActive: true, shareUrl: `/share.html?token=fixture-${name}`, directDownloadUrl: `/api/share/fixture-${name}/download` };
        await page.getByRole('button', { name: 'Share Links', exact: true }).click();
        const card = page.locator('.share-link-card');
        await card.getByText(fixtureShare.fileName, { exact: true }).waitFor();
        assert.equal(await card.locator('input').count(), allowDirect ? 2 : 1, `${name}: direct URL visibility`);
        assert.equal(await card.getByRole('button', { name: 'Copy direct', exact: true }).count(), allowDirect ? 1 : 0, `${name}: direct copy gate`);
        await card.getByRole('button', { name: 'Copy secure', exact: true }).click();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${origin}${fixtureShare.shareUrl}`);
        if (allowDirect) {
            await card.getByRole('button', { name: 'Copy direct', exact: true }).click();
            const copied = await page.evaluate(() => navigator.clipboard.readText());
            assert.equal(copied, `${origin}${fixtureShare.directDownloadUrl}`);
            assert.equal(new URL(copied).search, '');
            assert.equal(await page.evaluate(async url => (await fetch(url)).status, copied), 200);
            assert.equal(requests.findLast(request => request.path === fixtureShare.directDownloadUrl).method, 'GET');
        }
        await page.locator('.modal-cover').click({ position: { x: 5, y: 5 } });

        await page.locator('.file-row').first().click();
        await page.getByRole('button', { name: 'Share', exact: true }).click();
        await page.getByRole('button', { name: 'Create links', exact: true }).click();
        await page.getByRole('button', { name: 'Copy secure', exact: true }).waitFor();
        assert.equal(await page.locator('.modal input').count(), allowDirect ? 2 : 1, `${name}: created direct URL visibility`);
        assert.equal(await page.getByRole('button', { name: 'Copy direct', exact: true }).count(), allowDirect ? 1 : 0, `${name}: created direct copy gate`);
        await page.getByRole('button', { name: 'Copy secure', exact: true }).click();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${origin}${fixtureShare.shareUrl}`);
        if (allowDirect) {
            await page.getByRole('button', { name: 'Copy direct', exact: true }).click();
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${origin}${fixtureShare.directDownloadUrl}`);
        } else {
            assert.equal(await page.locator('.modal').getByText(/Anyone with either link/).count(), 0);
        }
        await page.getByRole('button', { name: 'Done', exact: true }).click();
    }
    assert.ok(requests.every(request => !new URLSearchParams(request.query).has('password')));
    report.checks.push('managed/new shares: seven safe-metadata cases gate direct URL/copy, secure links remain, passwordless direct GET has no query secret');

    async function selectPair() {
        await page.locator('.file-row').nth(0).click();
        await page.locator('.file-row').nth(1).click({ modifiers: ['ControlOrMeta'] });
        return page.locator('.file-row.selected .file-name-cell').allTextContents();
    }
    const pasteCount = () => requests.filter(request => request.path === '/api/files/paste').length;
    const dropOnB = () => page.locator('.file-row').first().dragTo(page.getByRole('button', { name: 'Location B', exact: true }));
    await selectPair();
    pasteMode = 'partial';
    await dropOnB();
    await page.getByText('Moved 1 of 2 items. 1 failed. 0 unconfirmed.', { exact: true }).waitFor();
    assert.match(await page.locator('.error-notice').textContent(), /1 copied but not moved/);
    assert.equal(await page.locator('.selection-count').textContent(), '1 selected');
    assert.match(await page.locator('.file-row.selected').innerText(), /file1.txt/);
    assert.match(await page.locator('.statusbar').textContent(), /9999 items/);
    const failedSelection = await selectPair();
    pasteMode = 'failed';
    await dropOnB();
    await page.getByText('Moved 0 of 2 items. 2 failed. 0 unconfirmed.', { exact: true }).waitFor();
    assert.deepEqual(await page.locator('.file-row.selected .file-name-cell').allTextContents(), failedSelection);
    assert.match(await page.locator('.statusbar').textContent(), /9999 items/);
    pasteMode = 'unknown';
    await dropOnB();
    await page.getByText('Moved 0 of 2 items. 1 failed. 1 unconfirmed.', { exact: true }).waitFor();
    assert.deepEqual(await page.locator('.file-row.selected .file-name-cell').allTextContents(), failedSelection);
    const afterUnknown = pasteCount();
    await page.waitForTimeout(350);
    assert.equal(pasteCount(), afterUnknown, 'never retry a partial/unconfirmed move automatically');
    pasteMode = 'success';
    await dropOnB();
    await page.getByText('Moved 2 of 2 items. 0 failed. 0 unconfirmed.', { exact: true }).waitFor();
    assert.equal(await page.locator('.selection-count').count(), 0);
    assert.match(await page.locator('.statusbar').textContent(), /9997 items/);
    await page.getByRole('button', { name: 'Location A', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('10000 items'));
    await selectPair();
    pasteDelay = 700;
    const beforeDelayed = pasteCount();
    await dropOnB();
    await waitFor(() => pasteCount() > beforeDelayed, 'delayed move dispatched');
    await page.getByRole('button', { name: 'Location B', exact: true }).click();
    await page.locator('.file-row').filter({ hasText: 'B-only.txt' }).waitFor();
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.file-row').count(), 1);
    assert.equal(await page.locator('.transfer-notice').count(), 0);
    pasteDelay = 0;
    report.checks.push('paste authoritative results: mixed 207, all-failed 500, unconfirmed items, exact surviving selection, full success, stale completion and no blind retry');

    await page.getByRole('button', { name: 'Location A', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('10000 items'));
    const staleTargetSelection = await selectPair();
    availableLocations = locations.map(location => location.id === 'B' ? { ...location, revision: 'B-root-2' } : location);
    const rejectedPaste = page.waitForResponse(response => response.url().endsWith('/api/files/paste') && response.status() === 409);
    await dropOnB();
    await rejectedPaste;
    await page.getByText('Moved 0 of 2 items. 0 failed. 2 unconfirmed.', { exact: true }).waitFor();
    assert.deepEqual(await page.locator('.file-row.selected .file-name-cell').allTextContents(), staleTargetSelection);
    assert.equal(requests.findLast(request => request.path === '/api/files/paste').body.targetLocationRevision, 'B-root-1');
    const rejectedCount = pasteCount();
    await page.waitForTimeout(350);
    assert.equal(pasteCount(), rejectedCount);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('10000 items') && !document.querySelector('.selection-count'));
    await selectPair();
    await dropOnB();
    await page.getByText('Moved 2 of 2 items. 0 failed. 0 unconfirmed.', { exact: true }).waitFor();
    const freshMove = requests.findLast(request => request.path === '/api/files/paste');
    assert.equal(freshMove.body.sourceLocationRevision, 'A-root-1');
    assert.equal(freshMove.body.targetLocationRevision, 'B-root-2');
    assert.equal(freshMove.headers['x-location-revision'], 'A-root-1');
    assert.ok(requests.filter(request => request.path === '/api/files/paste').every(request => typeof request.body.sourceLocationRevision === 'string' && typeof request.body.targetLocationRevision === 'string' && request.query === ''));
    report.checks.push('cross-Location paste JSON carries distinct captured revisions; stale target gets 409 with selection retained, no retry, fresh explicit move uses refreshed target');

    await page.getByRole('button', { name: 'Location A', exact: true }).click();
    await page.locator('.file-row').first().waitFor();
    await page.locator('.file-row').first().click();
    shareDelay = 700;
    const shareCount = () => requests.filter(request => request.path === '/api/files/share').length;
    const beforeShare = shareCount();
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByRole('button', { name: 'Create links', exact: true }).click();
    await waitFor(() => shareCount() > beforeShare, 'share dispatched in old revision');
    availableLocations = locations.map(location => location.id === 'A' ? { ...location, revision: 'A-root-2' } : location);
    await page.evaluate(() => window.dispatchEvent(new Event('locations-updated')));
    await page.locator('.file-row').filter({ hasText: 'replacement-root.txt' }).waitFor();
    await page.waitForTimeout(800);
    assert.equal(await page.getByRole('button', { name: 'Copy secure', exact: true }).count(), 0, 'old revision share result must not reopen a dialog');
    assert.equal(await page.locator('.selection-count').count(), 0);
    assert.equal(shareCount(), beforeShare + 1);
    assert.equal(requests.findLast(request => request.path === '/api/files/share').headers['x-location-revision'], 'A-root-1');
    assert.equal(requests.findLast(request => request.path === '/api/files').headers['x-location-revision'], 'A-root-2');
    shareDelay = 0;
    availableLocations = locations;
    await page.evaluate(() => window.dispatchEvent(new Event('locations-updated')));
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('10000 items'));
    // Server root changes before the next metadata poll: old file actions retain
    // their old revision and get rejected instead of silently targeting the new root.
    availableLocations = locations.map(location => location.id === 'A' ? { ...location, revision: 'A-root-2' } : location);
    await page.locator('.file-row').first().click();
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const rejectedShare = page.waitForResponse(response => response.url().endsWith('/api/files/share') && response.status() === 409);
    await page.getByRole('button', { name: 'Create links', exact: true }).click();
    await rejectedShare;
    assert.equal(requests.findLast(request => request.path === '/api/files/share').headers['x-location-revision'], 'A-root-1');
    await page.locator('.modal-cover').click({ position: { x: 5, y: 5 } });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.locator('.file-row').filter({ hasText: 'replacement-root.txt' }).waitFor();
    assert.ok(requests.slice(browserStart).filter(request => request.headers['x-location-id']).every(request => request.headers['x-location-revision']), 'every scoped browser request carries its captured revision');
    report.checks.push('same-ID root revision: capture headers for scoped actions, clear stale files/selection/dialogs, ignore old share completion, reject old revision, read-only metadata refresh');
    assert.deepEqual(errors, [], 'browser app has no uncaught errors');

    for (const role of ['admin', 'superuser']) {
        const privateContext = await browser.newContext();
        await privateContext.addCookies([{ name: 'fixtureRole', value: role, url: origin, httpOnly: true }]);
        await privateContext.addInitScript(role => { localStorage.setItem('token', `fixture-${role}`); sessionStorage.setItem('token', `fixture-${role}`); }, role);
        const privatePage = await privateContext.newPage();
        privatePage.on('dialog', dialog => dialog.accept());
        await privatePage.goto(`${origin}/${role === 'admin' ? 'admin' : 'super'}`);
        await privatePage.waitForFunction(role => currentUserRole === role, role);
        await privatePage.evaluate(() => openUserManagement());
        await privatePage.locator('#usersList tbody tr').waitFor();
        assert.equal(await privatePage.locator('#usersList img').count(), 0);
        assert.equal(await privatePage.locator('#usersList tbody tr td').nth(1).textContent(), malicious);
        await privatePage.locator('#usersList tbody button').filter({ hasText: 'Edit' }).click();
        await privatePage.waitForFunction(name => document.getElementById('editUsernameDisplay').value === name, malicious);
        assert.equal(await privatePage.locator('#editUsernameDisplay').inputValue(), malicious);
        assert.ok(requests.some(request => request.path === `/api/admin/users/${encodeURIComponent(malicious)}`));
        await privatePage.evaluate(async () => { closeEditUser(); closeModal('userManagementModal'); await loadRoles(); displayRoles(rolesCache); renderRoleMatrix(); });
        assert.equal(await privatePage.locator('#rolesList img').count(), 0);
        assert.equal(await privatePage.locator('#roleMatrixContainer img').count(), 0);
        assert.equal(await privatePage.locator('.role-matrix-cell').first().getAttribute('data-location'), malicious);
        assert.equal(await privatePage.evaluate(() => window.__xss), undefined);
        await privateContext.close();
    }
    report.checks.push('actual private admin/super shells: user/role/Location XSS remains text, encoded exact edit target');

    await page.goto(`${origin}/share.html?token=fixture-share`);
    await page.locator('#passwordInput').waitFor({ state: 'visible' });
    const password = 'fixture-share-password';
    await page.locator('#passwordInput').fill(password);
    const download = page.waitForEvent('download');
    await page.locator('#downloadBtn').dblclick();
    await download;
    const shares = requests.filter(request => request.path === '/api/share/fixture-share/download');
    assert.equal(shares.length, 1);
    assert.equal(shares[0].method, 'POST'); assert.deepEqual(shares[0].body, { password }); assert.equal(shares[0].query, '');
    assert.equal(shares[0].headers.referer, undefined);
    assert.equal(await page.locator('#passwordInput').inputValue(), '');
    report.checks.push('generated share page sends password only in POST body, blocks double submission, clears input, no referrer');
    console.log(JSON.stringify(report, null, 2));
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
