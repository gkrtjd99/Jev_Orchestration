import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatAmount, minorUnits } from '../src/money/currency.mjs';
import { buildInvoice } from '../src/billing/invoice.mjs';

test('amount text round-trips through minor units', () => {
  assert.equal(parseAmount('12.50', 'USD'), 1250);
  assert.equal(parseAmount('12.5', 'USD'), 1250);
  assert.equal(parseAmount('9000', 'KRW'), 9000);
  assert.equal(parseAmount('1.250', 'KWD'), 1250);
  assert.equal(formatAmount(1250, 'USD'), '12.50');
  assert.equal(formatAmount(9000, 'KRW'), '9000');
  assert.equal(formatAmount(5, 'KWD'), '0.005');
  assert.equal(formatAmount(-5, 'USD'), '-0.05');
});

test('amounts with too many decimals are rejected', () => {
  assert.throws(() => parseAmount('9000.5', 'KRW'), { code: 'INVALID_AMOUNT' });
  assert.throws(() => parseAmount('1.005', 'USD'), { code: 'INVALID_AMOUNT' });
  assert.throws(() => minorUnits('XXX'), { code: 'UNKNOWN_CURRENCY' });
});

test('an invoice totals its lines and applies the discount', () => {
  const invoice = buildInvoice({ memberId: 'mb-0001', currency: 'USD', discountPercent: 10,
    lines: [{ description: 'Yoga x4', unitAmount: '12.50', quantity: 4 }, { description: 'Mat rental', unitAmount: '3.05', quantity: 1 }] });
  assert.equal(invoice.subtotal, '53.05');
  assert.equal(invoice.discount, '5.31');
  assert.equal(invoice.total, '47.74');
});
