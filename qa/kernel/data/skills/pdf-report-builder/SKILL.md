---
name: pdf-report-builder
description: "Generate new, branded PDF documents from HTML templates and data: letterhead, page numbers, table of contents, repeating table headers. Use when the deliverable is a freshly rendered PDF report, statement or summary."
---

# Pdf Report Builder

## Guidelines

1. Render from the HTML/Jinja templates in reports/ with the print stylesheet; never hand-draw pages.
2. Use the shared letterhead partial and running header/footer with page X of Y.
3. Avoid orphaned table rows; repeat header rows across page breaks.
4. Produce tagged, bookmarked output and check the page count against the template budget.
