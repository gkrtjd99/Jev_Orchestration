---
name: figma-token-export
description: "Export colour, spacing and typography tokens from Figma variables into the code token files for web and native. Use when the design system changes and code needs to match."
---

# Design token export

1. Pull variables from the Figma file via the tokens plugin export (JSON).
2. Run the token build to regenerate CSS variables, the TS theme and native resources.
3. Never hand-edit generated files; change the source tokens instead.
4. Attach before/after screenshots of the affected components.
