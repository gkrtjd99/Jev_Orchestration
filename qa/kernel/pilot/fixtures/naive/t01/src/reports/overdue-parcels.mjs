import { toCsv } from '../util/csv.mjs';
import { daysBetween } from '../util/time.mjs';

const OVERDUE_AFTER_DAYS = 7;

// Parcels that have been stored for more than a week.
export function overdueParcelsCsv(parcels, now) {
  const records = parcels
    .filter((parcel) => parcel.status === 'stored' && daysBetween(parcel.arrivedAt, now) > OVERDUE_AFTER_DAYS)
    .map((parcel) => ({
      id: parcel.id,
      lockerId: parcel.lockerId,
      recipient: parcel.recipient,
      arrivedAt: parcel.arrivedAt,
      daysWaiting: Math.floor(daysBetween(parcel.arrivedAt, now)),
    }));
  return toCsv(records, [
    { key: 'id', header: 'Parcel' },
    { key: 'lockerId', header: 'Locker' },
    { key: 'recipient', header: 'Recipient' },
    { key: 'arrivedAt', header: 'Arrived' },
    { key: 'daysWaiting', header: 'Days waiting' },
  ]);
}
