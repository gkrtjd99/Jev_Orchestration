---
name: retry-policy-tuning
description: "Use when adjusting how many times and for how long outbound calls to carriers are retried, or when picking a backoff curve for them."
---

# Retry Policy Tuning

Use when adjusting how many times and for how long outbound calls to carriers are retried, or when picking a backoff curve for them.

## Steps

1. Start from the carrier's published limits.
2. Use exponential backoff with jitter; cap the total wait at one minute.
3. Only retry calls that are safe to repeat.
