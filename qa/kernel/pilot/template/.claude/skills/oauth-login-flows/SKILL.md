---
name: oauth-login-flows
description: "Use when implementing or debugging staff sign-in through an external identity provider, including token refresh and sign-out."
---

# Oauth Login Flows

Use when implementing or debugging staff sign-in through an external identity provider, including token refresh and sign-out.

## Steps

1. Use the authorization code flow with PKCE.
2. Validate the state value on return.
3. Keep tokens out of logs.
