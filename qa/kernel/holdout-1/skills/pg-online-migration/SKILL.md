---
name: pg-online-migration
description: "Apply schema changes to a busy PostgreSQL table without blocking writes: expand/contract steps, lock timeouts, concurrent index builds and batched backfills. Use when altering large tables in production."
---

# Online schema migration

1. Set `lock_timeout` and retry; never hold an ACCESS EXCLUSIVE lock for long.
2. Add columns nullable, backfill in batches, then add constraints as NOT VALID and validate.
3. Build indexes with CREATE INDEX CONCURRENTLY.
4. Ship as expand, migrate, contract across separate deploys.
