---
name: sql-migration-safety
description: "Use when writing a schema migration for the relational reporting database that must not lock tables."
---

# Sql Migration Safety

Use when writing a schema migration for the relational reporting database that must not lock tables.

## Steps

1. Add columns as nullable first.
2. Backfill in batches.
3. Add constraints as not valid, then validate.
