# parceldesk

Small service behind the parcel lockers in our buildings. It keeps track of which parcel sits in which
locker compartment, hands out pickup codes, tells customers when a parcel is waiting, and produces a few
summaries for the operations team.

Plain Node (ESM), no dependencies, no build step.

```bash
npm test                                  # node --test
node src/main.mjs GET /health             # run one request against the seed data
node src/main.mjs GET /parcels/P-1001
```

## Layout

| Path | What lives there |
|---|---|
| `src/config/` | Settings read from the environment |
| `src/store/` | In-memory record store, seeded from `data/*.json` |
| `src/lockers/` | Compartment assignment, pickup codes, door watching |
| `src/http/` | Route table, handlers and the dispatcher |
| `src/notify/` | Customer message templates and the outbox |
| `src/jobs/` | Recurring jobs and their runner |
| `src/reports/` | Summaries for operations |
| `src/util/` | Small helpers (CSV, time, phone, tracking numbers) |
| `data/` | Seed records |
| `docs/` | Notes on architecture, API, settings and operations |
| `test/` | `node:test` suites |

See `docs/architecture.md` for how the pieces fit together.
