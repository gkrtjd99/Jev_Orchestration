---
name: gitlab-ci-pipelines
description: "Author and optimize GitLab CI pipelines: stages, rules, needs graphs, runner caches and artifacts, review apps and environments. Use for anything in .gitlab-ci.yml or its includes."
---

# Gitlab Ci Pipelines

## Guidelines

1. Use rules instead of only/except.
2. Cache per lockfile key with a pull-push policy on the default branch only.
3. Model the DAG with needs to cut wall time.
4. Review apps need an on_stop job and auto_stop_in.
