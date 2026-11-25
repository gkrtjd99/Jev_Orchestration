// The payment ledger. Entries live under `ledger:<memberId>:<entryId>`.
import { ValidationError } from '../util/errors.mjs';
import { parseAmount, formatAmount } from '../money/currency.mjs';

export class Ledger {
  constructor({ store, ids, now = () => new Date() }) {
    this.store = store;
    this.ids = ids;
    this.now = now;
  }

  /**
   * Records one payment: { memberId, amount: '12.50', currency, reference? }
   * -> { id, memberId, amountMinor, currency, reference, recordedAt }
   */
  async recordPayment({ memberId, amount, currency, reference = null }) {
    if (typeof memberId !== 'string' || memberId === '') throw new ValidationError('MEMBER_REQUIRED');
    const amountMinor = parseAmount(amount, currency);
    if (amountMinor <= 0) throw new ValidationError('INVALID_AMOUNT', 'A payment must be more than zero');
    const entry = { id: this.ids.next(), memberId, amountMinor, currency, reference, recordedAt: this.now().toISOString() };
    await this.store.set(`ledger:${memberId}:${entry.id}`, entry);
    return entry;
  }

  /** Every ledger entry of a member, oldest first. */
  async entriesFor(memberId) {
    const rows = await this.store.list(`ledger:${memberId}:`);
    return rows.map((row) => row.value);
  }

  /** What the member has paid in one currency, as amount text. */
  async balance(memberId, currency) {
    const entries = await this.entriesFor(memberId);
    const total = entries.filter((entry) => entry.currency === currency).reduce((sum, entry) => sum + entry.amountMinor, 0);
    return formatAmount(total, currency);
  }
}
