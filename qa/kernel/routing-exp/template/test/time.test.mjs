import test from 'node:test';
import assert from 'node:assert/strict';
import { localToUtc, utcToLocal, zoneOffsetMinutes, addDays, formatLocal, parseLocal } from '../src/util/time.mjs';

test('localToUtc converts a studio wall-clock time to an instant', () => {
  assert.equal(new Date(localToUtc('2026-01-15T09:00', 'Asia/Seoul')).toISOString(), '2026-01-15T00:00:00.000Z');
  assert.equal(new Date(localToUtc('2026-01-15T18:00', 'America/New_York')).toISOString(), '2026-01-15T23:00:00.000Z');
  assert.equal(new Date(localToUtc('2026-07-15T18:00', 'America/New_York')).toISOString(), '2026-07-15T22:00:00.000Z');
});

test('utcToLocal and zoneOffsetMinutes agree', () => {
  const instant = Date.parse('2026-07-15T22:00:00Z');
  assert.deepEqual(utcToLocal(instant, 'America/New_York'), { year: 2026, month: 7, day: 15, hour: 18, minute: 0 });
  assert.equal(zoneOffsetMinutes(instant, 'America/New_York'), -240);
  assert.equal(zoneOffsetMinutes(instant, 'Asia/Kathmandu'), 345);
});

test('addDays moves a wall-clock reading across month ends', () => {
  assert.equal(formatLocal(addDays(parseLocal('2026-01-28T07:30'), 7)), '2026-02-04T07:30');
});

test('parseLocal rejects impossible dates', () => {
  assert.throws(() => parseLocal('2026-02-30T10:00'), { code: 'INVALID_LOCAL_TIME' });
  assert.throws(() => parseLocal('2026-02-10 10:00'), { code: 'INVALID_LOCAL_TIME' });
});
