import test from 'node:test';
import assert from 'node:assert/strict';
import { Waitlist } from '../src/booking/waitlist.mjs';

test('members wait in the order they joined', () => {
  let tick = 0;
  const waitlist = new Waitlist({ now: () => new Date(Date.UTC(2026, 4, 1, 9, tick++)) });
  waitlist.add('mb-1');
  waitlist.add('mb-2');
  assert.equal(waitlist.next().memberId, 'mb-1');
  assert.equal(waitlist.promote().memberId, 'mb-1');
  assert.equal(waitlist.next().memberId, 'mb-2');
  assert.equal(waitlist.size, 1);
});

test('the list has a size limit and no duplicates', () => {
  const waitlist = new Waitlist({ maxSize: 1 });
  waitlist.add('mb-1');
  assert.throws(() => waitlist.add('mb-1'), { code: 'ALREADY_WAITING' });
  assert.throws(() => waitlist.add('mb-2'), { code: 'WAITLIST_FULL' });
  assert.equal(waitlist.remove('mb-1'), true);
  assert.equal(waitlist.next(), null);
});
