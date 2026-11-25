import { addHours } from '../util/time.mjs';

export function issuePickupCode(now, ttlHours, random = Math.random) {
  const code = String(Math.floor(random() * 1_000_000)).padStart(6, '0');
  return { pickupCode: code, codeExpiresAt: addHours(now, ttlHours).toISOString() };
}

export function codeIsValid(parcel, code, now) {
  if (!parcel.pickupCode || parcel.pickupCode !== code) return false;
  return new Date(parcel.codeExpiresAt).getTime() > now.getTime();
}
