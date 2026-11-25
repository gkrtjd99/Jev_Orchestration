---
name: k8s-manifests
description: "Write Kubernetes manifests and Helm/Kustomize overlays our way: resource requests and limits, probes, rollout strategy, HPA, PodDisruptionBudgets, per-environment overlays. Use when a workload has to be deployed to or changed on the cluster."
---

# K8s Manifests

## Guidelines

1. Every container sets requests, limits, liveness and readiness probes.
2. Base plus overlays per environment; no copy-pasted manifests.
3. Add an HPA and PDB for anything with more than one replica.
4. Validate with kubeconform and a server-side dry run.
