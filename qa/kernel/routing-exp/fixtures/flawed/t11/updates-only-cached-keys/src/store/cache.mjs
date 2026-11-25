// A read cache in front of a store. Lookups (including "not there") and listings are remembered for ttlMs.
export class CachedStore {
  #values = new Map();
  #lists = new Map();

  constructor(store, { ttlMs = 30000, now = Date.now } = {}) {
    this.store = store;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  async get(key) {
    const hit = this.#values.get(key);
    if (hit && hit.expires > this.now()) return structuredClone(hit.value);
    const value = await this.store.get(key);
    this.#values.set(key, { value, expires: this.now() + this.ttlMs });
    return structuredClone(value);
  }

  async list(prefix = '') {
    const hit = this.#lists.get(prefix);
    if (hit && hit.expires > this.now()) return structuredClone(hit.rows);
    const rows = await this.store.list(prefix);
    this.#lists.set(prefix, { rows, expires: this.now() + this.ttlMs });
    return structuredClone(rows);
  }

  async set(key, value) {
    await this.store.set(key, value);
    // Keep the cache warm: refresh the entry when we already hold a value for it.
    const hit = this.#values.get(key);
    if (hit && hit.value !== null) this.#values.set(key, { value: structuredClone(value), expires: this.now() + this.ttlMs });
    for (const prefix of [...this.#lists.keys()]) if (key.startsWith(prefix)) this.#lists.delete(prefix);
  }

  async delete(key) {
    const removed = await this.store.delete(key);
    this.#values.delete(key);
    for (const prefix of [...this.#lists.keys()]) if (key.startsWith(prefix)) this.#lists.delete(prefix);
    return removed;
  }

  /** Forgets everything. */
  clear() {
    this.#values.clear();
    this.#lists.clear();
  }
}
