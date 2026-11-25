// Request handlers: plain functions from a parsed query to a response body.
import { ValidationError } from '../util/errors.mjs';
import { paginate, paginateAfter } from './paginate.mjs';
import { attendanceSummary } from '../reports/attendance.mjs';

function wholeNumber(value, fallback, code) {
  if (value === undefined || value === '') return fallback;
  if (!/^[0-9]+$/.test(String(value))) throw new ValidationError(code, `Not a whole number: ${value}`);
  return Number(value);
}

/** GET /members?page=&pageSize= */
export async function listMembers(app, query = {}) {
  const members = await app.members.list();
  return paginate(members, { page: wholeNumber(query.page, 1, 'INVALID_PAGE'), pageSize: wholeNumber(query.pageSize, 20, 'INVALID_PAGE_SIZE') });
}

/** GET /members?after=&limit= */
export async function listMembersAfter(app, query = {}) {
  const members = await app.members.list();
  return paginateAfter(members, { after: query.after ?? null, limit: wholeNumber(query.limit, 20, 'INVALID_LIMIT') });
}

/** GET /sessions/:id */
export async function sessionDetail(app, sessionId) {
  const session = await app.bookings.getSession(sessionId);
  const bookings = await app.bookings.listBookings(sessionId);
  return { ...session, seatsLeft: session.capacity - bookings.length, attendance: attendanceSummary(bookings.map((booking) => ({ ...booking, attended: false }))) };
}

/** GET /members/:id/balance?currency= */
export async function memberBalance(app, memberId, query = {}) {
  const member = await app.members.get(memberId);
  const currency = query.currency ?? app.settings.currency;
  return { memberId: member.id, currency, balance: await app.ledger.balance(member.id, currency) };
}
