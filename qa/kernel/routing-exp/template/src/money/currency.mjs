// Amounts are text in major units outside this module ('12.50') and integers in minor units inside the code.
import { ValidationError } from '../util/errors.mjs';

const CURRENCIES = Object.freeze({
  KRW: { minorUnits: 0 },
  JPY: { minorUnits: 0 },
  USD: { minorUnits: 2 },
  EUR: { minorUnits: 2 },
  KWD: { minorUnits: 3 },
});

export const isKnownCurrency = (code) => Object.hasOwn(CURRENCIES, code);

export function minorUnits(code) {
  if (!isKnownCurrency(code)) throw new ValidationError('UNKNOWN_CURRENCY', `Unknown currency: ${code}`, { code });
  return CURRENCIES[code].minorUnits;
}

/** '12.50' USD -> 1250, '9000' KRW -> 9000. Rejects more decimals than the currency has. */
export function parseAmount(text, code) {
  const units = minorUnits(code);
  const match = typeof text === 'string' ? /^(\d+)(?:\.(\d+))?$/.exec(text) : null;
  if (!match || (match[2] ?? '').length > units) {
    throw new ValidationError('INVALID_AMOUNT', `Not a valid ${code} amount: ${text}`, { code });
  }
  const minor = Number(match[1]) * 10 ** units + Number((match[2] ?? '').padEnd(units, '0') || '0');
  if (!Number.isSafeInteger(minor)) throw new ValidationError('INVALID_AMOUNT', `Amount out of range: ${text}`, { code });
  return minor;
}

/** 1250 USD -> '12.50', 9000 KRW -> '9000', -5 USD -> '-0.05'. */
export function formatAmount(minor, code) {
  const units = minorUnits(code);
  if (!Number.isSafeInteger(minor)) throw new ValidationError('INVALID_AMOUNT', `Not a whole number of minor units: ${minor}`, { code });
  const sign = minor < 0 ? '-' : '';
  const digits = String(Math.abs(minor)).padStart(units + 1, '0');
  return units === 0 ? sign + digits : `${sign}${digits.slice(0, -units)}.${digits.slice(-units)}`;
}
