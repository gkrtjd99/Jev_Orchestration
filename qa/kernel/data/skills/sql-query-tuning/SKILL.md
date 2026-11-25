---
name: sql-query-tuning
description: "Diagnose and speed up slow SQL queries: read EXPLAIN ANALYZE plans, fix row-estimate problems, choose or reshape indexes, rewrite joins and aggregations. Use when a specific query or endpoint is slow, not when the schema itself must change."
---

# Sql Query Tuning

## Guidelines

1. Capture the real plan with EXPLAIN (ANALYZE, BUFFERS) on production-like data first.
2. Look for estimate/actual mismatches before adding indexes.
3. Prefer covering or partial indexes that match the predicate; check write cost.
4. Show before/after timings and the plan diff.
