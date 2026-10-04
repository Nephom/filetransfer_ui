const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const tar = require('tar');
const { splitText } = require('./chunker');
const { extractArchive, safeEntry } = require('./archive-reader');
const { DEFAULT_SYSTEM_PROMPT, analysisContext } = require('./prompt');
const { AnalysisQueue } = require('./analysis-queue');
const { chunkOptions, contextInputBudget, groupByTokenBudget } = require('./analysis-job');
const { complete, listModels } = require('./openai-compatible');

const waitFor = (predicate, message) => new Promise((resolve, reject) => {
  const deadline = Date.now() + 2000;
  const check = () => {
    if (predicate()) return resolve();
    if (Date.now() >= deadline) return reject(new Error(message));
    setTimeout(check, 10);
  };
  check();
});

test('keeps the fixed prompt neutral for complete and partial logs', () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /完整檔案/);
  assert.match(analysisContext({ source: 'x.log', complete: true }), /完整檔案：是/);
  assert.match(analysisContext({ source: 'x.log', complete: false, chunkIndex: 1, chunkCount: 3 }), /第 2 \/ 3 段/);
});

test('splits text into bounded chunks with source line metadata', () => {
  const chunks = splitText(Array.from({ length: 200 }, (_, index) => `${index} ERROR timeout`).join('\n'), { maxTokens: 100, overlapLines: 3 });
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].lineStart, 1);
  assert.ok(chunks.every(chunk => chunk.tokenCount <= 100));
});

test('maps configured chunk limits into the actual chunker options and reserves output context', () => {
  const config = { contextWindowTokens: 32768, maxOutputTokens: 8192, maxChunkTokens: 12000, chunkOverlapLines: 17 };
  assert.deepEqual(chunkOptions(config), { maxTokens: 12000, overlapLines: 17 });
  assert.equal(contextInputBudget(config), 22576);
  assert.deepEqual(groupByTokenBudget([{ id: 'a' }, { id: 'b' }], 10000).length, 1);
});

test('bounds an individual oversized summary item before grouping', () => {
  const groups = groupByTokenBudget([{ source: 'large.log', analysis: { summary: 'x'.repeat(10000) } }], 100);
  assert.equal(groups.length, 1);
  assert.ok(groups[0][0].truncated);
});

test('discovers and de-duplicates OpenAI-compatible model IDs with the configured API key', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-a' }, { id: ' model-b ' }] }) };
  };
  try {
    assert.deepEqual(await listModels({ config: { baseUrl: 'https://ai.example/v1/', apiKey: 'fixture-secret' } }), ['model-a', 'model-b']);
    assert.equal(request.url, 'https://ai.example/v1/models');
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.headers.Authorization, 'Bearer fixture-secret');
    assert.equal(request.options.headers.Accept, 'application/json');
  } finally { global.fetch = originalFetch; }
});

test('AI completion sends the same trimmed API key used for model discovery', async () => {
  const originalFetch = global.fetch;
  let authorization;
  global.fetch = async (_url, options) => {
    authorization = options.headers.Authorization;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  try {
    await complete({ config: {
      baseUrl: 'https://ai.example/v1', apiKey: ' fixture-secret ', model: 'fixture-model',
      requestTimeoutMs: 1000, maxOutputTokens: 100
    }, userPrompt: 'test' });
    assert.equal(authorization, 'Bearer fixture-secret');
  } finally { global.fetch = originalFetch; }
});

test('classifies invalid URLs, rejected credentials, unavailable models, and timed-out model discovery', async () => {
  const originalFetch = global.fetch;
  try {
    await assert.rejects(listModels({ config: { baseUrl: 'file:///etc/passwd' } }), { code: 'AI_URL_INVALID' });

    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'secret provider detail' } }) });
    await assert.rejects(listModels({ config: { baseUrl: 'https://ai.example/v1', apiKey: 'bad-key' } }), error => {
      assert.equal(error.code, 'AI_AUTH_FAILED');
      assert.doesNotMatch(error.message, /secret provider detail|bad-key/);
      return true;
    });

    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
    await assert.rejects(listModels({ config: { baseUrl: 'https://ai.example/v1', apiKey: 'fixture-key' } }), { code: 'AI_NO_MODELS' });

    global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    await assert.rejects(listModels({ config: { baseUrl: 'https://ai.example/v1' }, timeoutMs: 5 }), { code: 'AI_TIMEOUT' });
  } finally { global.fetch = originalFetch; }
});

