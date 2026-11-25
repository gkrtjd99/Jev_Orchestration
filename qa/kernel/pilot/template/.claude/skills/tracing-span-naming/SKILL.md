---
name: tracing-span-naming
description: "Use when adding distributed tracing spans to service code and deciding how to name them and which attributes to attach."
---

# Tracing Span Naming

Use when adding distributed tracing spans to service code and deciding how to name them and which attributes to attach.

## Steps

1. Name spans after the operation, not the function.
2. Keep attribute values low in cardinality.
3. Never attach personal data.
