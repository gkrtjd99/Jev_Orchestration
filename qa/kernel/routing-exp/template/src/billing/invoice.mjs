// Invoices are computed in minor units and reported as amount text.
import { ValidationError } from '../util/errors.mjs';
import { parseAmount, formatAmount } from '../money/currency.mjs';

/**
 * buildInvoice({ memberId, currency, lines: [{ description, unitAmount: '12.50', quantity }], discountPercent })
 * -> { memberId, currency, lines: [{ description, quantity, unitAmount, amount }], subtotal, discount, total }
 */
export function buildInvoice({ memberId, currency, lines, discountPercent = 0 }) {
  if (typeof memberId !== 'string' || memberId === '') throw new ValidationError('MEMBER_REQUIRED');
  if (!Array.isArray(lines) || lines.length === 0) throw new ValidationError('LINES_REQUIRED');
  if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) throw new ValidationError('INVALID_DISCOUNT');

  let subtotal = 0;
  const priced = lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new ValidationError('INVALID_QUANTITY');
    const amount = parseAmount(line.unitAmount, currency) * line.quantity;
    subtotal += amount;
    return { description: String(line.description ?? ''), quantity: line.quantity, unitAmount: line.unitAmount, amount: formatAmount(amount, currency) };
  });
  // Whole percentages of whole minor units: the product is exact, the division is rounded half up.
  const discount = Math.round((subtotal * discountPercent) / 100);
  return {
    memberId, currency, lines: priced,
    subtotal: formatAmount(subtotal, currency),
    discount: formatAmount(discount, currency),
    total: formatAmount(subtotal - discount, currency),
  };
}
