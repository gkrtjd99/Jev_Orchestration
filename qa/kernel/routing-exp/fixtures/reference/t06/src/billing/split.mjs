// Splitting one charge between several payers, in minor units, so that the shares add up to the total.
import { ValidationError } from '../util/errors.mjs';
import { parseAmount, formatAmount } from '../money/currency.mjs';

export function splitCharge(total, currency, weights) {
  if (!Array.isArray(weights) || weights.length === 0 || !weights.every((w) => Number.isSafeInteger(w) && w > 0)) {
    throw new ValidationError('INVALID_WEIGHTS', 'weights must be a non-empty list of positive whole numbers');
  }
  const totalMinor = BigInt(parseAmount(total, currency));
  const weightSum = weights.reduce((sum, w) => sum + BigInt(w), 0n);
  // Largest remainder: everyone gets the whole minor units of their share, the units left over go one each
  // to the largest fractional parts (earlier payers first on a tie).
  const shares = weights.map((w, index) => {
    const product = totalMinor * BigInt(w);
    return { index, minor: product / weightSum, remainder: product % weightSum };
  });
  let left = totalMinor - shares.reduce((sum, share) => sum + share.minor, 0n);
  const byRemainder = [...shares].sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  for (const share of byRemainder) {
    if (left === 0n) break;
    share.minor += 1n;
    left -= 1n;
  }
  return shares.map((share) => formatAmount(Number(share.minor), currency));
}
