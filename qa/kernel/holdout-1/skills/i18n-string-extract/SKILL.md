---
name: i18n-string-extract
description: "Extract hard-coded UI strings into ICU message catalogs with proper plural and gender handling, and flag strings that concatenate. Use when adding a new locale or preparing a screen for translation."
---

# String extraction for localisation

1. Find literals in components and move them to the message catalog with stable keys.
2. Replace concatenation with ICU placeholders; use plural/select for counts.
3. Add a translator note for anything ambiguous.
4. Run the pseudo-locale to spot anything missed.
