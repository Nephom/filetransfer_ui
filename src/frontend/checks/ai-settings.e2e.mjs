import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const adminHtml = fs.readFileSync(path.join(root, 'src/frontend/private/admin.html'));
const requests = [];
let environmentManagedKey = false;
const config = {
    locations: [{ id: 'fixture', displayName: 'Fixture', rootPath: '/fixture', storageType: 'local', enabled: true, readOnly: false, order: 0 }],
    ai: {
        enabled: true, provider: 'custom', baseUrl: 'http://ai.fixture/v1', apiKey: '', model: 'legacy-model', models: ['legacy-model'],
        requestTimeoutMs: 60000, contextWindowTokens: 32768, maxOutputTokens: 8192, maxInputBytes: 1024,
        maxArchiveFiles: 10, maxArchiveExpandedBytes: 4096, maxSingleExpandedFileBytes: 1024,
        maxNestedArchiveDepth: 2, maxChunkTokens: 1000, chunkOverlapLines: 5, maxRetries: 1,
        systemPrompt: '', apiKeyManagedByEnvironment: false, modelManagedByEnvironment: false
    }
};
const schema = { ai: {
    enabled: { type: 'boolean', label: 'Enable AI analysis' },
    provider: { type: 'enum', label: 'AI provider', options: ['ollama', 'vllm', 'omlx', 'openai', 'custom'] },
    baseUrl: { type: 'url', label: 'AI API URL' },
    apiKey: { type: 'secret', label: 'AI API key' },
    model: { type: 'string', label: 'AI model' },
    models: { type: 'modelList', label: 'Available AI models' },
    requestTimeoutMs: { type: 'integer', label: 'Request timeout (ms)' },
    contextWindowTokens: { type: 'integer', label: 'Context window' },
    maxOutputTokens: { type: 'integer', label: 'Maximum output tokens' },
    maxInputBytes: { type: 'integer', label: 'Maximum input bytes' },
    maxArchiveFiles: { type: 'integer', label: 'Maximum archive files' },
    maxArchiveExpandedBytes: { type: 'integer', label: 'Maximum archive expanded bytes' },
    maxSingleExpandedFileBytes: { type: 'integer', label: 'Maximum single expanded file bytes' },
    maxNestedArchiveDepth: { type: 'integer', label: 'Maximum nested archive depth' },
    maxChunkTokens: { type: 'integer', label: 'Maximum chunk tokens' },
    chunkOverlapLines: { type: 'integer', label: 'Chunk overlap lines' },
    maxRetries: { type: 'integer', label: 'Maximum retries' },
    systemPrompt: { type: 'textarea', label: 'System prompt' }
} };

const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = req.headers['content-type']?.includes('application/json') && raw ? JSON.parse(raw) : null;
    requests.push({ path: req.url, method: req.method, body });
    const json = (value, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(value));
    };

    if (req.url === '/auth/verify') return json({ user: { id: 0, username: 'fixture-admin', role: 'admin' } });
    if (req.url === '/api/admin/config' && req.method === 'GET') return json({ config, schema, success: true });
    if (req.url === '/api/admin/config' && req.method === 'PUT') return json({ success: true, message: 'Configuration saved.' });
    if (req.url === '/api/admin/config/ai-test' && req.method === 'POST') {
        if (body.apiKey !== 'fixture-test-key' && !(environmentManagedKey && body.apiKey === undefined)) return json({ success: false, code: 'AI_API_KEY_MISSING', error: 'Configure an API key.' }, 400);
        return json({ success: true, models: ['model-a', 'model-b'], selectedModel: body.model, selectedModelAvailable: false });
    }
    if (req.url === '/api/admin/users') return json({ users: [] });
    if (req.url === '/api/files/cache-stats') return json({ initialized: true, totalFiles: 1 });
    if (req.url.startsWith('/api/')) return json({ success: true, users: [], locations: [], stats: {}, cache: {} });
    if (req.url === '/admin' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(adminHtml);
    }
    res.writeHead(404);
    res.end('Not found');
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    page.on('dialog', dialog => dialog.accept());
    await page.goto(`${origin}/admin`);
    await page.getByRole('button', { name: 'Manage Configuration' }).click();

    const connection = page.locator('#aiConnectionStatus');
    await connection.waitFor();
    await page.waitForFunction(() => document.querySelector('#aiConnectionStatus')?.classList.contains('error'));
    assert.match(await connection.textContent(), /API key is missing/);

    await page.locator('#config-ai-apiKey').fill('fixture-test-key');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await page.locator('#aiDiscoveredModels').getByText('model-a').waitFor();
    assert.match(await connection.textContent(), /selected model.*not found/i);

    await page.getByRole('button', { name: 'Add model model-a' }).click();
    assert.equal(await page.locator('#config-ai-model').inputValue(), 'model-a', 'first added model becomes active when the old model is unavailable');
    assert.match(await connection.textContent(), /Connected/);
    await page.getByRole('button', { name: 'Add model model-b' }).click();
    await page.getByRole('button', { name: 'Remove configured model model-a' }).click();
    assert.equal(await page.locator('#config-ai-model').inputValue(), 'model-b', 'removing the active model selects the remaining model');
    await page.getByRole('button', { name: 'Remove configured model legacy-model' }).click();
    assert.equal(await page.locator('#config-ai-models').inputValue(), '["model-b"]');

    await page.getByRole('button', { name: /Save Configuration/ }).click();
    await page.waitForFunction(() => !document.getElementById('configModal')?.classList.contains('active'));
    const save = requests.find(request => request.path === '/api/admin/config' && request.method === 'PUT');
    assert.ok(save, 'the Admin panel submits its configuration');
    assert.deepEqual(save.body.ai.models, ['model-b']);
    assert.equal(save.body.ai.model, 'model-b');
    assert.equal(save.body.ai.apiKey, 'fixture-test-key');
    assert.ok(requests.some(request => request.path === '/api/admin/config/ai-test' && request.body?.apiKey === 'fixture-test-key'), 'Test sends the entered key to the server for validation');

    environmentManagedKey = true;
    config.ai.apiKey = '[SET]';
    config.ai.apiKeyManagedByEnvironment = true;
    config.ai.model = 'model-b';
    config.ai.models = ['model-b'];
    config.ai.modelManagedByEnvironment = true;
    await page.goto(`${origin}/admin`);
    await page.getByRole('button', { name: 'Manage Configuration' }).click();
    await page.waitForFunction(() => document.querySelector('#aiConnectionStatus')?.classList.contains('success'));
    assert.equal(await page.locator('#config-ai-apiKey').isDisabled(), true, 'environment-managed keys cannot be edited in Admin');
    assert.equal(await page.locator('#config-ai-model').isDisabled(), true, 'environment-managed active models are read-only in Admin');
    const environmentTest = requests.filter(request => request.path === '/api/admin/config/ai-test').at(-1);
    assert.equal(environmentTest.body.model, 'model-b');
    assert.equal(Object.hasOwn(environmentTest.body, 'apiKey'), false, 'Admin relies on the effective environment key without sending its value');
    console.log('PASS: Admin AI connection test, red readiness warnings, and configured-model add/remove/save.');
} finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
