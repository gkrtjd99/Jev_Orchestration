import { loadSettings } from '../config/settings.mjs';
import { secondsBetween } from '../util/time.mjs';

// True once a door has been open long enough that somebody should go and close it.
export function doorNeedsAlert(doorOpenedAt, now, settings = loadSettings()) {
  if (!doorOpenedAt) return false;
  return secondsBetween(doorOpenedAt, now) >= settings.doorAlertAfterSec;
}
