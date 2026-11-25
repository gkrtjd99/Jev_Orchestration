---
name: dashboard-chart-queries
description: "Use when writing aggregate queries that feed the charts on the internal operations dashboard."
---

# Dashboard Chart Queries

Use when writing aggregate queries that feed the charts on the internal operations dashboard.

## Steps

1. Aggregate per hour in UTC and let the chart convert.
2. Return at most 500 points per series.
3. Name each series after the metric, not after the query.
