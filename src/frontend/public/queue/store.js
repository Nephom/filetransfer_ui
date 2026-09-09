export default class WebQueueStore {
        constructor() {
            this.items = new Map();
        }

        replace(items) {
            this.items.clear();
            items.forEach((item) => this.items.set(item.id, item));
        }

        snapshot() {
            return [...this.items.values()];
        }

        update(id, patch) {
            const item = this.items.get(id);
            if (!item) return false;
            this.items.set(id, { ...item, ...patch });
            return true;
        }
}
