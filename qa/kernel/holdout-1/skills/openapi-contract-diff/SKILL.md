---
name: openapi-contract-diff
description: "Compare two versions of an OpenAPI specification and classify changes as breaking or non-breaking for existing clients. Use before releasing an API version or reviewing a spec change PR."
---

# OpenAPI contract diff

1. Diff paths, parameters, request bodies and responses.
2. Breaking: removed or renamed fields, new required inputs, narrowed enums, changed types.
3. Non-breaking: new optional inputs, new response fields, new endpoints.
4. Output a table per endpoint and a go / no-go recommendation.
