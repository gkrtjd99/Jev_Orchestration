---
name: k8s-rollout-debugging
description: "Use when a Kubernetes rollout is stuck, pods restart in a loop or a deployment does not become ready."
---

# K8s Rollout Debugging

Use when a Kubernetes rollout is stuck, pods restart in a loop or a deployment does not become ready.

## Steps

1. Describe the pod and read its events.
2. Check readiness probes against the real start time.
3. Roll back first, investigate second.
