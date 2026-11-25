---
name: postgres-index-advisor
description: "Use when a Postgres query is slow and you are deciding which index to add or drop."
---

# Postgres Index Advisor

Use when a Postgres query is slow and you are deciding which index to add or drop.

## Steps

1. Run EXPLAIN ANALYZE on a production-sized copy.
2. Prefer one composite index over several single-column ones.
3. Create indexes concurrently.
