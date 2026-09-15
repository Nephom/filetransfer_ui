const assert = require('node:assert/strict');
const test = require('node:test');
const { PerformanceMetrics } = require('./performance-metrics');

const request = path => ({ method: 'GET', path });

const response = statusCode => ({ statusCode, once(event, callback) { if (event === 'finish') callback(); } });

test('PerformanceMetrics records API samples and exposes latency percentiles', () => {
  const metrics = new PerformanceMetrics({ windowMs: 60_000, maxSamples: 10 });
  const startedAt = metrics.start();
  metrics.record(request('/api/files'), response(200), startedAt);
  const snapshot = metrics.getSnapshot();
  assert.equal(snapshot.totalRequests, 1);
  assert.equal(snapshot.windowRequests, 1);
  assert.equal(snapshot.errorCount, 0);
  assert.equal(snapshot.statusCountsLifetime['200'], 1);
  assert.equal(snapshot.recentSamples[0].route, '/api/files');
  assert.equal(typeof snapshot.latencyMs.average, 'number');
});

test('PerformanceMetrics excludes its own metrics endpoint and retains bounded samples', () => {
  const metrics = new PerformanceMetrics({ windowMs: 60_000, maxSamples: 3 });
  for (let index = 0; index < 8; index++) metrics.record(request('/api/files'), response(500), metrics.start());
  metrics.record(request('/api/admin/metrics'), response(200), metrics.start());
  const snapshot = metrics.getSnapshot();
  assert.equal(snapshot.totalRequests, 8);
  assert.equal(snapshot.windowRequests, 3);
  assert.equal(snapshot.errorCount, 3);
  assert.equal(snapshot.statusCountsLifetime['500'], 8);
  assert.equal(snapshot.statusCountsLifetime['200'], undefined);
});

test('PerformanceMetrics ignores non-API requests', () => {
  const metrics = new PerformanceMetrics();
  metrics.record(request('/dashboard'), response(200), metrics.start());
  assert.equal(metrics.getSnapshot().totalRequests, 0);
});
