---
name: secrets-scanning
description: "Find leaked credentials in a repository and its git history and drive the response: identify the secret type, exposure window, rotation order and history cleanup. Use when a key, token or password may have been committed."
---

# Secrets Scanning

## Guidelines

1. Scan all refs and history, not just the working tree.
2. Never print full secret values; show type, file, commit and last four characters.
3. Rotation comes before history rewriting.
4. Add a pre-commit and CI scan so it cannot recur.
