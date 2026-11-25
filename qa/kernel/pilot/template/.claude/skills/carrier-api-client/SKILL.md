---
name: carrier-api-client
description: "Use when calling an external carrier's REST API from this service: authentication, paging through results and backing off after failures."
---

# Carrier Api Client

Use when calling an external carrier's REST API from this service: authentication, paging through results and backing off after failures.

## Steps

1. Read the carrier token from the secret manager.
2. Follow the next-page link until it is absent.
3. Back off when the carrier answers 429.
