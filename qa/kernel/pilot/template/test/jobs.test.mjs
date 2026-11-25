import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobs } from '../src/jobs/index.mjs';
import { runDue } from '../src/jobs/runner.mjs';
import { createStore, loadSeed } from '../src/store/store.mjs';

const store = () => createStore(loadSeed(new URL('../data', import.meta.url).pathname));

test('expired pickup codes are cleared', async () => {
  const s = store();
  const ran = await runDue(jobs, { store: s, now: new Date('2026-11-03T00:00:00.000Z') });
  assert.equal(ran.find((entry) => entry.name === 'expire-pickup-codes').result, 1);
  assert.equal(s.get('parcels', 'P-1002').pickupCode, null);
});

test('a job that ran recently is not due', async () => {
  const lastRun = new Map();
  const now = new Date('2026-11-03T00:00:00.000Z');
  await runDue(jobs, { store: store(), now, lastRun });
  assert.equal((await runDue(jobs, { store: store(), now, lastRun })).length, 0);
});
