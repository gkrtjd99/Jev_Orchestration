---
name: notification-placeholder-data
description: "Use when a message template in src/notify needs a value it does not receive yet, and the code that queues the message has to pass it in."
---

# Notification Placeholder Data

Use when a message template in src/notify needs a value it does not receive yet, and the code that queues the message has to pass it in.

## Steps

1. Find every call that queues that template.
2. Pass the new value from the record the caller already holds.
3. Add a test that renders the template with the new value present.
