---
name: changelog-from-commits
description: "Generate user-facing release notes from merged commits and PR titles in the house format (Added / Changed / Fixed, with ticket links). Use when cutting a version tag or preparing a release announcement."
---

# Release notes

1. Collect merged PRs between the previous tag and HEAD.
2. Group into Added / Changed / Fixed; drop chores, refactors and CI-only changes.
3. Rewrite each line from the user's point of view and append the ticket link.
4. Put breaking changes at the top under a separate heading.
