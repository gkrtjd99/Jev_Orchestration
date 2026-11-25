---
name: sql-migration
description: "Plan and write schema migrations for large production tables without downtime: expand/contract steps, batched backfills, lock timeouts, concurrent index builds, reversible scripts. Use when a table definition, constraint or column type has to change on a live database."
---

# Sql Migration

## Guidelines

1. Split every change into expand, backfill, switch and contract migrations that are each safe to deploy alone.
2. Set lock_timeout and statement_timeout; add constraints as NOT VALID then validate.
3. Backfill in keyed batches with throttling and resumability.
4. Write the down path and state which steps are irreversible.
