import { ValidationError } from '../util/errors.mjs';
import { parseAmount, formatAmount } from '../money/currency.mjs';

export function splitCharge(total, currency, weights) {
  if (!Array.isArray(weights) || weights.length === 0 || !weights.every((w) => Number.isInteger(w) && w > 0)) {
    throw new ValidationError('INVALID_WEIGHTS', 'weights must be a non-empty list of positive whole numbers');
  }
  const totalMinor = parseAmount(total, currency);
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  const shares = weights.map((w) => Math.round((totalMinor * w) / weightSum));
  // Whatever rounding left over goes to the last payer so the shares add up.
  const assigned = shares.slice(0, -1).reduce((sum, share) => sum + share, 0);
  shares[shares.length - 1] = totalMinor - assigned;
  return shares.map((share) => formatAmount(share, currency));
}
