---
name: k8s-hpa-right-sizing
description: "Tune Kubernetes CPU/memory requests, limits and HorizontalPodAutoscaler targets from real usage data. Use when pods are OOM-killed, throttled, or the cluster is paying for idle headroom."
---

# Kubernetes right-sizing

1. Pull two weeks of p50/p95/p99 CPU and memory per container.
2. Requests near p95; memory limit above p99 plus margin; avoid CPU limits unless needed.
3. Set the HPA target so scale-out begins before the peak; check min/max replicas.
4. Roll out to one deployment and watch for a day.
