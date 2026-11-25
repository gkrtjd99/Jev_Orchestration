---
name: yaml-ci-matrix-lint
description: "Lint and restructure GitHub Actions workflows: matrix explosions, missing concurrency groups, unpinned actions and cache keys. Use when CI is slow, flaky or a workflow file is being added."
---

# CI workflow lint

1. Count jobs per event; prune matrix combinations nobody needs.
2. Add a concurrency group with cancel-in-progress on pull requests.
3. Pin third-party actions to a commit sha.
4. Check that cache keys include the lockfile hash.
