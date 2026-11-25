import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailySummaryCsv } from '../src/reports/daily-summary.mjs';
import { toCsv } from '../src/util/csv.mjs';

test('csv quoting', () => {
  assert.equal(toCsv([{ a: 'x,y' }], [{ key: 'a', header: 'A' }]), 'A\n"x,y"\n');
});

test('daily summary counts per locker', () => {
  const parcels = [
    { lockerId: 'L-A1', arrivedAt: '2026-11-01T02:00:00.000Z', collectedAt: null },
    { lockerId: 'L-A1', arrivedAt: '2026-10-30T02:00:00.000Z', collectedAt: '2026-11-01T09:00:00.000Z' },
  ];
  assert.equal(dailySummaryCsv(parcels, '2026-11-01T00:00:00.000Z'), 'Locker,Arrived,Collected\nL-A1,1,1\n');
});
