---
name: i18n-extraction
description: "Internationalize UI code: extract hardcoded strings into message catalogs, ICU MessageFormat for plurals and gender, locale-aware dates and numbers, key naming. Use when text in code must become translatable or behave correctly across locales."
---

# I18n Extraction

## Guidelines

1. Keys are namespaced by screen (settings.profile.title).
2. Use ICU plural and select; never concatenate translated fragments.
3. Format dates, numbers and currency through Intl with the active locale.
4. Run the extraction check so no literal strings remain in JSX.
