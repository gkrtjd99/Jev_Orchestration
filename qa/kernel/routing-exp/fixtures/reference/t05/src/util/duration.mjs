import { ValidationError } from './errors.mjs';

/** 45 -> '45m', 90 -> '1h 30m', 120 -> '2h', 0 -> '0m'. */
export function formatDuration(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0) throw new ValidationError('INVALID_DURATION', `Not a whole number of minutes: ${minutes}`);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
