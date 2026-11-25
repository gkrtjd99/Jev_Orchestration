import { daysBetween } from '../util/time.mjs';

const OVERDUE_AFTER_DAYS = 7;
const EOL = '\r\n';

const compactUtc = (value) => `${new Date(value).toISOString().replace(/[-:]/g, '').slice(0, 13)}Z`;
const field = (value) => String(value ?? '').replace(/[;\r\n]/g, ' ');

// Parcels that have been stored for more than a week, as a file for operations.
export function overdueParcelsCsv(parcels, now) {
  const overdue = parcels
    .filter((parcel) => parcel.status === 'stored' && daysBetween(parcel.arrivedAt, now) > OVERDUE_AFTER_DAYS)
    .sort((a, b) => new Date(a.arrivedAt) - new Date(b.arrivedAt));
  const lines = [
    `#pd-export v2 name=overdue-parcels rows=${overdue.length}`,
    ['parcel_id', 'locker_id', 'recipient', 'arrived_at', 'days_waiting'].join(';'),
    ...overdue.map((parcel) => [
      parcel.id,
      parcel.lockerId,
      parcel.recipient,
      compactUtc(parcel.arrivedAt),
      Math.floor(daysBetween(parcel.arrivedAt, now)),
    ].map(field).join(';')),
  ];
  return lines.map((line) => line + EOL).join('');
}
