import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskPhone } from '../src/util/phone.mjs';
import { normalizeTracking, sameTracking } from '../src/util/tracking.mjs';
import { daysBetween } from '../src/util/time.mjs';

test('maskPhone hides the middle block', () => {
  assert.equal(maskPhone('010-1234-5678'), '010-****-5678');
});

test('normalizeTracking trims', () => {
  assert.equal(normalizeTracking('  PD1234AB '), 'PD1234AB');
  assert.equal(sameTracking('PD1234AB', ' PD1234AB'), true);
});

test('daysBetween', () => {
  assert.equal(daysBetween('2026-11-01T00:00:00.000Z', '2026-11-03T00:00:00.000Z'), 2);
});
