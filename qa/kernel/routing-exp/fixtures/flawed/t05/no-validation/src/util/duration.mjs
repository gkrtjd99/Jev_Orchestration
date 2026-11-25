import { ValidationError } from './errors.mjs';

export function formatDuration(minutes) {
  if (typeof minutes !== 'number' || minutes < 0) throw new ValidationError('INVALID_DURATION', `Not a duration: ${minutes}`);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
