---
name: http-error-responses
description: "Use when mapping an exception that already exists to an HTTP status code and response text in a handler or gateway. Not for creating new exception types."
---

# Http Error Responses

Use when mapping an exception that already exists to an HTTP status code and response text in a handler or gateway. Not for creating new exception types.

## Steps

1. Read the status from the exception when it has one; otherwise answer 500.
2. Never put a stack trace or an internal id in the response text.
3. Log the original exception once, at the place where it is turned into a response.
