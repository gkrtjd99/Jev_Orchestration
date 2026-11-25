// Weekly classes. A rule describes a class that repeats every week:
//   { start: 'YYYY-MM-DDTHH:mm',   studio wall-clock time of the first session
//     timeZone: 'Area/City',       IANA time zone of the studio
//     except: ['YYYY-MM-DD', ...]  optional studio-local dates on which the class does not take place }
// Sessions are returned as ISO 8601 instants in UTC.
import { ValidationError } from '../util/errors.mjs';
import { WEEK_MS, HOUR_MS, localToUtc, utcToLocal, parseLocal, addDays, formatLocalDate, isKnownTimeZone } from '../util/time.mjs';

function checked(rule) {
  if (rule === null || typeof rule !== 'object') throw new ValidationError('INVALID_RULE');
  if (!isKnownTimeZone(rule.timeZone)) throw new ValidationError('UNKNOWN_TIME_ZONE', `Unknown time zone: ${rule.timeZone}`);
  if (rule.except !== undefined && !Array.isArray(rule.except)) throw new ValidationError('INVALID_RULE');
  return parseLocal(rule.start);
}

// The session of week `week` (0 = the first): the same wall-clock time, 7 * week calendar days later, read in
// the studio's zone. The gap between two sessions is not always 168 hours: it is 167 or 169 across a clock change.
const instantOf = (rule, start, week) => localToUtc(addDays(start, 7 * week), rule.timeZone);

const cancelled = (rule, instant) => (rule.except ?? []).includes(formatLocalDate(utcToLocal(instant, rule.timeZone)));

/** The first `count` sessions of the rule, skipping the except dates. */
export function expandWeekly(rule, count) {
  if (!Number.isInteger(count) || count < 0) throw new ValidationError('INVALID_COUNT');
  const start = checked(rule);
  const sessions = [];
  for (let week = 0; sessions.length < count; week += 1) {
    const instant = instantOf(rule, start, week);
    sessions.push(new Date(instant).toISOString());
  }
  return sessions;
}

/** The sessions of the rule that start at or after `from` and before `to` (ISO 8601 instants). */
export function sessionsInRange(rule, from, to) {
  const start = checked(rule);
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) throw new ValidationError('INVALID_RANGE');
  const first = instantOf(rule, start, 0);
  const sessions = [];
  const firstWeek = Math.max(0, Math.floor((fromMs - first) / WEEK_MS) - 1);
  for (let week = firstWeek; ; week += 1) {
    const instant = instantOf(rule, start, week);
    if (instant >= toMs) break;
    if (instant < fromMs) continue;
    sessions.push(new Date(instant).toISOString());
  }
  return sessions;
}
