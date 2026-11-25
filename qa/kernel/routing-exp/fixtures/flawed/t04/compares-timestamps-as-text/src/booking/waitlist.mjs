// The waitlist of one session: who gets the next seat that frees up.
import { BookingError, ConflictError, ValidationError } from '../util/errors.mjs';

export const TIERS = ['vip', 'regular', 'trial'];

export function orderWaitlist(entries) {
  for (const entry of entries) {
    if (!TIERS.includes(entry.tier)) throw new ValidationError('UNKNOWN_TIER', `Unknown tier: ${entry.tier}`);
  }
  return [...entries].sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.joinedAt.localeCompare(b.joinedAt));
}

export class Waitlist {
  #entries = [];

  constructor({ maxSize = 20, now = () => new Date() } = {}) {
    this.maxSize = maxSize;
    this.now = now;
  }

  get size() {
    return this.#entries.length;
  }

  /** Adds a member to the end of the list: { memberId, tier, joinedAt }. */
  add(memberId, tier = 'regular') {
    if (!TIERS.includes(tier)) throw new ValidationError('UNKNOWN_TIER', `Unknown tier: ${tier}`);
    if (this.#entries.some((entry) => entry.memberId === memberId)) throw new ConflictError('ALREADY_WAITING');
    if (this.#entries.length >= this.maxSize) throw new BookingError('WAITLIST_FULL');
    const entry = { memberId, tier, joinedAt: this.now().toISOString() };
    this.#entries.push(entry);
    return { ...entry };
  }

  remove(memberId) {
    const index = this.#entries.findIndex((entry) => entry.memberId === memberId);
    if (index < 0) return false;
    this.#entries.splice(index, 1);
    return true;
  }

  /** The entries in the order they were added. */
  entries() {
    return this.#entries.map((entry) => ({ ...entry }));
  }

  /** Who is offered the next free seat: the first entry in priority order. Null when nobody waits. */
  next() {
    const first = orderWaitlist(this.#entries.map((entry) => ({ ...entry })))[0];
    return first ? { ...first } : null;
  }

  /** Takes the next member off the list and returns their entry, or null. */
  promote() {
    const entry = this.next();
    if (entry) this.remove(entry.memberId);
    return entry;
  }
}
