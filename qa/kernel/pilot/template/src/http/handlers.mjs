import { releaseCompartment } from '../lockers/assign.mjs';

function publicParcel(parcel) {
  const { pickupCode, ...rest } = parcel;
  return rest;
}

export function health() {
  return { status: 200, body: { ok: true } };
}

export function getParcel({ params, store }) {
  const parcel = store.get('parcels', params.id);
  if (!parcel) return { status: 404, body: { error: 'parcel not found' } };
  return { status: 200, body: publicParcel(parcel) };
}

export function collectParcel({ params, store, now }) {
  const parcel = store.get('parcels', params.id);
  if (!parcel) return { status: 404, body: { error: 'parcel not found' } };
  if (parcel.status !== 'stored') return { status: 409, body: { error: `parcel is ${parcel.status}` } };
  const locker = store.get('lockers', parcel.lockerId);
  if (locker) {
    releaseCompartment(locker, parcel.id);
    store.put('lockers', locker);
  }
  const updated = { ...parcel, status: 'collected', collectedAt: now.toISOString(), pickupCode: null };
  store.put('parcels', updated);
  return { status: 200, body: publicParcel(updated) };
}
