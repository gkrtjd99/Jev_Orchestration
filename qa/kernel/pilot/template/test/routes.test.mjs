import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatch } from '../src/http/dispatch.mjs';
import { createStore, loadSeed } from '../src/store/store.mjs';

const store = () => createStore(loadSeed(new URL('../data', import.meta.url).pathname));

test('health', async () => {
  assert.deepEqual(await dispatch({ method: 'GET', path: '/health', store: store() }), { status: 200, body: { ok: true } });
});

test('parcel lookup hides the pickup code', async () => {
  const response = await dispatch({ method: 'GET', path: '/parcels/P-1001', store: store() });
  assert.equal(response.status, 200);
  assert.equal('pickupCode' in response.body, false);
});

test('collect frees the compartment', async () => {
  const s = store();
  const response = await dispatch({ method: 'POST', path: '/parcels/P-1001/collect', store: s });
  assert.equal(response.body.status, 'collected');
  assert.equal(s.get('lockers', 'L-A1').compartments[0].parcelId, null);
});

test('unknown parcel', async () => {
  assert.equal((await dispatch({ method: 'GET', path: '/parcels/nope', store: store() })).status, 404);
});
