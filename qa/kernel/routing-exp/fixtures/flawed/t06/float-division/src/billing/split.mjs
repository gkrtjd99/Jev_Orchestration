import { ValidationError } from '../util/errors.mjs';

export function splitCharge(total, currency, weights) {
  if (!Array.isArray(weights) || weights.length === 0 || !weights.every((w) => Number.isInteger(w) && w > 0)) {
    throw new ValidationError('INVALID_WEIGHTS', 'weights must be a non-empty list of positive whole numbers');
  }
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  return weights.map((w) => ((Number(total) * w) / weightSum).toFixed(2));
}
