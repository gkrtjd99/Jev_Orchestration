// A class session: one class at one instant with a fixed number of seats.
import { ValidationError } from '../util/errors.mjs';

export function createSession({ id, title, startsAt, durationMinutes = 60, capacity }) {
  if (typeof id !== 'string' || id === '') throw new ValidationError('SESSION_ID_REQUIRED');
  if (typeof title !== 'string' || title.trim() === '') throw new ValidationError('TITLE_REQUIRED');
  if (typeof startsAt !== 'string' || Number.isNaN(Date.parse(startsAt))) throw new ValidationError('INVALID_START');
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1) throw new ValidationError('INVALID_DURATION');
  if (!Number.isInteger(capacity) || capacity < 1) throw new ValidationError('INVALID_CAPACITY');
  return { id, title: title.trim(), startsAt: new Date(startsAt).toISOString(), durationMinutes, capacity };
}

export function endsAt(session) {
  return new Date(Date.parse(session.startsAt) + session.durationMinutes * 60000).toISOString();
}

export function hasStarted(session, now = new Date()) {
  return Date.parse(session.startsAt) <= now.getTime();
}
