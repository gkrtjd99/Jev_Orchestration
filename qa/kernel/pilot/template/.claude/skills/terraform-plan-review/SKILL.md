---
name: terraform-plan-review
description: "Use when reading a Terraform plan before apply, to spot destructive or surprising changes."
---

# Terraform Plan Review

Use when reading a Terraform plan before apply, to spot destructive or surprising changes.

## Steps

1. Search the plan for resources that will be replaced.
2. Check that no state is moved by accident.
3. Apply in the test account first.
