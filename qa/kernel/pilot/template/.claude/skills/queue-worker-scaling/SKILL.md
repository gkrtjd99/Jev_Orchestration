---
name: queue-worker-scaling
description: "Use when deciding how many queue workers to run for the outbound delivery queue, or tuning their concurrency under load."
---

# Queue Worker Scaling

Use when deciding how many queue workers to run for the outbound delivery queue, or tuning their concurrency under load.

## Steps

1. Measure queue depth over a full day before changing anything.
2. Scale on the age of the oldest message, not on CPU.
3. Change one setting at a time and watch for an hour.
