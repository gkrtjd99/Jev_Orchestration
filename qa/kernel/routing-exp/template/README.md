# studiobook

Back end for small fitness studios: members, class schedules, bookings, waitlists and payments.
Plain Node.js (ES modules), no dependencies. Run the tests with `npm test`.

## Layout

| Path | What it holds |
|---|---|
| `src/app.mjs` | Wires the services together (`createApp`) |
| `src/config/settings.mjs` | Settings read from environment variables |
| `src/util/` | Errors, ids and time-zone helpers |
| `src/money/currency.mjs` | Currencies and conversion between amount text and minor units |
| `src/billing/invoice.mjs` | Invoices built from line items |
| `src/members/` | Display-name rules and the member directory |
| `src/store/` | The in-memory store and a read cache in front of a store |
| `src/schedule/` | Class sessions and weekly recurrence |
| `src/booking/` | Seat booking and the waitlist |
| `src/api/` | Pagination and request handlers |
| `src/payments/ledger.mjs` | Payment ledger |
| `src/reports/attendance.mjs` | Attendance figures |

## Conventions

- Amounts travel as text in major units (`'12.50'`) and are computed as integers in minor units.
  `src/money/currency.mjs` is the only place that knows how many minor units a currency has.
- Instants are ISO 8601 strings in UTC. Studio wall-clock times are `'YYYY-MM-DDTHH:mm'` plus an IANA time zone.
- Every failure the caller can act on is an `AppError` subclass with a stable `code` (`src/util/errors.mjs`).
- Stores are asynchronous. Code that uses a store must not assume that two calls run back to back.
