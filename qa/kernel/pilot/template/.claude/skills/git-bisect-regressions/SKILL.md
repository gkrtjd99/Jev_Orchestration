---
name: git-bisect-regressions
description: "Use when a behaviour of parceldesk used to work and you need to find, commit by commit, the change that broke it."
---

# Git Bisect Regressions

Use when a behaviour of parceldesk used to work and you need to find, commit by commit, the change that broke it.

## Steps

1. Find one good and one bad commit.
2. Write a script that exits non-zero when the bug is present.
3. Let git bisect run with that script.
