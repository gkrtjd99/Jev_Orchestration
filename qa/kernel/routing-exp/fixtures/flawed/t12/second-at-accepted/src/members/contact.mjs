import { ValidationError } from '../util/errors.mjs';

export function normalizeEmail(email) {
  if (typeof email !== 'string') throw new ValidationError('INVALID_EMAIL', 'An email address must be text');
  const address = email.trim().toLowerCase();
  const at = address.indexOf('@');
  if (at < 1 || at === address.length - 1) throw new ValidationError('INVALID_EMAIL', `Not an email address: ${email}`);
  return address;
}

export function maskEmail(email) {
  const address = normalizeEmail(email);
  const at = address.indexOf('@');
  return `${address[0]}${'*'.repeat(at - 1)}${address.slice(at)}`;
}
