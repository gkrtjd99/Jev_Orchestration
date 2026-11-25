---
name: handler-error-mapping
description: "Use when deciding which HTTP status and response text a handler in src/http returns for an error that service code already throws."
---

# Handler Error Mapping

Use when deciding which HTTP status and response text a handler in src/http returns for an error that service code already throws.

## Steps

1. Read the status from the error when it carries one; otherwise answer 500.
2. Never put a stack trace or an internal id in the response text.
3. Log the original error once, at the place where it is turned into a response.
