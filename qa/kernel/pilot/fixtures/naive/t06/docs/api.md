# API

| Method | Path | Result |
|---|---|---|
| GET | `/health` | `{ "ok": true }` |
| GET | `/parcels/:id` | The parcel without the pickup code, or 404 |
| POST | `/parcels/:id/collect` | Marks the parcel collected and frees its compartment |
| GET | `/lockers/:id/occupancy` | How many parcels are stored in the locker, or 404 |

Try one from the command line:

```bash
node src/main.mjs GET /parcels/P-1001
```
