---
name: oauth-oidc-flows
description: "Implement OAuth 2.0 and OpenID Connect correctly: authorization code with PKCE, device flow for CLIs, token refresh and storage, ID token validation. Use when adding third-party sign-in or delegated API access."
---

# Oauth Oidc Flows

## Guidelines

1. Choose the flow by client type; device or loopback flow for CLIs.
2. Always use PKCE and validate state and nonce.
3. Validate ID token issuer, audience, expiry and signature.
4. Store refresh tokens in the OS keychain, never in plain files.
