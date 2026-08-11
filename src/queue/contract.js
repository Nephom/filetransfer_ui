const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE = new Set(['queued', 'running', 'retrying', 'needs_user_action']);

const transitions = {
  queued: ['running', 'cancelled', 'needs_user_action'],
  running: ['completed', 'failed', 'cancelled', 'retrying', 'needs_user_action'],
  retrying: ['queued', 'failed', 'cancelled', 'needs_user_action'],
  completed: [],
  failed: ['queued', 'cancelled'],
  cancelled: [],
  needs_user_action: ['queued', 'cancelled'],
};

const canTransition = (from, to) => from === to || transitions[from]?.includes(to) === true;

const assertTransition = (from, to) => {
  if (!canTransition(from, to)) throw new Error(`Invalid Queue transition: ${from} -> ${to}`);
};

const isTerminal = (status) => TERMINAL.has(status);

const classifyFailure = (error) => {
  const message = String(error?.message || error || 'Unknown transfer error');
  const lower = message.toLowerCase();
  const status = Number(error?.status || error?.statusCode || message.match(/\b(401|403|404|409|5\d\d)\b/)?.[1] || 0);
  if (status === 401 || /unauthori[sz]ed|token expired|authentication/.test(lower)) return { category: 'authentication', retryable: false, needsUserAction: true };
  if (status === 403 || /forbidden|permission denied/.test(lower)) return { category: 'permission', retryable: false, needsUserAction: true };
  if (status === 404 || /not found|os error [23]/.test(lower)) return { category: 'source_missing', retryable: false, needsUserAction: true };
  if (status === 409 || lower.includes('conflict')) return { category: 'conflict', retryable: false, needsUserAction: true };
  if (/source changed|modified after|changed since/.test(lower)) return { category: 'source_changed', retryable: false, needsUserAction: true };
  if (/destination.*(unavailable|missing)|no space left/.test(lower)) return { category: 'destination_unavailable', retryable: false, needsUserAction: true };
  if (status >= 500 || /server error/.test(lower)) return { category: 'server_error', retryable: true, needsUserAction: false };
  if (/timeout|timed out/.test(lower)) return { category: 'timeout', retryable: true, needsUserAction: false };
  if (/network|fetch|econn|connection/.test(lower)) return { category: 'network', retryable: true, needsUserAction: false };
  if (/invalid|validation/.test(lower)) return { category: 'validation', retryable: false, needsUserAction: true };
  if (lower.includes('cancel')) return { category: 'cancelled', retryable: false, needsUserAction: false };
  return { category: 'unknown', retryable: false, needsUserAction: true };
};

const retryDelay = (attempt, baseMs = 1000, maxMs = 30_000) => Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));

const pruneHistory = (items, now = Date.now(), policies = {
  completed: { max: 20, ttlMs: 24 * 60 * 60 * 1000 },
  cancelled: { max: 10, ttlMs: 24 * 60 * 60 * 1000 },
  failed: { max: 20, ttlMs: 7 * 24 * 60 * 60 * 1000 },
}) => {
  const grouped = new Map();
  const active = [];
  for (const item of items) {
    if (!policies[item.status]) active.push(item);
    else grouped.set(item.status, [...(grouped.get(item.status) || []), item]);
  }
  for (const [status, values] of grouped) {
    const policy = policies[status];
    active.push(...values.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
      .filter((item, index) => index < policy.max && (!item.finishedAt || now - item.finishedAt < policy.ttlMs)));
  }
  return active;
};

class QueueScheduler {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.items = new Map();
    this.jobs = new Map();
    this.controllers = new Map();
    this.active = false;
  }

  enqueue(item, executor) {
    if (this.items.has(item.id)) return false;
    this.items.set(item.id, item);
    this.jobs.set(item.id, executor);
    this.onChange(item);
    void this.pump();
    return true;
  }

  cancel(id) {
    const item = this.items.get(id);
    if (!item || isTerminal(item.status)) return false;
    this.controllers.get(id)?.abort();
    assertTransition(item.status, 'cancelled');
    const next = { ...item, status: 'cancelled' };
    this.items.set(id, next);
    this.onChange(next);
    return true;
  }

  retry(id) {
    const item = this.items.get(id);
    if (!item || !['failed', 'needs_user_action'].includes(item.status)) return false;
    assertTransition(item.status, 'queued');
    const next = { ...item, status: 'queued' };
    this.items.set(id, next);
    this.onChange(next);
    void this.pump();
    return true;
  }

  get(id) { return this.items.get(id) || null; }

  async pump() {
    if (this.active) return;
    const item = [...this.items.values()].find((candidate) => candidate.status === 'queued');
    if (!item) return;
    const executor = this.jobs.get(item.id);
    if (!executor) return;
    this.active = true;
    const controller = new AbortController();
    this.controllers.set(item.id, controller);
    assertTransition(item.status, 'running');
    const running = { ...item, status: 'running' };
    this.items.set(item.id, running);
    this.onChange(running);
    try {
      await executor(running, controller.signal);
      const current = this.items.get(item.id);
      if (current.status !== 'cancelled') {
        assertTransition(current.status, 'completed');
        const completed = { ...current, status: 'completed' };
        this.items.set(item.id, completed);
        this.onChange(completed);
      }
    } catch (error) {
      const current = this.items.get(item.id);
      if (current.status !== 'cancelled') {
        const failed = { ...current, status: classifyFailure(error).needsUserAction ? 'needs_user_action' : 'failed' };
        this.items.set(item.id, failed);
        this.onChange(failed);
      }
    } finally {
      this.controllers.delete(item.id);
      this.active = false;
      void this.pump();
    }
  }
}

module.exports = { ACTIVE, TERMINAL, QueueScheduler, assertTransition, canTransition, classifyFailure, isTerminal, pruneHistory, retryDelay };
