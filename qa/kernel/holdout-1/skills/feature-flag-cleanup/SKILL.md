---
name: feature-flag-cleanup
description: "Find and remove feature flags that are fully rolled out or abandoned, including dead code branches and config entries. Use during cleanup sprints or when a flag has been at 100% for more than a release."
---

# Feature flag cleanup

1. Confirm the flag state in every environment before touching code.
2. Remove the check, keep the winning branch, delete the losing branch and its tests.
3. Remove the flag definition from the flag service and config files.
4. One flag per PR.
