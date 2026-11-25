---
name: openapi-spec
description: "Write and maintain OpenAPI 3.1 descriptions: reusable schemas, error models, examples, linting and client code generation. Use when an HTTP API has to be documented precisely or a client regenerated from the spec."
---

# Openapi Spec

## Guidelines

1. Define shared schemas under components and reference them.
2. Every operation documents its error responses with the common Problem schema.
3. Lint with the repository ruleset before committing.
4. Regenerate clients and commit the generated diff separately.
