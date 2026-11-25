# API

| Method | Path | Result |
|---|---|---|
| GET | `/health` | `{ "ok": true }` |
| GET | `/parcels/:id` | The parcel without the pickup code, or 404 |
| POST | `/parcels/:id/collect` | Marks the parcel collected and frees its compartment |

Try one from the command line:

```bash
node src/main.mjs GET /parcels/P-1001
```
