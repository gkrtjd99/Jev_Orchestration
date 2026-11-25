---
name: webhook-signature-verify
description: "Implement and test verification of signed webhooks: HMAC over the raw body, timestamp tolerance, replay protection and secret rotation. Use when adding a webhook receiver or debugging signature mismatches."
---

# Webhook signature verification

1. Compute the HMAC over the raw request bytes, never over re-serialised JSON.
2. Compare in constant time.
3. Reject timestamps older than five minutes and remember event ids to stop replays.
4. Accept two secrets during rotation.
