const crypto = require('node:crypto');

class AnalysisQueue {
  constructor({ maxConcurrent = 1, maxQueued = 20, retentionMs = 10 * 60 * 1000, clock = Date } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
    this.retentionMs = retentionMs;
    this.clock = clock;
    this.jobs = new Map();
    this.pending = [];
    this.running = 0;
    this.closed = false;
    this.cleanupTimer = setInterval(() => this.cleanup(), Math.min(retentionMs, 60 * 1000));
    this.cleanupTimer.unref?.();
  }

  enqueue({ owner, source, run }) {
    if (this.closed) throw Object.assign(new Error('AI analysis queue is shutting down'), { statusCode: 503, code: 'AI_QUEUE_CLOSED' });
    if (this.pending.length >= this.maxQueued) throw Object.assign(new Error('AI analysis queue is full'), { statusCode: 429, code: 'AI_QUEUE_FULL' });

    const now = this.clock.now();
    const job = {
      id: crypto.randomUUID(), owner, source, run, status: 'queued', progress: null,
      result: null, error: null, createdAt: now, startedAt: null, completedAt: null,
      controller: new AbortController()
    };
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.pump();
    return this.snapshot(job);
  }

  get(id, owner) {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) return null;
    return this.snapshot(job);
  }

  cancel(id, owner) {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) return null;
    if (job.status === 'queued') {
      this.pending = this.pending.filter((pendingId) => pendingId !== id);
      job.status = 'cancelled';
      job.completedAt = this.clock.now();
      this.pump();
    } else if (job.status === 'running') {
      job.status = 'cancelling';
      job.controller.abort();
    }
    return this.snapshot(job);
  }

  snapshot(job) {
    const position = job.status === 'queued' ? this.pending.indexOf(job.id) + 1 : 0;
    return {
      jobId: job.id,
      status: job.status,
      position,
      queueLength: this.pending.length,
      source: job.source,
      progress: job.progress,
      result: job.status === 'complete' ? job.result : null,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt
    };
  }

  pump() {
    while (!this.closed && this.running < this.maxConcurrent && this.pending.length) {
      const id = this.pending.shift();
      const job = this.jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      this.running++;
      job.status = 'running';
      job.startedAt = this.clock.now();
      Promise.resolve().then(() => {
        if (job.controller.signal.aborted) throw Object.assign(new Error('AI analysis cancelled'), { code: 'ABORT_ERR' });
        return job.run({
          signal: job.controller.signal,
          onProgress: (progress) => { if (job.status === 'running') job.progress = progress; }
        });
      }).then((result) => {
        if (job.status === 'cancelling' || job.controller.signal.aborted) {
          job.status = 'cancelled';
        } else {
          job.status = 'complete';
          job.result = result;
        }
      }).catch((error) => {
        if (job.status === 'cancelling' || job.controller.signal.aborted || error?.code === 'ABORT_ERR') {
          job.status = 'cancelled';
        } else {
          job.status = 'failed';
          job.error = { message: error?.message || 'AI analysis failed', code: error?.code || 'AI_ERROR' };
        }
      }).finally(() => {
        job.completedAt = this.clock.now();
        this.running--;
        this.pump();
      });
    }
  }

  cleanup() {
    const cutoff = this.clock.now() - this.retentionMs;
    for (const [id, job] of this.jobs) {
      if (job.completedAt && job.completedAt <= cutoff) this.jobs.delete(id);
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.cleanupTimer);
    for (const id of this.pending) {
      const job = this.jobs.get(id);
      if (job?.status === 'queued') {
        job.status = 'cancelled';
        job.completedAt = this.clock.now();
      }
    }
    this.pending = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'running' || job.status === 'cancelling') {
        job.status = 'cancelling';
        job.controller.abort();
      }
    }
  }
}

module.exports = { AnalysisQueue };
