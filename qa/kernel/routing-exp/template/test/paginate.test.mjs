import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/api/paginate.mjs';

const items = Array.from({ length: 5 }, (_, i) => ({ id: `s-${i + 1}` }));

test('paginate slices by page number', () => {
  assert.deepEqual(paginate(items, { page: 2, pageSize: 2 }), { items: [{ id: 's-3' }, { id: 's-4' }], page: 2, pageSize: 2, total: 5, totalPages: 3 });
  assert.deepEqual(paginate(items, { page: 4, pageSize: 2 }).items, []);
});

test('paginate validates its arguments', () => {
  assert.throws(() => paginate(items, { page: 0 }), { code: 'INVALID_PAGE' });
  assert.throws(() => paginate(items, { pageSize: 101 }), { code: 'INVALID_PAGE_SIZE' });
});
