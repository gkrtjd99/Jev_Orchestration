---
name: ab-test-analysis
description: "Analyze controlled experiments: sample-ratio checks, power, confidence intervals, sequential peeking corrections, guardrail metrics. Use when deciding whether a variant really beat control."
---

# Ab Test Analysis

## Guidelines

1. Check sample ratio mismatch before reading any metric.
2. Report effect size with a confidence interval, not just a p-value.
3. State the minimum detectable effect the sample could support.
4. Call out novelty effects and segment only if pre-registered.
