// Carrier tracking numbers arrive typed by hand, so we normalise before comparing them.
export function normalizeTracking(raw) {
  return String(raw ?? '').replace(/[\s-]+/g, '').toUpperCase();
}

export function sameTracking(a, b) {
  return normalizeTracking(a) === normalizeTracking(b);
}
