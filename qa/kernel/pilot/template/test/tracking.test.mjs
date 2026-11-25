import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTracking, sameTracking } from '../src/util/tracking.mjs';

test('normalizeTracking trims', () => {
  assert.equal(normalizeTracking('  PD1234AB '), 'PD1234AB');
  assert.equal(sameTracking('PD1234AB', ' PD1234AB'), true);
});
