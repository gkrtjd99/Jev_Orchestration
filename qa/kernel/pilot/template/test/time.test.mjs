import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daysBetween } from '../src/util/time.mjs';

test('daysBetween', () => {
  assert.equal(daysBetween('2026-11-01T00:00:00.000Z', '2026-11-03T00:00:00.000Z'), 2);
});
