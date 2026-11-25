// Seat booking. Sessions live under `session:<id>`, bookings under `booking:<sessionId>:<bookingId>`.
import { BookingError, NotFoundError } from '../util/errors.mjs';
import { createSession } from '../schedule/sessions.mjs';

export class BookingService {
  constructor({ store, ids, now = () => new Date() }) {
    this.store = store;
    this.ids = ids;
    this.now = now;
  }

  busy = new Set();

  async addSession(input) {
    const session = createSession(input);
    await this.store.set(`session:${session.id}`, session);
    return session;
  }

  async getSession(sessionId) {
    const session = await this.store.get(`session:${sessionId}`);
    if (!session) throw new NotFoundError('SESSION_NOT_FOUND', `No session ${sessionId}`);
    return session;
  }

  /** Active bookings of a session, oldest first. */
  async listBookings(sessionId) {
    const rows = await this.store.list(`booking:${sessionId}:`);
    return rows.map((row) => row.value).filter((booking) => booking.status === 'active');
  }

  async seatsLeft(sessionId) {
    const session = await this.getSession(sessionId);
    return session.capacity - (await this.listBookings(sessionId)).length;
  }

  /** Books one seat for the member. A member holds at most one active booking per session. */
  async bookSeat(sessionId, memberId) {
    if (this.busy.has(sessionId)) throw new BookingError('FULL', `Session ${sessionId} is being booked, try again`);
    this.busy.add(sessionId);
    try {
      return await this.#bookSeat(sessionId, memberId);
    } finally {
      this.busy.delete(sessionId);
    }
  }

  async #bookSeat(sessionId, memberId) {
    const session = await this.getSession(sessionId);
    const bookings = await this.listBookings(sessionId);
    if (bookings.some((booking) => booking.memberId === memberId)) {
      throw new BookingError('ALREADY_BOOKED', `Member ${memberId} already has a seat in ${sessionId}`);
    }
    if (bookings.length >= session.capacity) {
      throw new BookingError('FULL', `Session ${sessionId} is full`);
    }
    const booking = { id: this.ids.next(), sessionId, memberId, status: 'active', bookedAt: this.now().toISOString() };
    await this.store.set(`booking:${sessionId}:${booking.id}`, booking);
    return booking;
  }

  /** Cancels a booking and frees its seat. */
  async cancel(sessionId, bookingId) {
    const key = `booking:${sessionId}:${bookingId}`;
    const booking = await this.store.get(key);
    if (!booking || booking.status !== 'active') throw new NotFoundError('BOOKING_NOT_FOUND', `No active booking ${bookingId}`);
    const cancelled = { ...booking, status: 'cancelled', cancelledAt: this.now().toISOString() };
    await this.store.set(key, cancelled);
    return cancelled;
  }
}
