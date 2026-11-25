import { ValidationError } from './errors.mjs';

export function formatDuration(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0) throw new ValidationError('INVALID_DURATION', `Not a whole number of minutes: ${minutes}`);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest}m` : `${hours}h ${rest}m`;
}
