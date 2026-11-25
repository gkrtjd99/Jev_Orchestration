---
name: load-testing-k6
description: "Design and run load tests with k6: ramping and constant-arrival scenarios, thresholds on latency percentiles and error rate, result interpretation. Use when the question is how a system behaves under concurrent traffic."
---

# Load Testing K6

## Guidelines

1. Model arrival rate, not virtual users, for throughput questions.
2. Define pass/fail thresholds in the script.
3. Warm up, then hold steady state long enough to see GC and connection-pool effects.
4. Never point at production without written approval.
