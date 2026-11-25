// Wires the services of one studio together.
import { loadSettings } from './config/settings.mjs';
import { createIdGenerator } from './util/ids.mjs';
import { MemoryStore } from './store/memory-store.mjs';
import { CachedStore } from './store/cache.mjs';
import { MemberDirectory } from './members/directory.mjs';
import { BookingService } from './booking/booking-service.mjs';
import { Waitlist } from './booking/waitlist.mjs';
import { Ledger } from './payments/ledger.mjs';

export function createApp({ env = process.env, store = new MemoryStore() } = {}) {
  const settings = loadSettings(env);
  const waitlists = new Map();
  return {
    settings,
    store,
    // Read-mostly screens (member list, session pages) go through the cache.
    readCache: new CachedStore(store, { ttlMs: settings.cacheTtlMs }),
    members: new MemberDirectory({ store, ids: createIdGenerator('mb') }),
    bookings: new BookingService({ store, ids: createIdGenerator('bk') }),
    ledger: new Ledger({ store, ids: createIdGenerator('pay') }),
    waitlistFor(sessionId) {
      if (!waitlists.has(sessionId)) waitlists.set(sessionId, new Waitlist());
      return waitlists.get(sessionId);
    },
  };
}
