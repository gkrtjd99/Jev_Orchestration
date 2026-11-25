// Weekly classes. A rule describes a class that repeats every week:
//   { start: 'YYYY-MM-DDTHH:mm',   studio wall-clock time of the first session
//     timeZone: 'Area/City',       IANA time zone of the studio
//     except: ['YYYY-MM-DD', ...]  optional studio-local dates on which the class does not take place }
// Sessions are returned as ISO 8601 instants in UTC.
import { ValidationError } from '../util/errors.mjs';
import { WEEK_MS, localToUtc, utcToLocal, formatLocalDate, isKnownTimeZone } from '../util/time.mjs';

function firstInstant(rule) {
  if (rule === null || typeof rule !== 'object') throw new ValidationError('INVALID_RULE');
  if (!isKnownTimeZone(rule.timeZone)) throw new ValidationError('UNKNOWN_TIME_ZONE', `Unknown time zone: ${rule.timeZone}`);
  if (rule.except !== undefined && !Array.isArray(rule.except)) throw new ValidationError('INVALID_RULE');
  return localToUtc(rule.start, rule.timeZone);
}

const cancelled = (rule, instant) => (rule.except ?? []).includes(formatLocalDate(utcToLocal(instant, rule.timeZone)));

/** The first `count` sessions of the rule, skipping the except dates. */
export function expandWeekly(rule, count) {
  if (!Number.isInteger(count) || count < 0) throw new ValidationError('INVALID_COUNT');
  const first = firstInstant(rule);
  const sessions = [];
  for (let week = 0; sessions.length < count; week += 1) {
    const instant = first + week * WEEK_MS;
    if (cancelled(rule, instant)) continue;
    sessions.push(new Date(instant).toISOString());
  }
  return sessions;
}

/** The sessions of the rule that start at or after `from` and before `to` (ISO 8601 instants). */
export function sessionsInRange(rule, from, to) {
  const first = firstInstant(rule);
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) throw new ValidationError('INVALID_RANGE');
  const sessions = [];
  // Jump straight to the first week that can fall inside the range.
  const firstWeek = Math.max(0, Math.ceil((fromMs - first) / WEEK_MS));
  for (let week = firstWeek; first + week * WEEK_MS < toMs; week += 1) {
    const instant = first + week * WEEK_MS;
    if (cancelled(rule, instant)) continue;
    sessions.push(new Date(instant).toISOString());
  }
  return sessions;
}
