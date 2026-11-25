import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// In-memory record store. Collections are created on first use; records are copied on the way in and out
// so callers cannot change stored state by accident.
export function createStore(seed = {}) {
  const data = new Map();
  const collection = (name) => {
    if (!data.has(name)) data.set(name, new Map());
    return data.get(name);
  };
  for (const [name, records] of Object.entries(seed)) {
    for (const record of records) collection(name).set(record.id, structuredClone(record));
  }
  return {
    list(name) {
      return [...collection(name).values()].map((record) => structuredClone(record));
    },
    get(name, id) {
      const record = collection(name).get(id);
      return record ? structuredClone(record) : null;
    },
    put(name, record) {
      if (!record || typeof record.id !== 'string') throw new TypeError('record needs a string id');
      collection(name).set(record.id, structuredClone(record));
      return record;
    },
    remove(name, id) {
      return collection(name).delete(id);
    },
  };
}

export function loadSeed(dir) {
  const read = (file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
  return { lockers: read('lockers.json'), parcels: read('parcels.json') };
}
