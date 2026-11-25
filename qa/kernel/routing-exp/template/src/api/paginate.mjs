// Paging for list endpoints.
import { ValidationError } from '../util/errors.mjs';

/** Page-number paging: { items, page, pageSize, total, totalPages }. Pages start at 1. */
export function paginate(items, { page = 1, pageSize = 20 } = {}) {
  if (!Number.isInteger(page) || page < 1) throw new ValidationError('INVALID_PAGE', 'page must be a whole number from 1');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new ValidationError('INVALID_PAGE_SIZE', 'pageSize must be a whole number from 1 to 100');
  }
  const total = items.length;
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}
