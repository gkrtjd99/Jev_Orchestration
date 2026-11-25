// Clears pickup codes that are past their expiry so they can no longer open a compartment.
export const expirePickupCodes = {
  name: 'expire-pickup-codes',
  everyMinutes: 15,
  async run({ store, now }) {
    let cleared = 0;
    for (const parcel of store.list('parcels')) {
      if (parcel.status !== 'stored' || !parcel.pickupCode) continue;
      if (new Date(parcel.codeExpiresAt).getTime() > now.getTime()) continue;
      store.put('parcels', { ...parcel, pickupCode: null });
      cleared += 1;
    }
    return cleared;
  },
};
