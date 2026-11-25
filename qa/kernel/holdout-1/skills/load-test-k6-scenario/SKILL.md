---
name: load-test-k6-scenario
description: "Write and run k6 load test scenarios with realistic ramp profiles, thresholds and think time, and read the results. Use before a launch or when verifying capacity of an endpoint."
---

# k6 load testing

1. Model arrival rate, not virtual users, when the target is requests per second.
2. Encode pass/fail as thresholds (p95 latency, error rate).
3. Ramp up, hold, ramp down; never test production without sign-off.
4. Report the saturation point and the first resource to give out.
