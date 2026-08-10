/**
 * Bulk User Management job runner.
 *
 * Bulk edits (system role, Permission Role, active/inactive, Location
 * permissions) run as an in-memory background job instead of one blocking
 * HTTP request, so applying changes to 100+ accounts can't time out the
 * request and the UI can show live "N/total" progress. The frontend
 * submits a job, then polls GET /api/admin/users/bulk/:jobId until
 * `status` is 'completed'.
 *
 * Every target is re-validated against the *current* actor permissions and
 * the target's *current* role on the server - the frontend's selection is
 * never trusted as-is. Partial success is always reported explicitly
 * (succeeded/failed/skipped counts plus a per-user reason), never
 * collapsed into a single success/failure flag.
 */
const crypto = require('crypto');
const { systemLogger } = require('../utils/logger');

// Jobs are kept in memory only (mirrors src/backend/transfer/progress.js).
// A server restart mid-job loses progress; the UI surfaces this as "job not
// found" rather than silently reporting a stale/incorrect result.
const JOB_TTL_MS = 30 * 60 * 1000; // prune finished jobs after 30 minutes

class BulkUserJobManager {
  constructor() {
    this.jobs = new Map();
  }

  createJob({ actorUsername, actorRole, usernames }) {
    const id = crypto.randomUUID();
    const job = {
      id,
      actorUsername,
      actorRole,
      status: 'running', // running | completed
      total: usernames.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      currentUser: null,
      results: [],
      startedAt: Date.now(),
      finishedAt: null
    };
    this.jobs.set(id, job);
    return job;
  }

  getJob(id) {
    return this.jobs.get(id) || null;
  }

  recordResult(job, username, outcome, reason) {
    job.results.push({ username, outcome, reason: reason || null });
    job.completed += 1;
    if (outcome === 'succeeded') job.succeeded += 1;
    else if (outcome === 'skipped') job.skipped += 1;
    else job.failed += 1;
  }

  finishJob(job) {
    job.status = 'completed';
    job.currentUser = null;
    job.finishedAt = Date.now();
    setTimeout(() => this.jobs.delete(job.id), JOB_TTL_MS);
  }

  toPublicJson(job) {
    if (!job) return null;
    return {
      id: job.id,
      status: job.status,
      total: job.total,
      completed: job.completed,
      succeeded: job.succeeded,
      failed: job.failed,
      skipped: job.skipped,
      currentUser: job.currentUser,
      results: job.results,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt
    };
  }

  /**
   * Run a bulk edit job in the background. `applyOne(username)` must
   * resolve to { outcome: 'succeeded'|'failed'|'skipped', reason }.
   */
  async run(job, usernames, applyOne) {
    for (const username of usernames) {
      job.currentUser = username;
      try {
        const { outcome, reason } = await applyOne(username);
        this.recordResult(job, username, outcome, reason);
      } catch (error) {
        this.recordResult(job, username, 'failed', error.message);
      }
    }
    this.finishJob(job);
    systemLogger.logSystem(
      'INFO',
      `Bulk user update by ${job.actorRole} '${job.actorUsername}' finished: ` +
      `${job.succeeded} succeeded, ${job.failed} failed, ${job.skipped} skipped (of ${job.total}).`
    );
  }
}

module.exports = new BulkUserJobManager();
