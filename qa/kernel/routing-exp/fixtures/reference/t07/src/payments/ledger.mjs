// The payment ledger. Entries live under `ledger:<memberId>:<entryId>`.
import { ConflictError, ValidationError } from '../util/errors.mjs';
import { parseAmount, formatAmount } from '../money/currency.mjs';

export class Ledger {
  constructor({ store, ids, now = () => new Date() }) {
    this.store = store;
    this.ids = ids;
    this.now = now;
  }

  #queues = new Map();

  /**
   * Records one payment: { memberId, amount: '12.50', currency, reference?, idempotencyKey? }
   * -> { id, memberId, amountMinor, currency, reference, recordedAt }
   * Calls that carry the same idempotencyKey produce one entry; each of them returns it.
   */
  async recordPayment(input) {
    const payment = this.#checked(input);
    const key = input.idempotencyKey;
    if (key === undefined || key === null) return this.#write(payment);
    if (typeof key !== 'string' || key === '') throw new ValidationError('INVALID_IDEMPOTENCY_KEY');
    const same = (entry) => entry.memberId === payment.memberId && entry.amountMinor === payment.amountMinor && entry.currency === payment.currency;
    // One delivery per key at a time: a retry waits for the delivery in front of it, whether that one succeeds or fails.
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const run = previous.then(async () => {
      const recorded = await this.store.get(`ledger-key:${key}`);
      if (recorded) {
        if (!same(recorded)) throw new ConflictError('IDEMPOTENCY_MISMATCH', `Key ${key} was used for another payment`);
        return recorded;
      }
      const entry = await this.#write(payment);
      await this.store.set(`ledger-key:${key}`, entry);
      return entry;
    });
    const settled = run.catch(() => {});
    this.#queues.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    }
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
