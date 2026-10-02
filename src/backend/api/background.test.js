const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createBackgroundRouter } = require('./background');

async function serve(t, options = {}) {
  const events = [];
  const logger = {
    logAPI: (...args) => events.push({ operation: args[0], resource: args[1], success: args[2], details: args[4] })
  };
  const auth = (req, res, next) => { req.user = { id: 'fixture-user', username: 'ken', role: 'user' }; next(); };
  const router = createBackgroundRouter({ logger, auth, ...options });
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api', router);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const request = (url, init) => fetch(`http://127.0.0.1:${server.address().port}/api${url}`, init);
  return { request, events };
}

const image = Buffer.from('fixture-private-image-payload').toString('base64');
const validBackground = {
  data: image,
  mimeType: 'image/png',
  name: 'team-background.png',
  width: 1920,
  height: 1080,
  scale: 1,
  position: { x: 50, y: 50 },
  fit: 'cover'
};

test('background save/remove logs contain metadata only and never image bytes', async t => {
  let stored;
  const db = {
    async get() { return stored; },
    async run(sql, params) {
      if (sql.includes('INSERT OR REPLACE')) {
        const [, imageBytes, mimeType, name, width, height, size, scale, positionX, positionY, fit, updatedAt] = params;
        stored = { image: imageBytes, mimeType, name, width, height, size, scale, positionX, positionY, fit, updatedAt };
      } else if (sql.includes('DELETE FROM')) {
        const had = Boolean(stored);
        stored = null;
        return { changes: had ? 1 : 0 };
      }
      return { changes: 1 };
    }
  };
  const f = await serve(t, { db });

  const saved = await f.request('/user/background', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(validBackground)
  });
  assert.equal(saved.status, 200);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].operation, 'background_save');
  assert.equal(f.events[0].success, true);
  assert.equal(f.events[0].details.size, Buffer.from(image, 'base64').length);
  assert.equal(f.events[0].details.name, 'team-background.png');
  assert.doesNotMatch(JSON.stringify(f.events), /fixture-private-image-payload|data:image|cHJpdmF0ZQ/);

  const loaded = await f.request('/user/background');
  assert.equal(loaded.status, 200);
  assert.equal((await loaded.json()).background.name, 'team-background.png');
  assert.equal(f.events.length, 1, 'successful image reads do not create noisy audit entries');

  const removed = await f.request('/user/background', { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(f.events[1].operation, 'background_remove');
  assert.equal(f.events[1].details.deleted, true);
  assert.doesNotMatch(JSON.stringify(f.events), /fixture-private-image-payload|cHJpdmF0ZQ/);
});

test('background validation and storage failures are logged without payload data', async t => {
  const db = {
    async get() { throw Object.assign(new Error('database unavailable'), { code: 'SQLITE_IOERR' }); },
    async run() { throw Object.assign(new Error('database unavailable'), { code: 'SQLITE_IOERR' }); }
  };
  const f = await serve(t, { db });

  const invalid = await f.request('/user/background', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...validBackground, fit: 'invalid' })
  });
  assert.equal(invalid.status, 400);
  assert.equal(f.events[0].operation, 'background_save');
  assert.equal(f.events[0].success, false);
  assert.equal(f.events[0].details.error, 'Background image fit is invalid.');

  const loadFailure = await f.request('/user/background');
  assert.equal(loadFailure.status, 500);
  assert.equal(f.events[1].operation, 'background_load');
  assert.equal(f.events[1].details.errorCode, 'SQLITE_IOERR');

  const saveFailure = await f.request('/user/background', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(validBackground)
  });
  assert.equal(saveFailure.status, 500);
  assert.equal(f.events[2].operation, 'background_save');
  assert.equal(f.events[2].details.error, 'Unable to save background image');
  assert.doesNotMatch(JSON.stringify(f.events), /fixture-private-image-payload|cHJpdmF0ZQ/);
});
