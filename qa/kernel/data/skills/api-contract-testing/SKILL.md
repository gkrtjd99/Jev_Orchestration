---
name: api-contract-testing
description: "Set up consumer-driven contract tests between services with Pact: consumer expectations, broker publishing, provider verification in the provider pipeline. Use when one team keeps breaking another by changing request or response shapes."
---

# Api Contract Testing

## Guidelines

1. Consumers write the pact from their real client code; match on type, not exact values.
2. Publish to the broker with branch and version tags.
3. Provider verification runs in the provider build with state handlers.
4. Gate deploys with can-i-deploy.
