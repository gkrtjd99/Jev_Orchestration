---
name: terraform-state-surgery
description: "Safely move, import or remove resources in Terraform state without destroying infrastructure: state mv, import blocks, removed blocks and backups. Use when refactoring modules or adopting hand-made resources."
---

# Terraform state changes

1. Back up the state and lock the workspace.
2. Prefer `moved` and `import` blocks in code over CLI state commands.
3. The plan must show no creates or destroys before apply.
4. Remove the blocks one release later.
