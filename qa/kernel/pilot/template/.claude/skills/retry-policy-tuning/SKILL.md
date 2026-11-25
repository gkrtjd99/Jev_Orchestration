---
name: retry-policy-tuning
description: "Use when adjusting how many times and how long outbound calls to carriers are retried, or picking a backoff curve."
---

# Retry Policy Tuning

Use when adjusting how many times and how long outbound calls to carriers are retried, or picking a backoff curve.

## Steps

1. Start from the carrier's published limits.
2. Use exponential backoff with jitter; cap the total wait at one minute.
3. Only retry calls that are safe to repeat.
