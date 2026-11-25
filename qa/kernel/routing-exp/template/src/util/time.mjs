// Time-zone helpers. Instants are milliseconds since the epoch (UTC); a "local" value is a wall-clock reading
// in some IANA time zone, held as { year, month, day, hour, minute } or written 'YYYY-MM-DDTHH:mm'.
import { ValidationError } from './errors.mjs';

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
    } catch {
      throw new ValidationError('UNKNOWN_TIME_ZONE', `Unknown time zone: ${timeZone}`, { timeZone });
    }
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isKnownTimeZone(timeZone) {
  try { formatterFor(timeZone); return true; } catch { return false; }
}

/** The wall-clock reading of an instant in a time zone. */
export function utcToLocal(instantMs, timeZone) {
  const parts = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) parts[part.type] = part.value;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** Minutes the zone is ahead of UTC at that instant (negative west of Greenwich). */
export function zoneOffsetMinutes(instantMs, timeZone) {
  const local = utcToLocal(instantMs, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return Math.round((asUtc - Math.floor(instantMs / MINUTE_MS) * MINUTE_MS) / MINUTE_MS);
}

export function parseLocal(text) {
  const match = typeof text === 'string' ? LOCAL.exec(text) : null;
  if (!match) throw new ValidationError('INVALID_LOCAL_TIME', `Expected YYYY-MM-DDTHH:mm, got ${text}`);
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) {
    throw new ValidationError('INVALID_LOCAL_TIME', `Not a real date or time: ${text}`);
  }
  return { year, month, day, hour, minute };
}

const two = (n) => String(n).padStart(2, '0');
export const formatLocalDate = (local) => `${String(local.year).padStart(4, '0')}-${two(local.month)}-${two(local.day)}`;
export const formatLocal = (local) => `${formatLocalDate(local)}T${two(local.hour)}:${two(local.minute)}`;

/** The instant at which the zone's clocks show the given wall-clock reading. */
export function localToUtc(local, timeZone) {
  const fields = typeof local === 'string' ? parseLocal(local) : local;
  const guess = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
  const first = guess - zoneOffsetMinutes(guess, timeZone) * MINUTE_MS;
  return guess - zoneOffsetMinutes(first, timeZone) * MINUTE_MS;
}

/** Calendar arithmetic on a wall-clock reading: the same time of day, `days` days later. */
export function addDays(local, days) {
  const moved = new Date(Date.UTC(local.year, local.month - 1, local.day + days, local.hour, local.minute));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate(), hour: moved.getUTCHours(), minute: moved.getUTCMinutes() };
}
