import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory-store.mjs';
import { createIdGenerator } from '../src/util/ids.mjs';
import { BookingService } from '../src/booking/booking-service.mjs';

async function service(capacity = 2) {
  const bookings = new BookingService({ store: new MemoryStore(), ids: createIdGenerator('bk') });
  await bookings.addSession({ id: 'pilates-tue', title: 'Pilates', startsAt: '2026-06-02T10:00:00Z', capacity });
  return bookings;
}

test('seats are booked until the session is full', async () => {
  const bookings = await service(2);
  await bookings.bookSeat('pilates-tue', 'mb-1');
  await bookings.bookSeat('pilates-tue', 'mb-2');
  await assert.rejects(bookings.bookSeat('pilates-tue', 'mb-3'), { name: 'BookingError', code: 'FULL' });
  assert.equal(await bookings.seatsLeft('pilates-tue'), 0);
});

test('a member cannot book the same session twice', async () => {
  const bookings = await service(3);
  await bookings.bookSeat('pilates-tue', 'mb-1');
  await assert.rejects(bookings.bookSeat('pilates-tue', 'mb-1'), { code: 'ALREADY_BOOKED' });
});

test('cancelling frees the seat', async () => {
  const bookings = await service(1);
  const booking = await bookings.bookSeat('pilates-tue', 'mb-1');
  await bookings.cancel('pilates-tue', booking.id);
  await bookings.bookSeat('pilates-tue', 'mb-2');
  assert.deepEqual((await bookings.listBookings('pilates-tue')).map((b) => b.memberId), ['mb-2']);
  await assert.rejects(bookings.bookSeat('nope', 'mb-1'), { code: 'SESSION_NOT_FOUND' });
});
