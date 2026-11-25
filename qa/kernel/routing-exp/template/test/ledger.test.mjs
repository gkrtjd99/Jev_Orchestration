import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory-store.mjs';
import { createIdGenerator } from '../src/util/ids.mjs';
import { Ledger } from '../src/payments/ledger.mjs';

const ledger = () => new Ledger({ store: new MemoryStore(), ids: createIdGenerator('pay') });

test('payments are recorded and add up per currency', async () => {
  const book = ledger();
  const entry = await book.recordPayment({ memberId: 'mb-1', amount: '12.50', currency: 'USD', reference: 'May pass' });
  assert.equal(entry.amountMinor, 1250);
  await book.recordPayment({ memberId: 'mb-1', amount: '7.25', currency: 'USD' });
  await book.recordPayment({ memberId: 'mb-1', amount: '9000', currency: 'KRW' });
  assert.equal(await book.balance('mb-1', 'USD'), '19.75');
  assert.equal(await book.balance('mb-1', 'KRW'), '9000');
  assert.equal((await book.entriesFor('mb-1')).length, 3);
});

test('invalid payments are rejected', async () => {
  const book = ledger();
  await assert.rejects(book.recordPayment({ memberId: 'mb-1', amount: '0.00', currency: 'USD' }), { code: 'INVALID_AMOUNT' });
  await assert.rejects(book.recordPayment({ memberId: '', amount: '5.00', currency: 'USD' }), { code: 'MEMBER_REQUIRED' });
});
