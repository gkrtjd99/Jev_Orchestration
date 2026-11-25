---
name: pg-slow-query-plan
description: "Diagnose a slow PostgreSQL query from EXPLAIN (ANALYZE, BUFFERS) output and propose index or rewrite fixes. Use when a specific query or endpoint is slow and the database is the suspect."
---

# Slow query diagnosis

1. Find the node where estimated and actual rows diverge the most.
2. Look for sequential scans on large tables, sorts spilling to disk and nested loops over many rows.
3. Propose an index or rewrite and state the expected plan change.
4. Re-run with BUFFERS and compare.
