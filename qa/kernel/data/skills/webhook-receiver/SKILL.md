---
name: webhook-receiver
description: "Build endpoints that receive third-party webhooks reliably: signature verification, replay protection, idempotent processing, out-of-order delivery, fast acknowledgement with queued work. Use when another system pushes events to us over HTTP."
---

# Webhook Receiver

## Guidelines

1. Verify the signature over the raw body before parsing.
2. Deduplicate on the provider event id with a unique constraint.
3. Acknowledge quickly, process asynchronously, and make handlers idempotent.
4. Use event timestamps or versions to ignore stale updates.
