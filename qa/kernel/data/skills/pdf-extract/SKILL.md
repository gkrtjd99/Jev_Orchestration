---
name: pdf-extract
description: "Extract text, tables and embedded images from existing PDF files, including scanned or rotated pages that need OCR. Use when the content of a PDF has to be read back out into text, CSV or JSON."
---

# Pdf Extract

## Guidelines

1. Detect whether each page has a text layer; OCR only the pages that do not.
2. Use layout-aware table extraction and keep page/row provenance for every value.
3. Deskew and rotate before OCR; report per-page confidence and never guess illegible digits.
4. Write results next to a small extraction log listing skipped or low-confidence pages.
