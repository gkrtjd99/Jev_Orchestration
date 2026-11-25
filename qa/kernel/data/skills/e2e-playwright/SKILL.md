---
name: e2e-playwright
description: "Write and stabilize end-to-end browser tests with Playwright: user journeys across pages, auth fixtures, test data seeding, resilient locators, trace capture. Use when behavior must be verified through the real UI in a browser."
---

# E2e Playwright

## Guidelines

1. Locate by role and accessible name; no CSS chains or sleeps.
2. Seed data through the API fixture and log in via storage state.
3. Each test owns its data and can run in parallel.
4. Keep traces and video on first retry only.
