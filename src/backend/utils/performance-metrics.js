const { performance } = require('node:perf_hooks');

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SAMPLES = 1000;

const percentile = (values, rank) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
};

class PerformanceMetrics {
  constructor({ windowMs = DEFAULT_WINDOW_MS, maxSamples = DEFAULT_MAX_SAMPLES } = {}) {
    this.windowMs = windowMs;
    this.maxSamples = maxSamples;
    this.samples = [];
    this.startedAt = Date.now();
    this.totalRequests = 0;
    this.statusCounts = Object.create(null);
  }

  start() {
    return performance.now();
  }

  record(req, res, startedAt) {
    if (!req.path.startsWith('/api/') || req.path === '/api/admin/metrics') return;
    const durationMs = Math.max(0, performance.now() - startedAt);
    const status = String(res.statusCode || 0);
    const sample = {
      timestamp: Date.now(),
      method: req.method,
      route: req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : req.path,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(2))
    };
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);
    this.totalRequests++;
    this.statusCounts[status] = (this.statusCounts[status] || 0) + 1;
    if (this.samples.length > this.maxSamples * 1.2) this.prune(sample.timestamp);
  }

  prune(now = Date.now()) {
    const threshold = now - this.windowMs;
    const firstValid = this.samples.findIndex(sample => sample.timestamp >= threshold);
    if (firstValid > 0) this.samples.splice(0, firstValid);
    else if (firstValid === -1 && this.samples.length) this.samples.length = 0;
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);
  }

  getSnapshot({ cache = [] } = {}) {
    const now = Date.now();
    this.prune(now);
    const durations = this.samples.map(sample => sample.durationMs);
    const errors = this.samples.filter(sample => sample.status >= 400).length;
    return {
      sampledAt: new Date(now).toISOString(),
      windowMs: this.windowMs,
      uptimeSeconds: Math.floor((now - this.startedAt) / 1000),
      totalRequests: this.totalRequests,
      windowRequests: this.samples.length,
      errorCount: errors,
      errorRate: this.samples.length ? Number((errors / this.samples.length).toFixed(4)) : 0,
      statusCountsLifetime: { ...this.statusCounts },
      latencyMs: {
        average: durations.length ? Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(2)) : null,
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        p99: percentile(durations, 0.99)
      },
      recentSamples: this.samples.slice(-100),
      cache
    };
  }
}

module.exports = { PerformanceMetrics };
