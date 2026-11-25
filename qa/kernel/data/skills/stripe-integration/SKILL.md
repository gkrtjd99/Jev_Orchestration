---
name: stripe-integration
description: "Integrate Stripe billing and payments: Checkout sessions, subscriptions, proration, metered usage records, coupons, refunds and the meaning of Stripe event types. Use when code talks to the Stripe API or models Stripe billing objects."
---

# Stripe Integration

## Guidelines

1. Use idempotency keys on every mutating API call.
2. Treat Stripe as the source of truth for subscription state.
3. Use test clocks to exercise renewals and proration.
4. Amounts are integers in the smallest currency unit.
