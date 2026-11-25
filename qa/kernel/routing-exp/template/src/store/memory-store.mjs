// In-memory stand-in for the database. Every call is asynchronous, like the real thing: a call resolves on a
// later turn of the event loop, so other work can run between two calls. Values are copied in and out.
const turn = () => new Promise((resolve) => setImmediate(resolve));

export class MemoryStore {
  #data = new Map();

  constructor() {
    this.stats = { reads: 0, writes: 0, lists: 0 };
  }

  async get(key) {
    await turn();
    this.stats.reads += 1;
    return this.#data.has(key) ? structuredClone(this.#data.get(key)) : null;
  }

  async set(key, value) {
    await turn();
    this.stats.writes += 1;
    this.#data.set(key, structuredClone(value));
  }

  async delete(key) {
    await turn();
    this.stats.writes += 1;
    return this.#data.delete(key);
  }

  /** Every entry whose key starts with the prefix, ordered by key: [{ key, value }]. */
  async list(prefix = '') {
    await turn();
    this.stats.lists += 1;
    return [...this.#data.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => ({ key, value: structuredClone(value) }));
  }
}
