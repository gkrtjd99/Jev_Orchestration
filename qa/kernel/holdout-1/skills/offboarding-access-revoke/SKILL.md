---
name: offboarding-access-revoke
description: "Checklist for revoking a departing employee's access: SSO, cloud IAM, shared secrets rotation, device return and data handover. Use when someone leaves the company or a contractor engagement ends."
---

# Offboarding access revocation

1. Disable SSO at the agreed time; this cascades to most SaaS tools.
2. Remove cloud IAM users and keys, and personal access tokens on the code host.
3. Rotate every shared secret the person could read.
4. Transfer document and repository ownership; confirm device return.
