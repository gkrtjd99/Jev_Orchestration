// Settings come from environment variables. Every value is validated here so the rest of the code can trust it.
import { ConfigError } from '../util/errors.mjs';
import { isKnownCurrency } from '../money/currency.mjs';
import { isKnownTimeZone } from '../util/time.mjs';

const DIGITS = /^[0-9]+$/;
const given = (value) => (typeof value === 'string' && value !== '' ? value : null);
const invalid = (name, value) => new ConfigError('INVALID_SETTING', `Invalid value for ${name}: ${value}`, { name });

export function loadSettings(env = process.env) {
  const timeZone = given(env.STUDIO_TIME_ZONE) ?? 'Asia/Seoul';
  if (!isKnownTimeZone(timeZone)) throw invalid('STUDIO_TIME_ZONE', timeZone);

  const currency = given(env.STUDIO_CURRENCY) ?? 'KRW';
  if (!isKnownCurrency(currency)) throw invalid('STUDIO_CURRENCY', currency);

  let maxActiveBookings = 5;
  const rawBookings = given(env.STUDIO_MAX_ACTIVE_BOOKINGS);
  if (rawBookings !== null) {
    if (!DIGITS.test(rawBookings) || Number(rawBookings) < 1) throw invalid('STUDIO_MAX_ACTIVE_BOOKINGS', rawBookings);
    maxActiveBookings = Number(rawBookings);
  }

  let cacheTtlMs = 30000;
  const rawTtl = given(env.STUDIO_CACHE_TTL_MS);
  if (rawTtl !== null) {
    if (!DIGITS.test(rawTtl)) throw invalid('STUDIO_CACHE_TTL_MS', rawTtl);
    cacheTtlMs = Number(rawTtl);
  }

  let maxWaitlist = 20;
  const rawWaitlist = given(env.STUDIO_MAX_WAITLIST);
  if (rawWaitlist !== null) {
    if (!DIGITS.test(rawWaitlist) || Number(rawWaitlist) < 1) throw invalid('STUDIO_MAX_WAITLIST', rawWaitlist);
    maxWaitlist = Number(rawWaitlist);
  }

  return Object.freeze({ timeZone, currency, maxActiveBookings, cacheTtlMs, maxWaitlist });
}