test('rejects unsafe archive paths', () => {
  assert.throws(() => safeEntry('../outside.log'), /Unsafe archive entry/);
  assert.throws(() => safeEntry('/outside.log'), /Unsafe archive entry/);
  assert.equal(safeEntry('logs/kernel.log'), 'logs/kernel.log');
});

test('extracts tar text entries into an isolated directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'filetransfer-ai-test-'));
  const source = path.join(root, 'source');
  const archive = path.join(root, 'logs.tar');
  await fs.mkdir(path.join(source, 'logs'), { recursive: true });
  await fs.writeFile(path.join(source, 'logs', 'kernel.log'), 'ERROR timeout\n');
  await fs.writeFile(path.join(source, 'logs', 'image.bin'), Buffer.from([0, 1, 2]));
  await tar.create({ cwd: source, file: archive }, ['logs']);
  const extracted = await extractArchive(archive, { maxArchiveFiles: 10, maxArchiveExpandedBytes: 1024, maxSingleExpandedFileBytes: 1024 });
  try {
    assert.equal(extracted.entries.length, 1);
    assert.equal(await fs.readFile(extracted.entries[0].path, 'utf8'), 'ERROR timeout\n');
  } finally {
    await extracted.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runs AI jobs in FIFO order with one active worker', async () => {
  const queue = new AnalysisQueue({ maxConcurrent: 1, retentionMs: 60_000 });
  const order = [];
  let active = 0;
  let maximumActive = 0;
  const run = (name) => new Promise((resolve) => setTimeout(() => {
    order.push(name);
    active--;
    resolve({ result: name });
  }, 10));
  const jobs = ['first', 'second', 'third'].map((name) => queue.enqueue({ owner: 'tester', source: name, run: async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    return run(name);
  }}));
  await waitFor(() => order.length === 3, `AI queue did not complete all jobs: ${order.length}/3`);
  assert.deepEqual(order, ['first', 'second', 'third']);
  assert.equal(maximumActive, 1);
  assert.equal(queue.get(jobs[2].jobId, 'tester').status, 'complete');
  queue.close();
});

test('cancels queued and running AI jobs and rejects a full queue', async () => {
  const queue = new AnalysisQueue({ maxConcurrent: 1, maxQueued: 1, retentionMs: 60_000 });
  let release;
  const running = queue.enqueue({ owner: 'tester', source: 'running', run: ({ signal }) => new Promise((resolve, reject) => {
    release = () => resolve({ result: 'finished' });
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' })), { once: true });
  }) });
  const queued = queue.enqueue({ owner: 'tester', source: 'queued', run: async () => ({ result: 'never' }) });
  assert.throws(() => queue.enqueue({ owner: 'tester', source: 'full', run: async () => ({}) }), /queue is full/);
  assert.equal(queue.cancel(queued.jobId, 'other-user'), null);
  assert.equal(queue.cancel(queued.jobId, 'tester').status, 'cancelled');
  assert.equal(queue.get(queued.jobId, 'tester').status, 'cancelled');
  assert.equal(queue.cancel(running.jobId, 'tester').status, 'cancelling');
  await waitFor(() => queue.get(running.jobId, 'tester').status === 'cancelled', 'running AI job did not settle as cancelled');
  assert.equal(queue.get(running.jobId, 'tester').status, 'cancelled');
  release?.();
  queue.close();
});
