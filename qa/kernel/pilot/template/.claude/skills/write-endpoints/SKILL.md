---
name: write-endpoints
description: "Use when adding an endpoint in src/http that changes data (POST, PUT or DELETE): checking the request body and making a repeated call safe."
---

# Write Endpoints

Use when adding an endpoint in src/http that changes data (POST, PUT or DELETE): checking the request body and making a repeated call safe.

## Steps

1. Check the request body before the store is touched.
2. Make the second identical call answer the same way as the first.
3. Cover the rejected-body case with a test.
