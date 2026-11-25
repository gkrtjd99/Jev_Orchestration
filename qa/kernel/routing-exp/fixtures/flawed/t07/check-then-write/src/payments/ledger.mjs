// The payment ledger. Entries live under `ledger:<memberId>:<entryId>`.
import { ConflictError, ValidationError } from '../util/errors.mjs';
import { parseAmount, formatAmount } from '../money/currency.mjs';

export class Ledger {
  constructor({ store, ids, now = () => new Date() }) {
    this.store = store;
    this.ids = ids;
    this.now = now;
  }

  /** Records one payment; calls with the same idempotencyKey return the first entry. */
  async recordPayment(input) {
    const payment = this.#checked(input);
    const key = input.idempotencyKey;
    if (key === undefined || key === null) return this.#write(payment);
    const same = (entry) => entry.memberId === payment.memberId && entry.amountMinor === payment.amountMinor && entry.currency === payment.currency;
    const recorded = await this.store.get(`ledger-key:${key}`);
    if (recorded) {
      if (!same(recorded)) throw new ConflictError('IDEMPOTENCY_MISMATCH', `Key ${key} was used for another payment`);
      return recorded;
    }
    const entry = await this.#write(payment);
    await this.store.set(`ledger-key:${key}`, entry);
    return entry;
  }

  async #write({ memberId, amountMinor, currency, reference }) {
    const entry = { id: this.ids.next(), memberId, amountMinor, currency, reference, recordedAt: this.now().toISOString() };
    await this.store.set(`ledger:${memberId}:${entry.id}`, entry);
    return entry;
  }

  #checked({ memberId, amount, currency, reference = null }) {
    if (typeof memberId !== "string" || memberId === "") throw new ValidationError("MEMBER_REQUIRED");
    const amountMinor = parseAmount(amount, currency);
    if (amountMinor <= 0) throw new ValidationError("INVALID_AMOUNT", "A payment must be more than zero");
    return { memberId, amountMinor, currency, reference };
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
