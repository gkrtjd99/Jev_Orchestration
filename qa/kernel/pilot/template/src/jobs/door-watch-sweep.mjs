import { doorNeedsAlert } from '../lockers/door-watch.mjs';

// Collects the lockers whose door has been open for too long.
export const doorWatchSweep = {
  name: 'door-watch-sweep',
  everyMinutes: 1,
  async run({ store, now }) {
    const open = store.list('lockers').filter((locker) => doorNeedsAlert(locker.doorOpenedAt, now));
    for (const locker of open) store.put('doorNotices', { id: locker.id, raisedAt: now.toISOString() });
    return open.length;
  },
};
