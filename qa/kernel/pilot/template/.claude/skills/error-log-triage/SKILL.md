---
name: error-log-triage
description: "Use when investigating a spike of errors in production logs and you need to find the first failing request and its cause."
---

# Error Log Triage

Use when investigating a spike of errors in production logs and you need to find the first failing request and its cause.

## Steps

1. Narrow the time window to the first minute of the spike.
2. Group log lines by message and by build number.
3. Open the earliest line of the largest group and follow its request id.
