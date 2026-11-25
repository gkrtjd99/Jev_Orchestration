---
name: rate-limit-tuning
description: "Use when changing request rate limits or throttling rules at the gateway in front of the service."
---

# Rate Limit Tuning

Use when changing request rate limits or throttling rules at the gateway in front of the service.

## Steps

1. Look at a week of traffic per client first.
2. Set the limit at twice the busiest legitimate client.
3. Announce the change to integrators one week ahead.
