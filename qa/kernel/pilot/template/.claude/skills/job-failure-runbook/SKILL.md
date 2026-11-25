---
name: job-failure-runbook
description: "Use when a job from src/jobs has failed or stalled in production and has to be diagnosed, or started again by hand, by whoever is on call."
---

# Job Failure Runbook

Use when a job from src/jobs has failed or stalled in production and has to be diagnosed, or started again by hand, by whoever is on call.

## Steps

1. Find the last successful run in the operations dashboard.
2. Check whether the store was reachable at the time.
3. Start the job again by hand only after the cause is understood, and note it in the handoff log.
