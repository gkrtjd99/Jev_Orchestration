import { toCsv } from '../util/csv.mjs';
import { sameUtcDay } from '../util/time.mjs';

// One line per locker: how many parcels arrived and how many were collected on the given day.
export function dailySummaryCsv(parcels, day) {
  const perLocker = new Map();
  const entry = (lockerId) => {
    if (!perLocker.has(lockerId)) perLocker.set(lockerId, { locker: lockerId, arrived: 0, collected: 0 });
    return perLocker.get(lockerId);
  };
  for (const parcel of parcels) {
    if (sameUtcDay(parcel.arrivedAt, day)) entry(parcel.lockerId).arrived += 1;
    if (parcel.collectedAt && sameUtcDay(parcel.collectedAt, day)) entry(parcel.lockerId).collected += 1;
  }
  const records = [...perLocker.values()].sort((a, b) => a.locker.localeCompare(b.locker));
  return toCsv(records, [
    { key: 'locker', header: 'Locker' },
    { key: 'arrived', header: 'Arrived' },
    { key: 'collected', header: 'Collected' },
  ]);
}
