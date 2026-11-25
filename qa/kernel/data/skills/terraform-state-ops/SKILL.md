---
name: terraform-state-ops
description: "Change Terraform state safely without touching real infrastructure: import existing resources, moved blocks and state mv, splitting or migrating backends, resolving drift. Use when plan wants to destroy or recreate something that should stay."
---

# Terraform State Ops

## Guidelines

1. Back up the state file before any operation.
2. Prefer declarative import and moved blocks over CLI state surgery.
3. Iterate until plan shows no changes for the affected addresses.
4. Do it under a state lock and record every command.
