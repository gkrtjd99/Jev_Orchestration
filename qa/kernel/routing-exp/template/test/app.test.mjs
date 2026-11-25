import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { listMembers, sessionDetail, memberBalance } from '../src/api/handlers.mjs';
import { attendanceSummary, attendanceByMember } from '../src/reports/attendance.mjs';

test('the handlers work against a wired app', async () => {
  const app = createApp({ env: { STUDIO_CURRENCY: 'USD' } });
  const member = await app.members.register({ displayName: 'Bo Kim' });
  await app.bookings.addSession({ id: 'yoga-1', title: 'Yoga', startsAt: '2026-06-02T10:00:00Z', capacity: 4 });
  await app.bookings.bookSeat('yoga-1', member.id);
  await app.ledger.recordPayment({ memberId: member.id, amount: '20.00', currency: 'USD' });

  assert.equal((await listMembers(app, { pageSize: '10' })).total, 1);
  assert.equal((await sessionDetail(app, 'yoga-1')).seatsLeft, 3);
  assert.deepEqual(await memberBalance(app, member.id), { memberId: member.id, currency: 'USD', balance: '20.00' });
  await assert.rejects(listMembers(app, { page: 'two' }), { code: 'INVALID_PAGE' });
  assert.equal(app.waitlistFor('yoga-1'), app.waitlistFor('yoga-1'));
});

test('attendance figures', () => {
  const bookings = [
    { memberId: 'a', status: 'active', attended: true },
    { memberId: 'b', status: 'active', attended: false },
    { memberId: 'a', status: 'cancelled', attended: false },
  ];
  assert.deepEqual(attendanceSummary(bookings), { booked: 2, attended: 1, noShows: 1, rate: 50 });
  assert.deepEqual(attendanceByMember(bookings).get('a'), { booked: 1, attended: 1 });
});
