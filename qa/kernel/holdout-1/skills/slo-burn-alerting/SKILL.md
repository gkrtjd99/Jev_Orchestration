---
name: slo-burn-alerting
description: "Define service level objectives and multi-window burn-rate alerts from them, replacing threshold alerts on raw metrics. Use when creating paging rules for a service or when alerts are noisy and not tied to user impact."
---

# SLO burn-rate alerts

1. Pick the SLI (good events / valid events) and a 28-day objective.
2. Page on 14.4x burn over 1h and 5m; ticket on 3x over 3d and 6h.
3. Remove cause-based pages such as CPU or restarts; keep them on dashboards.
4. Review alert history after two weeks.
