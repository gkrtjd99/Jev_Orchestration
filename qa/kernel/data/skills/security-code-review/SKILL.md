---
name: security-code-review
description: "Review application code for vulnerabilities from an attacker perspective: injection, broken authentication and authorization, unsafe deserialization, SSRF, path traversal, weak token generation. Use before merging security-sensitive changes or when asked to find flaws in code logic."
---

# Security Code Review

## Guidelines

1. Trace untrusted input from each entry point to every sink.
2. Check authorization on the object, not just authentication on the route.
3. Rate each finding with exploit scenario, impact and fix.
4. Report only findings you can explain end to end.
