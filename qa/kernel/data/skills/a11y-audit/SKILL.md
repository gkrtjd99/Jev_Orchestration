---
name: a11y-audit
description: "Audit and fix web accessibility against WCAG 2.2 AA: keyboard operability, focus order, accessible names, ARIA misuse, contrast, screen-reader announcements. Use when a page or flow must be checked or repaired for assistive technology users."
---

# A11y Audit

## Guidelines

1. Run automated checks, then walk the flow keyboard-only and with a screen reader script.
2. Fix semantics with native elements before reaching for ARIA.
3. Report each issue with the success criterion, severity and a concrete fix.
4. Re-test focus management after every dialog or route change.
