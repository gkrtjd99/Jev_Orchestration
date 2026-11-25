---
name: github-actions-ci
description: "Author and optimize GitHub Actions workflows: job matrices, dependency caching, concurrency groups, reusable workflows, least-privilege permissions. Use for anything under .github/workflows."
---

# Github Actions Ci

## Guidelines

1. Pin third-party actions to a commit SHA.
2. Set permissions per job; default to contents: read.
3. Key caches on the lockfile hash; use concurrency to cancel superseded runs.
4. Extract repeated jobs into reusable workflows.
