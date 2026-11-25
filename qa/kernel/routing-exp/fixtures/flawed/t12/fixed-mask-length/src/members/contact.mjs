import { ValidationError } from '../util/errors.mjs';

export function normalizeEmail(email) {
  if (typeof email !== 'string') throw new ValidationError('INVALID_EMAIL', 'An email address must be text');
  const address = email.trim().toLowerCase();
  const parts = address.split('@');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') throw new ValidationError('INVALID_EMAIL', `Not an email address: ${email}`);
  return address;
}

export function maskEmail(email) {
  const [local, domain] = normalizeEmail(email).split('@');
  return `${local[0]}*******@${domain}`;
}
