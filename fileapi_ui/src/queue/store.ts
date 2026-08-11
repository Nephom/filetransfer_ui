import { assertQueueTransition, isQueueTerminal, type QueueStatus } from "./state";

export type QueueItemLike = { id: string; status: QueueStatus; finishedAt?: number };

/** Pure Queue state store used by Desktop UI and scheduler adapters. */
export class QueueStore<T extends QueueItemLike> {
  private items = new Map<string, T>();

  constructor(private readonly prune: (items: T[]) => T[] = (items) => items) {}

  snapshot() {
    return this.prune([...this.items.values()]);
  }

  replace(items: T[]) {
    this.items.clear();
    items.forEach((item) => this.items.set(item.id, item));
  }

  enqueue(item: T) {
    if (this.items.has(item.id)) return false;
    this.items.set(item.id, item);
    return true;
  }

  update(id: string, patch: Partial<T>) {
    const current = this.items.get(id);
    if (!current) return false;
    if (patch.status && patch.status !== current.status) assertQueueTransition(current.status, patch.status);
    if (current.status === "cancelled" && patch.status && patch.status !== "cancelled") return false;
    this.items.set(id, { ...current, ...patch });
    return true;
  }

  cancel(id: string) {
    const current = this.items.get(id);
    if (!current || isQueueTerminal(current.status)) return false;
    assertQueueTransition(current.status, "cancelled");
    this.items.set(id, { ...current, status: "cancelled" } as T);
    return true;
  }

  remove(id: string) {
    const current = this.items.get(id);
    if (!current || !isQueueTerminal(current.status)) return false;
    return this.items.delete(id);
  }
}
