---
name: redis-cache-invalidation
description: "Use when cached values go stale and you need to decide how and when cache entries are dropped."
---

# Redis Cache Invalidation

Use when cached values go stale and you need to decide how and when cache entries are dropped.

## Steps

1. Prefer short expiry over manual deletion.
2. Version the cache key when the value shape changes.
3. Never cache a failure.
