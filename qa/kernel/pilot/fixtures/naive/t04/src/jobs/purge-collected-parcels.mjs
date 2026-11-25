import { daysBetween } from '../util/time.mjs';

const KEEP_DAYS = 30;

// Removes parcel records that were collected more than a month ago.
export const purgeCollectedParcels = {
  name: 'purge-collected-parcels',
  everyMinutes: 1440,
  async run({ store, now }) {
    let removed = 0;
    for (const parcel of store.list('parcels')) {
      if (parcel.status !== 'collected' || !parcel.collectedAt) continue;
      if (daysBetween(parcel.collectedAt, now) <= KEEP_DAYS) continue;
      store.remove('parcels', parcel.id);
      removed += 1;
    }
    return removed;
  },
};
