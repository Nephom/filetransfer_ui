import { assertQueueTransition, isQueueTerminal, type QueueStatus } from "./state";

export type QueueExecutor<T> = (item: T, signal: AbortSignal) => Promise<void>;

/** Platform-neutral single-flight scheduler. React only observes its callbacks. */
export class QueueScheduler<T extends { id: string; status: QueueStatus } = { id: string; status: QueueStatus }> {
  private readonly jobs = new Map<string, QueueExecutor<T>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Set<string>();
  private readonly items = new Map<string, T>();

  constructor(private readonly onChange: (item: T) => void = () => {}) {}

  async runExclusive(id: string, executor: () => Promise<void>) {
    if (this.running.has(id)) return false;
    this.running.add(id);
    try {
      await executor();
      return true;
    } finally {
      this.running.delete(id);
    }
  }

  enqueue(item: T, executor: QueueExecutor<T>) {
    this.items.set(item.id, item);
    this.jobs.set(item.id, executor);
    this.onChange(item);
    void this.start(item.id);
  }

  cancel(id: string) {
    const item = this.items.get(id);
    if (!item || isQueueTerminal(item.status)) return false;
    this.controllers.get(id)?.abort();
    assertQueueTransition(item.status, "cancelled");
    const next = { ...item, status: "cancelled" as const } as T;
    this.items.set(id, next);
    this.onChange(next);
    return true;
  }

  retry(item: T) {
    if (item.status !== "failed" && item.status !== "needs_user_action") return false;
    assertQueueTransition(item.status, "queued");
    const next = { ...item, status: "queued" as const } as T;
    this.items.set(item.id, next);
    this.onChange(next);
    void this.start(item.id);
    return true;
  }

  remove(id: string) {
    const item = this.items.get(id);
    if (!item || !isQueueTerminal(item.status)) return false;
    this.items.delete(id);
    this.jobs.delete(id);
    return true;
  }

  private async start(id: string) {
    if (this.running.has(id)) return;
    const item = this.items.get(id);
    const executor = this.jobs.get(id);
    if (!item || !executor || item.status !== "queued") return;
    this.running.add(id);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    assertQueueTransition(item.status, "running");
    const running = { ...item, status: "running" as const } as T;
    this.items.set(id, running);
    this.onChange(running);
    try {
      await executor(running, controller.signal);
      const current = this.items.get(id);
      if (current?.status !== "cancelled") {
        assertQueueTransition(current?.status || "running", "completed");
        const completed = { ...current!, status: "completed" as const } as T;
        this.items.set(id, completed);
        this.onChange(completed);
      }
    } catch (error) {
      const current = this.items.get(id);
      if (current?.status === "cancelled") return;
      const failed = { ...current!, status: "failed" as const } as T;
      this.items.set(id, failed);
      this.onChange(failed);
    } finally {
      this.controllers.delete(id);
      this.running.delete(id);
    }
  }
}
