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

/** Cursor paging: { items, nextCursor }. `after` is the id of the last record of the previous page. */
export function paginateAfter(items, { after = null, limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('INVALID_LIMIT', 'limit must be a whole number from 1 to 100');
  let start = 0;
  if (after !== null && after !== undefined) {
    const index = items.findIndex((item) => item.id === after);
    if (index < 0) throw new ValidationError('INVALID_CURSOR', `No record with id ${after}`);
    start = index + 1;
  }
  const page = items.slice(start, start + limit);
  const more = start + page.length < items.length;
  return { items: page, nextCursor: more ? page[page.length - 1].id : null };
}
