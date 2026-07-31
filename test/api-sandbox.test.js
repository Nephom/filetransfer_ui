const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

let sandbox;
let baseUrl;
let child;
let token;

const nextPort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(error => error ? reject(error) : resolve(port));
  });
  server.on('error', reject);
});

const waitFor = async (predicate, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for sandbox server');
};

const api = (endpoint, init = {}) => fetch(`${baseUrl}${endpoint}`, {
  ...init,
  headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) }
});

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'filetransfer-api-'));
  const storage = path.join(sandbox, 'storage');
  await mkdir(path.join(storage, 'folder'), { recursive: true });
  await writeFile(path.join(storage, 'folder', 'inside.txt'), 'folder content');
  await writeFile(path.join(storage, 'existing.txt'), 'existing content');
  const port = await nextPort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['src/backend/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      SERVER_PORT: String(port),
      AUTH_USERNAME: 'admin',
      AUTH_PASSWORD: 'sandbox-password',
      JWT_SECRET: 'sandbox-jwt-secret-for-isolated-api-tests',
      FILESYSTEM_STORAGE_PATH: storage,
      USERS_FILE_PATH: path.join(sandbox, 'users.json'),
      DATABASE_PATH: path.join(sandbox, 'app.db'),
      LOGS_DIR: path.join(sandbox, 'logs'),
      SERVER_LOG_FILE: path.join(sandbox, 'server.log')
    },
    stdio: 'ignore'
  });
  await waitFor(async () => (await fetch(`${baseUrl}/`)).ok);
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'sandbox-password' })
  });
  assert.equal(response.status, 200);
  token = (await response.json()).token;
});

after(async () => {
  if (child && !child.killed) child.kill('SIGTERM');
  await rm(sandbox, { recursive: true, force: true });
});

test('sandbox list, upload, archive, and download contracts remain compatible', async () => {
  const list = await api('/api/files');
  assert.equal(list.status, 200);
  assert.ok((await list.json()).files.some(file => file.name === 'existing.txt'));

  const form = new FormData();
  form.append('files', new Blob(['uploaded content'], { type: 'text/plain' }), 'uploaded.txt');
  form.append('filePaths[]', 'uploaded.txt');
  form.append('path', '');
  const upload = await api('/api/upload/multiple', { method: 'POST', body: form });
  assert.ok([200, 202].includes(upload.status));

  await waitFor(async () => {
    const files = await (await api('/api/files')).json();
    return files.files.some(file => file.name === 'uploaded.txt');
  });

  const direct = await api('/api/files/download/existing.txt');
  assert.equal(direct.status, 200);
  assert.equal(await direct.text(), 'existing content');

  const folderAsFile = await api('/api/files/download/folder');
  assert.equal(folderAsFile.status, 400);
  assert.match((await folderAsFile.json()).error, /archive/i);

  const archive = await api('/api/archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ name: 'folder', isDirectory: true }], currentPath: '' })
  });
  assert.equal(archive.status, 200);
  assert.match(archive.headers.get('content-type'), /application\/zip/);
  assert.equal((await archive.arrayBuffer()).byteLength > 0, true);

  const searchResultArchive = await api('/api/archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ name: 'inside.txt', path: 'folder/inside.txt', isDirectory: false }],
      currentPath: 'ignored-for-search-results'
    })
  });
  assert.equal(searchResultArchive.status, 200);
  assert.match(searchResultArchive.headers.get('content-type'), /application\/zip/);
});

test('sandbox writes IPv4 user operations to underscore-named logs', async () => {
  await waitFor(async () => {
    const log = await readFile(path.join(sandbox, 'logs', '127_0_0_1.log'), 'utf8');
    return log.includes('User: admin (admin)');
  });
  const log = await readFile(path.join(sandbox, 'logs', '127_0_0_1.log'), 'utf8');
  assert.match(log, /API LIST/);
});
