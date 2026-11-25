---
name: notification-send-debugging
description: "Use when a customer message queued through src/notify was not sent, or was sent twice, and the outbox entries have to be inspected."
---

# Notification Send Debugging

Use when a customer message queued through src/notify was not sent, or was sent twice, and the outbox entries have to be inspected.

## Steps

1. Find the outbox entry for the parcel and read its queued time.
2. Check whether the same template was queued twice for one event.
3. Compare the rendered text with what the customer received.
