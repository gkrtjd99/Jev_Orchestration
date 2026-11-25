import test from 'node:test';
import assert from 'node:assert/strict';
import { expandWeekly, sessionsInRange } from '../src/schedule/recurrence.mjs';

const seoul = { start: '2026-01-06T19:30', timeZone: 'Asia/Seoul' };

test('a weekly class repeats every seven days', () => {
  assert.deepEqual(expandWeekly(seoul, 3), ['2026-01-06T10:30:00.000Z', '2026-01-13T10:30:00.000Z', '2026-01-20T10:30:00.000Z']);
  assert.deepEqual(expandWeekly(seoul, 0), []);
});

test('except dates are skipped', () => {
  const rule = { ...seoul, except: ['2026-01-13'] };
  assert.deepEqual(expandWeekly(rule, 2), ['2026-01-06T10:30:00.000Z', '2026-01-20T10:30:00.000Z']);
});

test('sessionsInRange is half-open', () => {
  assert.deepEqual(sessionsInRange(seoul, '2026-01-13T10:30:00Z', '2026-01-27T10:30:00Z'), ['2026-01-13T10:30:00.000Z', '2026-01-20T10:30:00.000Z']);
  assert.deepEqual(sessionsInRange(seoul, '2025-12-01T00:00:00Z', '2026-01-06T10:30:00Z'), []);
});
