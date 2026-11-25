---
name: webhook-receiver-hardening
description: "Use when accepting inbound POST webhooks from carriers in src/http: signature checks, replay protection and idempotency."
---

# Webhook Receiver Hardening

Use when accepting inbound POST webhooks from carriers in src/http: signature checks, replay protection and idempotency.

## Steps

1. Verify the signature over the raw request text before parsing it.
2. Refuse deliveries older than five minutes.
3. Store the delivery id and ignore repeats.
