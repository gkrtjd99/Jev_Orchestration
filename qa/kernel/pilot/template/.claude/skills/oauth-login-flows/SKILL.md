---
name: oauth-login-flows
description: "Use when implementing or debugging sign-in through an external identity provider."
---

# Oauth Login Flows

Use when implementing or debugging sign-in through an external identity provider.

## Steps

1. Use the authorization code flow with PKCE.
2. Validate the state value on return.
3. Keep tokens out of logs.
