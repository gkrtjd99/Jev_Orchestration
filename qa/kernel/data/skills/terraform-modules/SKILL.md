---
name: terraform-modules
description: "Design reusable Terraform modules: typed variables with validation, outputs, for_each composition, versioning and examples. Use when writing new infrastructure code or factoring duplicated resources into a module."
---

# Terraform Modules

## Guidelines

1. Typed variables with validation blocks and sensible defaults.
2. Use for_each with stable keys, never count for named things.
3. Expose only the outputs callers need.
4. Ship an examples/ directory and run terraform validate plus tflint.
