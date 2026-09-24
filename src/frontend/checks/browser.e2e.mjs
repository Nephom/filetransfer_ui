import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
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
const uploadManifestHash = (size, chunkHashes) => createHash('sha256')
    .update(Buffer.concat([...chunkHashes.map(hash => Buffer.from(hash, 'hex')), Buffer.from(String(size))]))
    .digest('hex');
let uploadMode = 'running';
let progressFailures = 0;
let settleCancellation = false;
let delaySearch = false;
let delayRefresh = false;
let deletePartial = false;
let reserveDelay = 0;
let authenticated = true;
const userBackgrounds = new Map();
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
        const rawBody = Buffer.concat(chunks);
        const body = rawBody.toString();
        const jsonBody = req.headers['content-type']?.includes('application/json') && body ? JSON.parse(body) : null;
        const fixtureUserId = req.headers.cookie?.includes('fixtureUserB=1') ? 'fixture-user-b' : 'fixture-user-a';
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
            return json({ user: { id: fixtureUserId, username: fixtureUserId, role } }, authenticated ? 200 : 401);
        }
        if (url.pathname === '/auth/login') { authenticated = true; return json({ user: { id: 'fixture-user', username: 'fixture', role: 'user' } }); }
        if (url.pathname === '/auth/logout') { authenticated = false; return json({ success: true }); }
        if (url.pathname === '/api/version') return json({ display: 'fixture version' });
        if (url.pathname === '/api/user/background') {
            if (req.method === 'GET') return json({ background: userBackgrounds.get(fixtureUserId) || null });
            if (req.method === 'PUT') { userBackgrounds.set(fixtureUserId, jsonBody); return json({ success: true }); }
            if (req.method === 'DELETE') { const deleted = userBackgrounds.delete(fixtureUserId); return json({ success: true, deleted }); }
        }
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
            const results = jsonBody.items.map((item, index) => {
                const success = pasteMode === 'success' || (pasteMode === 'partial' && index === 0);
                return { name: item.name, path: item.path, sourceLocationId: item.sourceLocationId, success,
                    ...(!success ? { error: pasteMode === 'partial' && index === 1 ? 'fixture source cleanup failed' : 'fixture move failed' } : {}),
                    ...(pasteMode === 'partial' && index === 1 ? { copied: true } : {}) };
            });
            if (req.headers.accept?.split(',').some(value => value.trim().startsWith('text/event-stream'))) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' });
                const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                const totalItems = results.length;
                if (pasteMode === 'unknown') {
                    emit('start', { totalItems, operation: jsonBody.operation, currentName: results[0]?.name || '', completedItems: 0, failedItems: 0, resolvedItems: 0, remainingItems: totalItems, status: 'preparing' });
                    if (pasteDelay) await new Promise(resolve => setTimeout(resolve, pasteDelay));
                    emit('error', { success: false, status: 'failed', error: 'fixture transfer outcome is unconfirmed', results: [], totalItems, completedItems: 0, failedItems: 0, resolvedItems: 0, remainingItems: totalItems });
                    res.end();
                    return;
                }
                const resolved = [];
                let completedItems = 0;
                let failedItems = 0;
                emit('start', { totalItems, operation: jsonBody.operation, currentName: results[0]?.name || '', completedItems, failedItems, resolvedItems: 0, remainingItems: totalItems, status: 'preparing' });
                for (let index = 0; index < results.length; index++) {
                    const result = results[index];
                    emit('item-start', { currentName: result.name, itemIndex: index + 1, totalItems, completedItems, failedItems, resolvedItems: resolved.length, remainingItems: totalItems - resolved.length, status: 'running' });
                    if (pasteDelay) await new Promise(resolve => setTimeout(resolve, pasteDelay));
                    resolved.push(result);
                    if (result.success) completedItems++;
                    else failedItems++;
                    emit('item-result', { currentName: result.name, itemIndex: index + 1, totalItems, result, completedItems, failedItems, resolvedItems: resolved.length, remainingItems: totalItems - resolved.length, status: result.success ? 'completed' : 'failed' });
                }
                const success = resolved.every(result => result.success);
                emit('complete', { success, status: success ? 'completed' : completedItems > 0 ? 'partial' : 'failed', message: `${completedItems} item(s) moved successfully`, ...(success ? {} : { error: 'One or more paste items failed' }), currentName: resolved.at(-1)?.name || '', results: resolved.filter(result => result.success === false).slice(0, 50), totalItems, completedItems, failedItems, resolvedItems: resolved.length, remainingItems: totalItems - resolved.length });
                res.end();
                return;
            }
            if (pasteDelay) await new Promise(resolve => setTimeout(resolve, pasteDelay));
            if (pasteMode === 'unknown') return json({ success: false, results: results.slice(0, 1) }, 500);
            return json({ success: pasteMode === 'success', results }, pasteMode === 'success' ? 200 : pasteMode === 'partial' ? 207 : 500);
        }
        if (url.pathname === '/api/files/shares') return json({ success: true, data: [fixtureShare] });
        if (url.pathname === '/api/files/share' && req.method === 'POST') {
            if (shareDelay) await new Promise(resolve => setTimeout(resolve, shareDelay));
            return json({ success: true, data: { ...fixtureShare, fullUrl: `http://${req.headers.host}${fixtureShare.shareUrl}`, directDownloadFullUrl: `http://${req.headers.host}${fixtureShare.directDownloadUrl}` } });
        }
        if (url.pathname === '/api/upload/sessions/config' && req.method === 'GET') return json({ chunkSize: 8 * 1024 * 1024 });
        if (url.pathname === '/api/upload/sessions' && req.method === 'GET') {
            return json({ sessions: [...batches.values()].filter(session => !['completed', 'cancelled', 'failed'].includes(session.status)) });
        }
        if (url.pathname === '/api/upload/sessions' && req.method === 'POST') {
            const existing = [...batches.values()].find(session => session.clientAttemptId === jsonBody.clientAttemptId && !['completed', 'cancelled', 'failed'].includes(session.status));
            if (existing) return json(existing, 200);
            const sessionId = `fixture-session-${batches.size + 1}`;
            const session = { sessionId, status: 'manifest', phase: 'manifest', locationId: req.headers['x-location-id'], path: jsonBody.path,
                clientAttemptId: jsonBody.clientAttemptId, chunkSize: jsonBody.chunkSize || 8 * 1024 * 1024,
                expectedFileCount: jsonBody.fileCount, expectedDirectoryCount: jsonBody.directoryCount,
                totalSize: 0, uploadedSize: 0, manifestComplete: false, expiresAt: Date.now() + 4 * 60 * 60 * 1000,
                files: [], directories: [], uploads: 0, cancelCalls: 0 };
            batches.set(sessionId, session);
            if (reserveDelay) await new Promise(resolve => setTimeout(resolve, reserveDelay));
            return json(session, 201);
        }
        if (url.pathname === '/api/upload/sessions' && req.method === 'GET') {
            return json({ sessions: [...batches.values()].filter(session => !['completed', 'cancelled', 'failed'].includes(session.status)) });
        }
        const manifestPage = url.pathname.match(/^\/api\/upload\/sessions\/([^/]+)\/manifest\/pages\/(\d+)$/);
        if (manifestPage && req.method === 'POST') {
            const session = batches.get(manifestPage[1]);
            assert.ok(session, 'manifest page must belong to a reserved session');
            session.files.push(...jsonBody.files.map((file, index) => ({ ...file, manifestHash: uploadManifestHash(file.size, file.chunkHashes), index: jsonBody.fileOffset + index, uploadedOffset: 0, status: 'pending' })));
            session.directories.push(...jsonBody.directories);
            return json({ success: true }, 201);
        }
        const sessionMatch = url.pathname.match(/^\/api\/upload\/sessions\/([^/]+)$/);
        if (sessionMatch && req.method === 'GET') {
            const session = batches.get(sessionMatch[1]);
            assert.ok(session, 'known upload session');
            assert.equal(req.headers['x-location-id'], session.locationId);
            if (session.cancelCalls && settleCancellation) session.status = 'cancelled';
            const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 100);
            const directoryOffset = Number(url.searchParams.get('directoryOffset') || 0);
            const files = session.files.slice(offset, offset + limit), directories = session.directories.slice(directoryOffset, directoryOffset + limit);
            return json({ session, files, nextOffset: offset + files.length < session.files.length ? offset + files.length : null,
                directories, nextDirectoryOffset: directoryOffset + directories.length < session.directories.length ? directoryOffset + directories.length : null });
        }
        const manifestComplete = url.pathname.match(/^\/api\/upload\/sessions\/([^/]+)\/manifest\/complete$/);
        if (manifestComplete && req.method === 'POST') {
            const session = batches.get(manifestComplete[1]);
            session.manifestComplete = true; session.status = 'uploading';
            session.totalSize = session.files.reduce((sum, file) => sum + file.size, 0);
            return json(session);
        }
        const chunkRoute = url.pathname.match(/^\/api\/upload\/sessions\/([^/]+)\/files\/([^/]+)\/chunks$/);
        if (chunkRoute && req.method === 'PUT') {
            const session = batches.get(chunkRoute[1]);
            const file = session?.files.find(candidate => candidate.fileId === chunkRoute[2]);
            assert.ok(file, 'chunk belongs to an upload manifest file');
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers['content-range'] || '');
            assert.ok(range, 'chunk uses an explicit byte range');
            const start = Number(range[1]), end = Number(range[2]);
            if (start !== file.uploadedOffset) return json({ expectedOffset: file.uploadedOffset, error: { message: 'offset mismatch' } }, 409);
            assert.equal(Number(range[3]), file.size);
            assert.equal(createHash('sha256').update(rawBody).digest('hex'), req.headers['x-chunk-sha256']);
            const chunkIndex = Math.floor(start / session.chunkSize);
            assert.equal(req.headers['x-chunk-sha256'], file.chunkHashes[chunkIndex]);
            assert.equal(rawBody.length, end - start + 1);
            file.uploadedOffset = end + 1;
            session.uploadedSize = session.files.reduce((sum, current) => sum + current.uploadedOffset, 0);
            session.transferredSize = session.uploadedSize;
            session.uploads += 1;
            if (uploadMode === 'lost') {
                uploadMode = 'running';
                res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
                res.write('{"uploadedOffset":');
                setTimeout(() => res.destroy(), 10);
                return;
            }
            if (uploadMode === 'held') await new Promise(resolve => setTimeout(resolve, 1500));
            return json({ fileId: file.fileId, uploadedOffset: file.uploadedOffset, size: file.size, status: 'uploading' });
        }
        const fileComplete = url.pathname.match(/^\/api\/upload\/sessions\/([^/]+)\/files\/([^/]+)\/complete$/);
        if (fileComplete && req.method === 'POST') {
            const session = batches.get(fileComplete[1]);
            const file = session?.files.find(candidate => candidate.fileId === fileComplete[2]);
            assert.ok(file, 'file completion belongs to a manifest entry');
            assert.equal(file.uploadedOffset, file.size);
            file.status = 'completed';
            return json({ fileId: file.fileId, status: 'completed', uploadedOffset: file.size, size: file.size, path: file.path });
        }
        const sessionComplete = url.pathname.match(/^\/api\/upload\/sessions\/([^/]+)\/complete$/);
        if (sessionComplete && req.method === 'POST') {
            const session = batches.get(sessionComplete[1]);
            assert.ok(session.files.every(file => file.status === 'completed'));
            session.status = 'completed';
            return json({ sessionId: session.sessionId, status: 'completed' });
        }
        const sessionCancel = url.pathname.match(/^\/api\/upload\/sessions\/([^/]+)\/cancel$/);
        if (sessionCancel && req.method === 'POST') {
            const session = batches.get(sessionCancel[1]);
            assert.ok(session, 'known session must be cancelled');
            session.cancelCalls += 1; session.status = 'cancelling';
            if (settleCancellation) session.status = 'cancelled';
            return json(session, session.status === 'cancelling' ? 202 : 200);
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
    const measurePaneTypography = async (selectorEntries) => page.evaluate((entries) => Object.fromEntries(entries.map(([name, selector]) => {
        const element = document.querySelector(selector);
        return [name, element ? parseFloat(getComputedStyle(element).fontSize) : null];
    })), selectorEntries);
    const assertResponsiveTypography = (narrow, desktop, large, label) => {
        for (const [name, desktopSize] of Object.entries(desktop)) {
            assert.equal(typeof narrow[name], 'number', `${label} ${name} exists at narrow viewport`);
            assert.equal(typeof large[name], 'number', `${label} ${name} exists at large viewport`);
            assert.ok(narrow[name] < desktopSize, `${label} ${name} grows from narrow to desktop: ${narrow[name]} < ${desktopSize}`);
            assert.ok(desktopSize < large[name], `${label} ${name} grows from desktop to large: ${desktopSize} < ${large[name]}`);
        }
    };
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

    uploadMode = 'held';
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture data') });
    await waitFor(() => batches.size === 1 && [...batches.values()][0].uploads === 1, 'reserved upload dispatched');
    const uploadOptionsIndex = requests.findIndex(request => request.path === '/api/upload/sessions/config' && request.method === 'GET');
    const uploadReservationIndex = requests.findIndex(request => request.path === '/api/upload/sessions' && request.method === 'POST');
    const uploadManifestIndex = requests.findIndex(request => request.path.endsWith('/manifest/pages/0') && request.method === 'POST');
    assert.ok(uploadOptionsIndex >= 0 && uploadOptionsIndex < uploadReservationIndex && uploadReservationIndex < uploadManifestIndex,
        'chunk options and source preparation precede session reservation; manifest pages follow it');
    assert.equal(requests[uploadReservationIndex].body.chunkSize, 8 * 1024 * 1024);
    await page.getByRole('button', { name: 'Location B', exact: true }).click();
    await page.locator('.queue-panel-item button').filter({ hasText: /^Cancel$/ }).click();
    await waitFor(() => [...batches.values()][0].cancelCalls === 1, 'separate backend cancellation request');
    assert.equal(await page.locator('.queue-status-cancelled').count(), 0, '202 is not cancellation settlement');
    await page.waitForTimeout(1100);
    assert.equal(await page.locator('.queue-status-cancelled').count(), 0);
    settleCancellation = true;
    await page.locator('.queue-status-cancelled').waitFor();
    assert.match(await page.locator('.queue-status-cancelled').innerText(), /completed files are kept/i);
    assert.match(await page.locator('.file-row').first().innerText(), /B-only/);
    assert.equal([...batches.values()][0].uploads, 1);
    assert.equal([...batches.values()][0].uploadedSize, 12);
    report.checks.push('durable upload session, captured upload Location, chunk offset, separate cancel fetch, 202 versus settlement');

    const sessionsBeforeCollisionPreflight = batches.size;
    const requestsBeforeCollisionPreflight = requests.length;
    await page.locator('input[type="file"]').first().setInputFiles(Array.from({ length: 501 }, () => ({
        name: 'same-target.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0)
    })));
    await page.locator('.queue-status-needs_user_action').filter({ hasText: 'Upload 501 files' }).waitFor();
    assert.equal(batches.size, sessionsBeforeCollisionPreflight, 'an oversized same-target group is rejected before session creation');
    assert.equal(requests.slice(requestsBeforeCollisionPreflight).some(request => request.path === '/api/upload/sessions' && request.method === 'POST'), false);
    report.checks.push('oversized same-destination groups fail preflight without creating an unusable resumable session');

    uploadMode = 'lost';
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'lost.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture data') });
    await waitFor(() => [...batches.values()][1]?.status === 'completed', 'lost chunk response reconciled by offset');
    const lost = [...batches.values()][1];
    assert.equal(lost.uploads, 1);
    assert.equal(lost.files[0].uploadedOffset, 12);
    assert.equal(lost.uploads, 1);
    report.checks.push('lost chunk response resumes from the server checkpoint without retransmitting accepted bytes');

    reserveDelay = 600;
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'reserve-cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture data') });
    await waitFor(() => batches.size === 3, 'reservation is in flight');
    await page.locator('.queue-status-running button').filter({ hasText: /^Cancel$/ }).click();
    await waitFor(() => [...batches.values()][2].cancelCalls > 0, 'cancel after reservation response');
    await page.waitForFunction(() => document.querySelectorAll('.queue-status-cancelled').length === 2);
    assert.equal([...batches.values()][2].uploads, 0);
    reserveDelay = 0; uploadMode = 'held';
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'transport-cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture data') });
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

    // Restore the multi-item fixture before Pane opens its own Location snapshot.
    availableLocations = locations;
    await page.locator('.account').click();
    await page.locator('.account-menu select[aria-label="Interface style"]').selectOption('pane');
    await page.locator('.pane-location-list button').first().waitFor();
    assert.equal(await page.locator('.pane-terminal-launch-card').count(), 1, 'one Terminal launcher sits outside the multi-Location list');
    assert.equal(await page.locator('.pane-tool-grid button').filter({ hasText: 'Terminal' }).count(), 0, 'Terminal is not duplicated in the right-side file tools');
    await page.locator('.pane-empty-state').waitFor();
    assert.equal(await page.locator('.pane-empty-state').evaluate(element => getComputedStyle(element).display), 'grid', 'the empty workspace has a real layout style');
    const paneLocations = page.locator('.pane-location-list button');
    await paneLocations.nth(0).click(); await paneLocations.nth(0).click();
    await paneLocations.nth(1).click(); await paneLocations.nth(1).click();
    await page.locator('.pane-window').nth(3).waitFor();
    const paneWindows = page.locator('.pane-window');
    await page.setViewportSize({ width: 768, height: 844 });
    await frames();
    const tabletFileBounds = await page.locator('.pane-window:not(.pane-terminal-window)').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right }; }));
    assert.ok(tabletFileBounds.every(rect => rect.left >= 0 && rect.right <= 768), `new floating file panes stay inside the medium-width viewport: ${JSON.stringify(tabletFileBounds)}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await frames();
    const themeRoot = page.locator('.pane-explorer');
    await themeRoot.evaluate(element => { element.dataset.theme = 'light'; });
    const lightPaneContrast = await page.locator('.pane-window:not(.pane-terminal-window)').first().evaluate(element => {
        const luminance = color => {
            const channels = color.match(/[\d.]+/g).slice(0, 3).map(value => Number(value) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2);
            return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
        };
        const ratio = (foreground, background) => {
            const [high, low] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
            return (high + .05) / (low + .05);
        };
        const paneStyle = getComputedStyle(element);
        const titlebar = getComputedStyle(element.querySelector('.pane-window-titlebar'));
        return { pane: ratio(paneStyle.color, paneStyle.backgroundColor), title: ratio(titlebar.color, titlebar.backgroundColor), paneColor: paneStyle.color, paneBackground: paneStyle.backgroundColor, titleColor: titlebar.color, titleBackground: titlebar.backgroundColor };
    });
    assert.ok(lightPaneContrast.pane >= 4.5 && lightPaneContrast.title >= 4.5, `light-theme window surfaces preserve text contrast: ${JSON.stringify(lightPaneContrast)}`);
    await themeRoot.evaluate(element => { element.dataset.theme = 'default'; });
    await paneLocations.nth(0).click({ button: 'right' });
    assert.equal(await page.locator('.pane-context-menu').count(), 1);
    assert.deepEqual(await page.locator('.pane-context-menu button').allTextContents(), ['Open new window']);
    await page.locator('.pane-context-menu button').click();
    await paneWindows.nth(4).waitFor();
    await paneWindows.nth(4).locator('button[aria-label="Close window"]').click();
    await paneWindows.nth(0).click({ button: 'right' });
    assert.equal(await page.locator('.pane-context-menu button').count(), 9);
    await page.locator('.pane-context-menu button').filter({ hasText: 'Refresh' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await frames();
    const edgeFilePane = page.locator('.pane-window:not(.pane-terminal-window)').first();
    await edgeFilePane.dispatchEvent('contextmenu', { bubbles: true, button: 2, clientX: 387, clientY: 837 });
    const boundedFileMenu = page.locator('.pane-context-menu');
    await boundedFileMenu.waitFor();
    const boundedFileMenuBox = await boundedFileMenu.boundingBox();
    assert.ok(boundedFileMenuBox.x >= 0 && boundedFileMenuBox.y >= 0 && boundedFileMenuBox.x + boundedFileMenuBox.width <= 390 && boundedFileMenuBox.y + boundedFileMenuBox.height <= 844, `file context menu stays inside the narrow viewport: ${JSON.stringify(boundedFileMenuBox)}`);
    await boundedFileMenu.locator('button').filter({ hasText: 'Refresh' }).click();

    await paneLocations.nth(0).dispatchEvent('contextmenu', { bubbles: true, button: 2, clientX: 387, clientY: 837 });
    const boundedLaunchMenu = page.locator('.pane-terminal-launch-menu');
    await boundedLaunchMenu.waitFor();
    const boundedLaunchMenuBox = await boundedLaunchMenu.boundingBox();
    assert.ok(boundedLaunchMenuBox.x >= 0 && boundedLaunchMenuBox.y >= 0 && boundedLaunchMenuBox.x + boundedLaunchMenuBox.width <= 390 && boundedLaunchMenuBox.y + boundedLaunchMenuBox.height <= 844, `terminal launch menu stays inside the narrow viewport: ${JSON.stringify(boundedLaunchMenuBox)}`);
    await boundedLaunchMenu.getByRole('button', { name: 'Terminal', exact: true }).click();
    const terminalPane = page.locator('.pane-terminal-window').last();
    await terminalPane.waitFor();
    const terminalId = await terminalPane.getAttribute('data-window-id');
    const boundedTerminalMenu = page.locator('.pane-terminal-context-menu');
    const visibleTerminalBox = () => terminalPane.evaluate(element => {
        const rectangle = element.getBoundingClientRect();
        const visible = { left: Math.max(0, rectangle.left), top: Math.max(0, rectangle.top), right: Math.min(window.innerWidth, rectangle.right), bottom: Math.min(window.innerHeight, rectangle.bottom) };
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            const clip = ancestor.getBoundingClientRect();
            if (style.overflowX !== 'visible') {
                visible.left = Math.max(visible.left, clip.left);
                visible.right = Math.min(visible.right, clip.right);
            }
            if (style.overflowY !== 'visible') {
                visible.top = Math.max(visible.top, clip.top);
                visible.bottom = Math.min(visible.bottom, clip.bottom);
            }
        }
        return visible;
    });
    const terminalVisibleRect = await visibleTerminalBox();
    const terminalEdgeX = (terminalVisibleRect.left + terminalVisibleRect.right) / 2;
    const terminalEdgeY = Math.min(842, terminalVisibleRect.bottom - 2);
    assert.ok(terminalEdgeX >= terminalVisibleRect.left && terminalEdgeY >= terminalVisibleRect.top, 'terminal pane has a visible region for a real context click');
    await page.mouse.click(terminalEdgeX, terminalEdgeY, { button: 'right' });
    await boundedTerminalMenu.waitFor();
    const boundedTerminalMenuBox = await boundedTerminalMenu.boundingBox();
    assert.ok(boundedTerminalMenuBox.x >= 0 && boundedTerminalMenuBox.y >= 0 && boundedTerminalMenuBox.x + boundedTerminalMenuBox.width <= 390 && boundedTerminalMenuBox.y + boundedTerminalMenuBox.height <= 844, `terminal context menu stays inside the narrow viewport: ${JSON.stringify(boundedTerminalMenuBox)}`);
    await boundedTerminalMenu.getByRole('button', { name: 'Copy', exact: true }).dispatchEvent('click', { bubbles: true });
    await terminalPane.evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 387, clientY: 837, view: window })));
    await boundedTerminalMenu.waitFor();
    const terminalViewportEdgeBox = await boundedTerminalMenu.boundingBox();
    assert.ok(terminalViewportEdgeBox.x >= 0 && terminalViewportEdgeBox.y >= 0 && terminalViewportEdgeBox.x + terminalViewportEdgeBox.width <= 390 && terminalViewportEdgeBox.y + terminalViewportEdgeBox.height <= 844, `terminal context menu clamps an edge event into the viewport: ${JSON.stringify(terminalViewportEdgeBox)}`);
    await boundedTerminalMenu.getByRole('button', { name: 'Copy', exact: true }).dispatchEvent('click', { bubbles: true });

    const terminalOutput = terminalPane.locator('.pane-terminal-output');
    const outputWidthAtNarrow = await terminalOutput.evaluate(element => element.getBoundingClientRect().width);
    await page.getByRole('button', { name: 'Expand SSH target controls' }).click();
    await frames();
    assert.equal(Math.round(await terminalOutput.evaluate(element => element.getBoundingClientRect().width)), Math.round(outputWidthAtNarrow), 'the narrow target drawer does not resize the xterm output');
    await page.getByRole('button', { name: 'Expand terminal clipboard controls' }).click();
    await frames();
    assert.equal(await page.locator('.pane-terminal-target-panel').getByRole('button', { name: /SSH target controls/ }).getAttribute('aria-expanded'), 'false', 'narrow Terminal side drawers expand one at a time');
    assert.equal(Math.round(await terminalOutput.evaluate(element => element.getBoundingClientRect().width)), Math.round(outputWidthAtNarrow), 'the clipboard drawer also preserves xterm width');

    await page.setViewportSize({ width: 768, height: 844 });
    await frames();
    const outputWidthAtTablet = await terminalOutput.evaluate(element => element.getBoundingClientRect().width);
    await page.getByRole('button', { name: 'Expand SSH target controls' }).click();
    await frames();
    const targetPanelBounds = await page.locator('.pane-terminal-target-panel').boundingBox();
    assert.ok(targetPanelBounds.x >= 0 && targetPanelBounds.x + targetPanelBounds.width <= 768, `the expanded tablet side panel stays inside the viewport: ${JSON.stringify(targetPanelBounds)}`);
    assert.equal(Math.round(await terminalOutput.evaluate(element => element.getBoundingClientRect().width)), Math.round(outputWidthAtTablet), 'the tablet side rail expands outward without shrinking xterm');
    await page.getByRole('button', { name: 'Collapse SSH target controls' }).click();
    await frames();
    await page.getByRole('button', { name: 'Expand terminal clipboard controls' }).click();
    await frames();
    assert.equal(Math.round(await terminalOutput.evaluate(element => element.getBoundingClientRect().width)), Math.round(outputWidthAtTablet), 'the right tablet rail does not shrink xterm');
    await page.getByRole('button', { name: 'Collapse terminal clipboard controls' }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await frames();
    const outputWidthAtDesktop = await terminalOutput.evaluate(element => element.getBoundingClientRect().width);
    await page.getByRole('button', { name: 'Collapse SSH target controls' }).click();
    await frames();
    assert.equal(Math.round(await terminalOutput.evaluate(element => element.getBoundingClientRect().width)), Math.round(outputWidthAtDesktop), 'collapsing a desktop side rail leaves the central xterm width unchanged');
    await page.getByRole('button', { name: 'Expand SSH target controls' }).click();
    await frames();

    await page.setViewportSize({ width: 390, height: 120 });
    await frames();
    const shortViewportTerminalRect = await visibleTerminalBox();
    const shortViewportClickX = (shortViewportTerminalRect.left + shortViewportTerminalRect.right) / 2;
    const shortViewportClickY = Math.min(118, shortViewportTerminalRect.bottom - 2);
    assert.ok(shortViewportClickX >= shortViewportTerminalRect.left && shortViewportClickY >= shortViewportTerminalRect.top, 'terminal pane intersects the short viewport for a real context click');
    await page.mouse.click(shortViewportClickX, shortViewportClickY, { button: 'right' });
    await boundedTerminalMenu.waitFor();
    const shortViewportBounds = await page.evaluate(() => {
        const visible = window.visualViewport;
        const left = visible?.offsetLeft || 0;
        const top = visible?.offsetTop || 0;
        return {
            left,
            top,
            right: left + (visible?.width || window.innerWidth),
            bottom: top + (visible?.height || window.innerHeight)
        };
    });
    const shortViewportMenuBox = await boundedTerminalMenu.boundingBox();
    assert.ok(shortViewportMenuBox.x >= shortViewportBounds.left && shortViewportMenuBox.y >= shortViewportBounds.top && shortViewportMenuBox.x + shortViewportMenuBox.width <= shortViewportBounds.right && shortViewportMenuBox.y + shortViewportMenuBox.height <= shortViewportBounds.bottom, `terminal context menu stays inside the visible viewport: ${JSON.stringify({ shortViewportMenuBox, shortViewportBounds })}`);
    const shortMenuDimensions = await boundedTerminalMenu.evaluate(element => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, maxHeight: getComputedStyle(element).maxHeight }));
    assert.ok(shortMenuDimensions.clientHeight <= 104 && shortMenuDimensions.scrollHeight > shortMenuDimensions.clientHeight, `terminal menu constrains and scrolls its contents in a short viewport: ${JSON.stringify(shortMenuDimensions)}`);
    await page.mouse.click(5, 5);
    await boundedTerminalMenu.waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 390, height: 844 });
    await frames();

    const zFileBeforeFocus = page.locator('.pane-window:not(.pane-terminal-window)').last();
    await paneLocations.nth(1).click();
    await zFileBeforeFocus.waitFor();
    const zFileId = await zFileBeforeFocus.getAttribute('data-window-id');
    const zValues = async () => page.evaluate(({ fileId, currentTerminalId }) => ({ file: Number(getComputedStyle(document.querySelector(`[data-window-id="${fileId}"]`)).zIndex), terminal: Number(getComputedStyle(document.querySelector(`[data-window-id="${currentTerminalId}"]`)).zIndex) }), { fileId: zFileId, currentTerminalId: terminalId });
    let activeZ = await zValues();
    assert.ok(activeZ.file > activeZ.terminal, `new active file pane is above Terminal: ${JSON.stringify(activeZ)}`);
    await terminalPane.dispatchEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 20, pointerId: 1 });
    activeZ = await zValues();
    assert.ok(activeZ.terminal > activeZ.file, `clicked Terminal pane is above the file pane: ${JSON.stringify(activeZ)}`);
    await terminalPane.locator('button[aria-label="Minimize window"]').click();
    const terminalDockItem = page.locator(`.pane-minimized-item[data-window-id="${terminalId}"]`);
    await terminalDockItem.waitFor();
    await terminalDockItem.locator('.pane-minimized-restore').click();
    await terminalPane.waitFor({ state: 'visible' });
    await terminalPane.locator('button[aria-label="Close terminal window"]').click();
    await zFileBeforeFocus.locator('button[aria-label="Close window"]').click();
    await paneLocations.nth(0).click();
    const temporaryToolsPane = page.locator('.pane-window:not(.pane-terminal-window)').last();
    await temporaryToolsPane.waitFor();
    assert.ok(await page.locator('.pane-tool-grid button').first().isEnabled(), 'right-side file tools are clickable with an active file pane');
    await temporaryToolsPane.locator('button[aria-label="Close window"]').click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await frames();
    const rightToolbar = page.locator('.pane-tools');
    const toolbarBounds = await rightToolbar.boundingBox();
    assert.ok(toolbarBounds.x > 720 && toolbarBounds.x + toolbarBounds.width <= 1440, `the file tools rail stays on the right side of the workspace: ${JSON.stringify(toolbarBounds)}`);
    assert.equal(await page.locator('.pane-tool-grid').evaluate(element => element.closest('.pane-tools') !== null && element.closest('.pane-locations') === null), true, 'the looping viewport belongs to the right toolbar, not Locations');
    assert.equal(await page.locator('.pane-location-list .pane-tool-cycle').count(), 0, 'Location cards do not contain tool-loop cycles');
    const desktopToolColumns = await page.locator('.pane-tool-cycle').first().evaluate(element => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length);
    assert.equal(desktopToolColumns, 1, 'right-side file tool cards stack in one vertical column on desktop');
    assert.equal(await page.locator('.pane-context-menu').count(), 0);
    assert.equal(await page.locator('.pane-tool-grid button').first().isEnabled(), false, 'file actions disable after the last active file pane closes');
    assert.equal(await page.locator('.pane-tool-grid button').count(), 10, 'the loop rail contains the ten file actions, excluding Terminal');
    await page.setViewportSize({ width: 390, height: 600 });
    await frames();
    assert.equal(await page.locator('.pane-statusbar').evaluate(element => getComputedStyle(element).paddingLeft), '8px', 'the narrow status bar keeps its narrow padding after the Pane cascade');
    const loopingTools = page.locator('.pane-tool-grid');
    await page.waitForFunction(() => document.querySelector('.pane-tool-grid')?.classList.contains('is-looping'));
    assert.equal(await page.locator('.pane-locations .is-looping').count(), 0, 'the left Locations rail never receives the looping state');
    const loopMetrics = await loopingTools.evaluate(element => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollbarWidth: getComputedStyle(element).scrollbarWidth, cycles: element.querySelectorAll('.pane-tool-cycle').length }));
    assert.ok(loopMetrics.scrollHeight > loopMetrics.clientHeight, `Pane Tools scrolls when the action cards exceed the rail: ${JSON.stringify(loopMetrics)}`);
    assert.equal(loopMetrics.scrollbarWidth, 'none', 'the continuous tool rail hides its native scrollbar');
    assert.equal(loopMetrics.cycles, 3, 'the scroll rail renders before, original, and after cycles');
    const cloneSemantics = await loopingTools.locator('.pane-tool-cycle[aria-hidden="true"]').first().evaluate(element => ({ tabIndex: element.querySelector('button')?.tabIndex, hidden: element.getAttribute('aria-hidden') }));
    assert.deepEqual(cloneSemantics, { tabIndex: -1, hidden: 'true' }, 'visual loop clones do not duplicate keyboard or screen-reader stops');
    await loopingTools.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
    await frames();
    const loopAfterBottom = await loopingTools.evaluate(element => ({ scrollTop: element.scrollTop, maximum: element.scrollHeight - element.clientHeight }));
    assert.ok(loopAfterBottom.scrollTop < loopAfterBottom.maximum, `the end of the tool rail wraps to the next cycle: ${JSON.stringify(loopAfterBottom)}`);
    await loopingTools.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
    await frames();
    assert.ok(await loopingTools.evaluate(element => element.scrollTop > 0), 'scrolling above the first card wraps to the previous cycle');
    await page.evaluate(() => window.scrollTo(0, 80));
    await page.waitForFunction(() => window.scrollY > 0);
    await paneLocations.nth(0).evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 280, view: window })));
    await page.locator('.pane-context-menu').waitFor();
    const fixedPaneMenuBox = await page.locator('.pane-context-menu').boundingBox();
    assert.ok(Math.abs(fixedPaneMenuBox.y - 280) < 2, `the Pane context menu stays at visual-viewport coordinates while the document scrolls: ${JSON.stringify(fixedPaneMenuBox)}`);
    await page.mouse.click(5, 5);
    await page.locator('.pane-context-menu').waitFor({ state: 'detached' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.setViewportSize({ width: 1440, height: 900 });
    await frames();
    await page.waitForFunction(() => !document.querySelector('.pane-tool-grid')?.classList.contains('is-looping'));
    assert.equal(await loopingTools.evaluate(element => getComputedStyle(element).scrollbarWidth), 'none', 'the right tool rail hides its native scrollbar at every viewport size');
    await page.setViewportSize({ width: 1440, height: 600 });
    await frames();
    await page.waitForFunction(() => document.querySelector('.pane-tool-grid')?.classList.contains('is-looping'));
    const shortDesktopToolRail = await loopingTools.evaluate(element => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, columns: getComputedStyle(element.querySelector('.pane-tool-cycle')).gridTemplateColumns.trim().split(/\s+/).length, inRightToolbar: element.closest('.pane-tools') !== null }));
    assert.ok(shortDesktopToolRail.scrollHeight > shortDesktopToolRail.clientHeight && shortDesktopToolRail.inRightToolbar, `a short desktop viewport loops the vertically stacked right toolbar: ${JSON.stringify(shortDesktopToolRail)}`);
    assert.equal(shortDesktopToolRail.columns, 1, 'short desktop tool cards remain a single vertical column');
    await page.setViewportSize({ width: 1440, height: 900 });
    await frames();
    await page.waitForFunction(() => !document.querySelector('.pane-tool-grid')?.classList.contains('is-looping'));
    const draggablePane = paneWindows.nth(3);
    const beforeDrag = await draggablePane.boundingBox();
    const titlebar = draggablePane.locator('.pane-window-titlebar');
    const titlebarBox = await titlebar.boundingBox();
    await page.mouse.move(titlebarBox.x + 30, titlebarBox.y + 18);
    await page.mouse.down();
    await page.mouse.move(titlebarBox.x + 110, titlebarBox.y + 58);
    await page.mouse.up();
    const afterDrag = await draggablePane.boundingBox();
    assert.ok(afterDrag.x !== beforeDrag.x || afterDrag.y !== beforeDrag.y, 'pane titlebar drag moves the window');
    await paneWindows.nth(1).locator('.pane-view-switch button', { hasText: 'Grid' }).evaluate((button) => button.click());
    await paneWindows.nth(2).locator('.pane-view-switch button', { hasText: 'Grid' }).evaluate((button) => button.click());
    await paneWindows.nth(3).locator('.pane-view-switch button', { hasText: 'Details' }).evaluate((button) => button.click());
    await paneWindows.nth(3).locator('button[aria-label="Close window"]').click();
    await page.locator('.pane-window').nth(2).locator('button[aria-label="Close window"]').click();
    await page.locator('.pane-window').nth(0).locator('button[aria-label="Close window"]').click();
    await page.locator('.pane-window').nth(0).locator('button[aria-label="Close window"]').click();
    await paneLocations.nth(0).click();
    await page.locator('.pane-window').first().locator('.pane-view-switch button.active').waitFor();
    assert.equal(await page.locator('.pane-window').first().locator('.pane-view-switch button.active').textContent(), 'Grid');
    const corePaneTypography = [
        ['root', '.pane-explorer'],
        ['sectionLabel', '.pane-heading'],
        ['windowTitle', '.pane-window-titlebar strong'],
        ['windowMeta', '.pane-window-titlebar small'],
        ['toolbar', '.pane-window-toolbar button'],
        ['location', '.pane-location-list strong'],
        ['locationMeta', '.pane-location-list small'],
        ['fileContent', '.pane-files'],
        ['toolLabel', '.pane-tool-grid button strong'],
        ['status', '.pane-statusbar']
    ];
    await page.setViewportSize({ width: 390, height: 844 });
    await frames();
    const narrowCorePaneTypography = await measurePaneTypography(corePaneTypography);
    await page.setViewportSize({ width: 1440, height: 900 });
    await frames();
    const desktopCorePaneTypography = await measurePaneTypography(corePaneTypography);
    await page.setViewportSize({ width: 2560, height: 1440 });
    await frames();
    const largeCorePaneTypography = await measurePaneTypography(corePaneTypography);
    assertResponsiveTypography(narrowCorePaneTypography, desktopCorePaneTypography, largeCorePaneTypography, 'Pane Style core typography');
    await page.setViewportSize({ width: 1440, height: 900 });
    for (let index = 0; index < 6; index++) await paneLocations.nth(index % 2).click();
    const managedPaneWindows = page.locator('.pane-window');
    const managedPane = managedPaneWindows.last();
    await managedPane.locator('.pane-empty').waitFor({ state: 'detached' });
    await managedPane.locator('.pane-window-navigation input').fill('preserved-query');
    await page.waitForTimeout(50);
    assert.equal(await managedPane.locator('.pane-window-navigation input').inputValue(), 'preserved-query', 'pane query is captured before minimize');
    const panePositionBeforeMaximize = await managedPane.boundingBox();
    await managedPane.locator('button[aria-label="Maximize window"]').click();
    await managedPane.locator('button[aria-label="Restore window"]').waitFor();
    assert.match(await managedPane.getAttribute('class'), /is-maximized/);
    const panePositionMaximized = await managedPane.boundingBox();
    assert.ok(panePositionMaximized.width > panePositionBeforeMaximize.width || panePositionMaximized.height > panePositionBeforeMaximize.height, 'maximize expands the pane');
    await managedPane.locator('button[aria-label="Restore window"]').click();
    await managedPane.locator('button[aria-label="Maximize window"]').waitFor();
    assert.doesNotMatch(await managedPane.getAttribute('class'), /is-maximized/);
    const panePositionBeforeMinimize = await managedPane.boundingBox();
    for (let index = 0; index < await managedPaneWindows.count(); index++) {
        const pane = managedPaneWindows.nth(index);
        if (await pane.isVisible()) await pane.locator('button[aria-label="Minimize window"]').evaluate((button) => button.click());
    }
    const minimizedItems = page.locator('.pane-minimized-item');
    const minimizedCount = await minimizedItems.count();
    const managedPaneCount = await managedPaneWindows.count();
    assert.ok(managedPaneCount >= 7, `enough panes exist to verify dock wrapping (${managedPaneCount})`);
    assert.equal(minimizedCount, managedPaneCount, 'all open panes are represented in the minimized dock');
    const minimizedGeometry = await minimizedItems.evaluateAll((items) => items.map((item) => { const rect = item.getBoundingClientRect(); return { x: rect.x, y: rect.y }; }));
    assert.ok(new Set(minimizedGeometry.map((item) => item.x)).size > 1, 'minimized panes fill the dock from left to right');
    assert.ok(new Set(minimizedGeometry.map((item) => item.y)).size > 1, 'minimized panes wrap into multiple rows');
    const dockBox = await page.locator('.pane-minimized-dock').boundingBox();
    assert.ok(dockBox.x < 1440 / 2 && dockBox.y > 0, 'minimized dock stays at the lower left');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'minimized dock does not create horizontal overflow');
    const dockSurface = await page.locator('.pane-minimized-dock').evaluate((dock) => { const style = getComputedStyle(dock); return { borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], background: style.backgroundColor, shadow: style.boxShadow }; });
    assert.deepEqual(dockSurface, { borders: ['0px', '0px', '0px', '0px'], background: 'rgba(0, 0, 0, 0)', shadow: 'none' }, 'minimized dock has no outer frame');
    const managedPaneId = await managedPane.getAttribute('data-window-id');
    const managedDockItem = page.locator(`.pane-minimized-item[data-window-id="${managedPaneId}"]`);
    const restoreButton = managedDockItem.locator('.pane-minimized-restore');
    assert.equal(await restoreButton.getAttribute('title'), '點擊還原', 'restore button has a native tooltip');
    await managedDockItem.locator('.pane-minimized-restore').click();
    await managedPane.waitFor({ state: 'visible' });
    assert.equal(await managedPane.locator('.pane-window-navigation input').inputValue(), 'preserved-query', 'restore preserves pane state');
    const panePositionAfterRestore = await managedPane.boundingBox();
    assert.ok(Math.abs(panePositionAfterRestore.x - panePositionBeforeMinimize.x) < 2 && Math.abs(panePositionAfterRestore.y - panePositionBeforeMinimize.y) < 2, 'restore preserves pane position');
    const sourceDockItem = page.locator('.pane-minimized-item').filter({ hasText: 'Location A' }).first();
    await sourceDockItem.locator('.pane-minimized-restore').click();
    const paneSource = page.locator('.pane-window:not(.pane-terminal-window):not(.is-minimized)').filter({ hasText: 'Location A' }).first();
    const paneDestination = page.locator('.pane-window:not(.pane-terminal-window):not(.is-minimized)').filter({ hasText: 'Location B' }).first();
    await paneSource.locator('.pane-file-tile').nth(1).waitFor();
    const dispatchPaneDrop = async (firstIndex, secondIndex) => {
        const rows = paneSource.locator('.pane-file-tile');
        await rows.nth(firstIndex).dispatchEvent('click');
        await rows.nth(secondIndex).dispatchEvent('click', { ctrlKey: true });
        assert.equal(await paneSource.locator('.pane-file-tile.selected').count(), 2, 'Pane selection includes both transfer items');
        const destinationFiles = await paneDestination.locator('.pane-files').elementHandle();
        await rows.nth(firstIndex).evaluate((row, target) => {
            const dataTransfer = new DataTransfer();
            row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
            target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
        }, destinationFiles);
    };
    pasteMode = 'success';
    pasteDelay = 500;
    await dispatchPaneDrop(0, 1);
    const paneTransfer = page.locator('.pane-transfer-cover');
    await paneTransfer.waitFor();
    assert.equal(await paneTransfer.locator('.pane-transfer-current strong').textContent(), 'file0.txt');
    assert.equal(await paneTransfer.locator('.pane-transfer-counts strong').textContent(), '0 of 2 items moved');
    await paneTransfer.locator('.pane-transfer-current strong').filter({ hasText: 'file1.txt' }).waitFor();
    await paneTransfer.getByText('1 of 2 items moved', { exact: true }).waitFor();
    await paneTransfer.getByText('1 remaining', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.pane-transfer-cover')?.dataset.status === 'completed');
    await paneTransfer.waitFor({ state: 'detached', timeout: 5000 });
    pasteMode = 'partial';
    pasteDelay = 220;
    await dispatchPaneDrop(2, 3);
    await page.waitForFunction(() => document.querySelector('.pane-transfer-cover')?.dataset.status === 'partial');
    assert.match(await page.locator('.pane-transfer-counts').innerText(), /1 of 2 items moved/);
    assert.match(await page.locator('.pane-transfer-counts').innerText(), /0 remaining/);
    assert.match(await page.locator('.pane-transfer-errors').innerText(), /fixture source cleanup failed/);
    await page.waitForTimeout(1900);
    assert.equal(await page.locator('.pane-transfer-cover').count(), 1, 'failed transfer remains open after the success auto-close interval');
    await page.locator('.pane-transfer-actions button').click();
    await page.locator('.pane-transfer-cover').waitFor({ state: 'detached' });
    pasteMode = 'success';
    pasteDelay = 0;
    await paneSource.locator('button[aria-label="Close window"]').click();
    await managedPane.dispatchEvent('pointerdown', { bubbles: true, pointerId: 1 });
    report.checks.push('Pane transfer streams actual item names and counts, auto-closes full success, and preserves partial failure details');
    uploadMode = 'running';
    await page.getByRole('button', { name: 'Pane Upload', exact: true }).click();
    await page.locator('.pane-explorer input[type="file"]').setInputFiles({ name: 'pane-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('pane upload') });
    await waitFor(() => batches.size === 5 && [...batches.values()][4].status === 'completed', 'Pane API upload uses the resumable session queue');
    assert.equal([...batches.values()][4].uploads, 1);
    report.checks.push('Pane Style upload shares resumable API sessions, chunk integrity, and Transfer Queue completion');
    await managedPane.locator('button[aria-label="Close window"]').click();
    while (await page.locator('.pane-minimized-item').count()) await page.locator('.pane-minimized-item').last().locator('.pane-minimized-close').click();
    await page.locator('.pane-minimized-dock').waitFor({ state: 'detached' });
    await page.locator('.account').click();
    const styleSettings = page.getByRole('button', { name: 'Style settings', exact: true });
    await styleSettings.click();
    const accountPaneTypography = [
        ['accountSummary', '.pane-account-menu .account-summary strong'],
        ['accountSummaryMeta', '.pane-account-menu .account-summary span'],
        ['styleButton', '.pane-account-menu .style-settings-trigger'],
        ['styleHeading', '.pane-account-style h2'],
        ['styleDescription', '.pane-account-style p'],
        ['styleLabel', '.pane-account-style label'],
        ['styleSelect', '.pane-account-style select']
    ];
    await page.setViewportSize({ width: 390, height: 844 });
    await frames();
    const narrowAccountPaneTypography = await measurePaneTypography(accountPaneTypography);
    await page.setViewportSize({ width: 1440, height: 900 });
    await frames();
    const desktopAccountPaneTypography = await measurePaneTypography(accountPaneTypography);
    await page.setViewportSize({ width: 2560, height: 1440 });
    await frames();
    const largeAccountPaneTypography = await measurePaneTypography(accountPaneTypography);
    assertResponsiveTypography(narrowAccountPaneTypography, desktopAccountPaneTypography, largeAccountPaneTypography, 'Pane Style Account Panel typography');
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator('.pane-account-menu').count(), 1, 'Account Panel stays open when Style settings expands');
    assert.equal(await styleSettings.getAttribute('aria-expanded'), 'true');
    await styleSettings.click();
    assert.equal(await page.locator('.pane-account-menu').count(), 1, 'Account Panel stays open when Style settings collapses');
    assert.equal(await styleSettings.getAttribute('aria-expanded'), 'false');
    await styleSettings.click();
    await page.locator('.pane-account-style select').last().selectOption('circuit');
    assert.equal(await page.locator('.pane-account-menu').count(), 1, 'Account Panel stays open while settings controls are used');
    await page.mouse.click(5, 5);
    await page.locator('.pane-account-menu').waitFor({ state: 'detached' });
    report.checks.push('pane style switch, independent floating windows, Details/Grid view, maximize/minimize/restore dock, and Account Panel settings persistence');

    const backgroundInput = page.locator('input[type="file"][accept="image/*"]');
    assert.equal(await page.locator('[data-background-editor]').count(), 0, 'background editor stays hidden before an image is selected');
    const backgroundFixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    await page.locator('.account').click();
    await page.getByRole('button', { name: 'Style settings', exact: true }).click();
    await backgroundInput.setInputFiles({ name: 'background.png', mimeType: 'image/png', buffer: backgroundFixture });
    await page.locator('[data-background-editor]').waitFor();
    await page.locator('.pane-account-menu').waitFor({ state: 'detached' });
    const backgroundEditorTypography = [
        ['eyebrow', '.pane-background-eyebrow'],
        ['imageName', '.pane-background-editor-header strong'],
        ['metadata', '.pane-background-meta'],
        ['sectionLabel', '.pane-background-label'],
        ['placementControl', '.pane-background-position-controls button'],
        ['scaleOutput', '.pane-background-scale-controls output'],
        ['editorAction', '.pane-background-editor-actions button']
    ];
    await page.setViewportSize({ width: 390, height: 844 });
    await frames();
    const narrowBackgroundEditorTypography = await measurePaneTypography(backgroundEditorTypography);
    await page.setViewportSize({ width: 1440, height: 900 });
    await frames();
    const desktopBackgroundEditorTypography = await measurePaneTypography(backgroundEditorTypography);
    await page.setViewportSize({ width: 2560, height: 1440 });
    await frames();
    const largeBackgroundEditorTypography = await measurePaneTypography(backgroundEditorTypography);
    assertResponsiveTypography(narrowBackgroundEditorTypography, desktopBackgroundEditorTypography, largeBackgroundEditorTypography, 'Pane Style Background editor typography');
    await page.setViewportSize({ width: 1440, height: 900 });
    const backgroundLayer = page.locator('.pane-custom-background');
    const initialBackground = await page.locator('.pane-explorer').evaluate((root) => {
        const layer = root.querySelector('.pane-custom-background');
        const style = getComputedStyle(layer);
        return {
            image: style.backgroundImage,
            transform: style.transform,
            scale: root.style.getPropertyValue('--pane-background-scale').trim(),
            position: root.style.getPropertyValue('--pane-background-position').trim()
        };
    });
    assert.match(initialBackground.image, /blob:/, 'selected image is applied to the real background layer');
    assert.equal(initialBackground.scale, '1');
    assert.equal(initialBackground.position, '50% 50%');
    await page.getByRole('status').filter({ hasText: 'background.png is now the background.' }).waitFor();
    assert.equal(await page.getByRole('status').filter({ hasText: 'background.png is now the background.' }).count(), 1);
    await page.getByRole('button', { name: 'Move background right' }).click();
    assert.equal(await page.locator('.pane-explorer').evaluate((root) => root.style.getPropertyValue('--pane-background-position').trim()), '60% 50%');
    await page.getByRole('button', { name: 'Center background' }).click();
    assert.equal(await page.locator('.pane-explorer').evaluate((root) => root.style.getPropertyValue('--pane-background-position').trim()), '50% 50%');
    await page.getByRole('button', { name: 'Expand background' }).click();
    await page.waitForFunction(() => {
        const transform = getComputedStyle(document.querySelector('.pane-custom-background')).transform;
        const scale = Number(transform.match(/^matrix(?:3d)?\(([^,]+)/)?.[1]);
        return Math.abs(scale - 1.1) < 0.01;
    });
    const expandedBackground = await page.locator('.pane-explorer').evaluate((root) => ({ scale: root.style.getPropertyValue('--pane-background-scale').trim(), transform: getComputedStyle(root.querySelector('.pane-custom-background')).transform }));
    assert.equal(expandedBackground.scale, '1.1');
    assert.notEqual(expandedBackground.transform, initialBackground.transform, 'expanding changes the rendered image transform');
    const backgroundScaleOutput = page.locator('output[aria-label="Background scale"]');
    assert.equal(await backgroundScaleOutput.textContent(), '110%');
    await page.getByRole('button', { name: 'Shrink background' }).click();
    assert.equal(await backgroundScaleOutput.textContent(), '100%');
    for (let index = 0; index < 5; index++) await page.getByRole('button', { name: 'Shrink background' }).click();
    assert.equal(await backgroundScaleOutput.textContent(), '50%');
    assert.equal(await page.getByRole('button', { name: 'Shrink background' }).isDisabled(), true, 'shrink stops at the minimum scale');
    for (let index = 0; index < 15; index++) await page.getByRole('button', { name: 'Expand background' }).click();
    assert.equal(await backgroundScaleOutput.textContent(), '200%');
    assert.equal(await page.getByRole('button', { name: 'Expand background' }).isDisabled(), true, 'expand stops at the maximum scale');
    await page.getByRole('button', { name: 'Reset placement', exact: true }).click();
    assert.equal(await backgroundScaleOutput.textContent(), '100%');
    assert.equal(await page.locator('.pane-explorer').evaluate((root) => root.style.getPropertyValue('--pane-background-position').trim()), '50% 50%');
    await page.getByRole('button', { name: 'Close background editor', exact: true }).click();
    assert.equal(await page.locator('[data-background-editor]').count(), 0, 'closing hides the editor without removing the background');
    await page.locator('.account').click();
    await page.getByRole('button', { name: 'Style settings', exact: true }).click();
    await page.locator('.pane-background-edit-button').click();
    await page.locator('[data-background-editor]').waitFor();
    const existingImage = await page.locator('.pane-explorer').evaluate((root) => root.style.getPropertyValue('--pane-background-image').trim());
    await backgroundInput.setInputFiles({ name: 'too-large.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
    await page.waitForFunction(() => document.querySelector('.pane-toast')?.textContent.includes('5MB'));
    assert.equal(await page.locator('.pane-explorer').evaluate((root) => root.style.getPropertyValue('--pane-background-image').trim()), existingImage, 'oversized image does not replace the current background');
    await page.getByRole('button', { name: 'Move background right' }).click();
    await page.getByRole('button', { name: 'Expand background' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await frames();
    const editorGeometry = await page.locator('[data-background-editor]').boundingBox();
    assert.ok(editorGeometry.x >= 0 && editorGeometry.x + editorGeometry.width <= 390, `background editor stays inside the narrow viewport: ${JSON.stringify(editorGeometry)}`);
    const viewportOverflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth, bodyScrollWidth: document.body.scrollWidth }));
    assert.equal(viewportOverflow.scrollWidth <= viewportOverflow.viewportWidth, true, `background editor does not create horizontal overflow: ${JSON.stringify(viewportOverflow)}`);
    const saveResponse = page.waitForResponse(response => response.url().endsWith('/api/user/background') && response.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    assert.equal((await saveResponse).status(), 200, 'Save writes the background to the backend');
    await page.locator('[data-background-editor]').waitFor({ state: 'detached' });
    await page.getByRole('status').filter({ hasText: 'Background placement saved.' }).waitFor();
    assert.equal(requests.findLast(request => request.path === '/api/user/background' && request.method === 'PUT').body.position.x, 60, 'Save writes the current background position to the backend');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await page.locator('.pane-location-list button').first().waitFor();
    await page.locator('.pane-custom-background').waitFor();
    const restoredBackground = await page.locator('.pane-explorer').evaluate((root) => ({
        image: root.style.getPropertyValue('--pane-background-image').trim(),
        scale: root.style.getPropertyValue('--pane-background-scale').trim(),
        position: root.style.getPropertyValue('--pane-background-position').trim()
    }));
    assert.match(restoredBackground.image, /blob:/, 'stored background image is restored after reload');
    assert.equal(restoredBackground.scale, '1.1');
    assert.equal(restoredBackground.position, '60% 50%');
    assert.equal(await page.locator('[data-background-editor]').count(), 0, 'restored background does not force the editor open');
    await context.addCookies([{ name: 'fixtureUserB', value: '1', url: origin }]);
    await page.reload();
    await page.locator('.pane-location-list button').first().waitFor();
    assert.equal(await page.locator('.pane-custom-background').count(), 0, 'a second user does not inherit the first user background');
    await page.locator('.account').click();
    await page.getByRole('button', { name: 'Style settings', exact: true }).click();
    await backgroundInput.setInputFiles({ name: 'background-b.png', mimeType: 'image/png', buffer: backgroundFixture });
    await page.locator('[data-background-editor]').waitFor();
    const userBSaveResponse = page.waitForResponse(response => response.url().endsWith('/api/user/background') && response.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    assert.equal((await userBSaveResponse).status(), 200);
    await page.locator('[data-background-editor]').waitFor({ state: 'detached' });
    await page.getByRole('status').filter({ hasText: 'Background placement saved.' }).waitFor();
    await context.addCookies([{ name: 'fixtureUserB', value: '0', url: origin }]);
    await page.reload();
    await page.locator('.pane-location-list button').first().waitFor();
    await page.locator('.pane-custom-background').waitFor();
    const userARestoredAfterSwitch = await page.locator('.pane-explorer').evaluate((root) => ({
        scale: root.style.getPropertyValue('--pane-background-scale').trim(),
        position: root.style.getPropertyValue('--pane-background-position').trim()
    }));
    assert.equal(userARestoredAfterSwitch.scale, '1.1', 'switching users preserves User A background scale');
    assert.equal(userARestoredAfterSwitch.position, '60% 50%', 'switching users preserves User A background position');
    await page.locator('.account').click();
    await page.getByRole('button', { name: 'Style settings', exact: true }).click();
    await page.locator('.pane-background-edit-button').click();
    await page.locator('[data-background-editor]').waitFor();
    await page.getByRole('button', { name: 'Remove image', exact: true }).click();
    await page.locator('[data-background-editor]').waitFor({ state: 'detached' });
    assert.equal(await backgroundLayer.count(), 0, 'removing the image restores the default background layer');
    report.checks.push('background editor appears only after a valid image, applies backend user-scoped blob imagery, isolates User A/User B, moves and scales the real layer, explicitly saves placement, enforces 5 MiB, and remains responsive');

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
