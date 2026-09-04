const test = require('node:test');
const assert = require('node:assert/strict');
const { pruneHistory, retryDelay } = require('./contract');

test('pruneHistory removes terminal items older than their state TTL', () => {
  const now = 10_000;
  const items = [
    { id: 'recent', status: 'completed', finishedAt: 9_000 },
    { id: 'expired', status: 'completed', finishedAt: 1_000 },
    { id: 'active', status: 'running' },
  ];

  assert.deepEqual(pruneHistory(items, now, {
    completed: { max: 20, ttlMs: 2_000 },
  }).map((item) => item.id), ['active', 'recent']);
});

test('pruneHistory applies the count limit after removing expired items', () => {
  const now = 10_000;
  const items = [
    { id: 'newest', status: 'failed', finishedAt: 9_900 },
    { id: 'expired', status: 'failed', finishedAt: 1_000 },
    { id: 'older', status: 'failed', finishedAt: 9_000 },
  ];

  assert.deepEqual(pruneHistory(items, now, {
    failed: { max: 1, ttlMs: 2_000 },
  }).map((item) => item.id), ['newest']);
});

test('retryDelay uses bounded exponential backoff for valid attempt values', () => {
  assert.equal(retryDelay(0), 1_000);
  assert.equal(retryDelay(1), 1_000);
  assert.equal(retryDelay(2), 2_000);
  assert.equal(retryDelay(10), 30_000);
});
