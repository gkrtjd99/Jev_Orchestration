import { secondsBetween } from '../util/time.mjs';

const ALERT_AFTER_SECONDS = 120;

// True once a door has been open long enough that somebody should go and close it.
export function doorNeedsAlert(doorOpenedAt, now) {
  if (!doorOpenedAt) return false;
  return secondsBetween(doorOpenedAt, now) >= ALERT_AFTER_SECONDS;
}
