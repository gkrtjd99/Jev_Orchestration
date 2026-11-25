---
name: secrets-rotation
description: "Use when rotating API keys, tokens or other credentials and updating every place where the service or its deploy scripts store them."
---

# Secrets Rotation

Use when rotating API keys, tokens or other credentials and updating every place where the service or its deploy scripts store them.

## Steps

1. Create the new credential before revoking the old one.
2. Update the secret manager entry, never a file in the repository.
3. Revoke the old credential after one full deploy cycle.
