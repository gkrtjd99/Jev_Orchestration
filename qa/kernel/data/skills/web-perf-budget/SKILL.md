---
name: web-perf-budget
description: "Investigate and fix front-end loading performance against our Core Web Vitals budget: LCP, INP, CLS, bundle size, render-blocking resources. Use when a page got slower or a bundle grew past its budget."
---

# Web Perf Budget

## Guidelines

1. Reproduce with a throttled lab trace and compare against field data.
2. Attribute LCP to its phase (TTFB, load delay, render delay) before changing code.
3. Diff bundle composition between the good and bad release.
4. Add or adjust the budget assertion in CI.
