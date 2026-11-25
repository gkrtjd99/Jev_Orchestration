---
name: data-profiling
description: "Profile an unfamiliar dataset before analysis: schema and types, null rates, cardinality, distributions, outliers, duplicates, referential oddities. Use when someone needs to know what is in the data and whether it can be trusted, without modifying it."
---

# Data Profiling

## Guidelines

1. Read-only: never change the source data.
2. Report per-column type, null percentage, distinct count and min/max.
3. Flag impossible values and suspicious spikes with example rows.
4. End with a short list of questions for the data owner.
