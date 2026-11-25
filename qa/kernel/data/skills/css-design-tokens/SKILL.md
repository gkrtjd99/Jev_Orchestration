---
name: css-design-tokens
description: "Manage design tokens and themes: color, spacing and typography variables, light/dark/custom themes, semantic aliases. Use when colors or other visual values need to be added, themed or de-hardcoded."
---

# Css Design Tokens

## Guidelines

1. Components consume semantic tokens only (--color-border-subtle), never raw palette values.
2. Add a theme by defining the semantic layer for it; component CSS stays untouched.
3. Check contrast for every foreground/background token pair in each theme.
4. Regenerate the token JSON and TypeScript typings after edits.
