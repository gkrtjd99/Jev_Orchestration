import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory-store.mjs';
import { CachedStore } from '../src/store/cache.mjs';

test('lookups are served from the cache until they expire', async () => {
  const store = new MemoryStore();
  await store.set('member:1', { name: 'Bo' });
  let clock = 1000;
  const cache = new CachedStore(store, { ttlMs: 500, now: () => clock });
  assert.deepEqual(await cache.get('member:1'), { name: 'Bo' });
  assert.deepEqual(await cache.get('member:1'), { name: 'Bo' });
  assert.equal(store.stats.reads, 1);
  clock += 600;
  await cache.get('member:1');
  assert.equal(store.stats.reads, 2);
});

test('missing keys and listings are remembered too', async () => {
  const store = new MemoryStore();
  await store.set('member:1', { name: 'Bo' });
  const cache = new CachedStore(store);
  assert.equal(await cache.get('member:9'), null);
  assert.equal(await cache.get('member:9'), null);
  assert.equal(store.stats.reads, 1);
  assert.equal((await cache.list('member:')).length, 1);
  assert.equal((await cache.list('member:')).length, 1);
  assert.equal(store.stats.lists, 1);
  cache.clear();
  await cache.list('member:');
  assert.equal(store.stats.lists, 2);
});
