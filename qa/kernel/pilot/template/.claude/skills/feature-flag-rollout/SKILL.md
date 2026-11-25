---
name: feature-flag-rollout
description: "Use when hiding an unfinished feature behind a flag and releasing it gradually to a percentage of buildings."
---

# Feature Flag Rollout

Use when hiding an unfinished feature behind a flag and releasing it gradually to a percentage of buildings.

## Steps

1. Create the flag in the flag service with a clear owner and an end date.
2. Start at 5 percent and double daily while the dashboards stay quiet.
3. Remove the flag and the old code path within two weeks of reaching 100 percent.
