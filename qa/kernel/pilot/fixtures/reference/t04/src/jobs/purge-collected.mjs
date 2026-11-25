import { daysBetween } from '../util/time.mjs';

const KEEP_DAYS = 30;

// Removes parcel records that were collected more than a month ago.
export const purgeCollected = {
  name: 'parcels.purge-collected@v1',
  everyMinutes: 1440,
  ceilingSec: 10,
  async run({ store, now }) {
    let changed = 0;
    let skipped = 0;
    for (const parcel of store.list('parcels')) {
      const old = parcel.status === 'collected' && parcel.collectedAt && daysBetween(parcel.collectedAt, now) > KEEP_DAYS;
      if (old) {
        store.remove('parcels', parcel.id);
        changed += 1;
      } else skipped += 1;
    }
    return { scanned: changed + skipped, changed, skipped };
  },
};
