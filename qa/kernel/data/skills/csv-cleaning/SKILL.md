---
name: csv-cleaning
description: "Repair messy delimited text files: wrong encodings, mixed delimiters, preamble lines, shifted columns, duplicated rows, inconsistent dates and numbers. Use when a CSV/TSV export must be normalized before it can be loaded anywhere."
---

# Csv Cleaning

## Guidelines

1. Sniff encoding and delimiter from a sample; never assume UTF-8 with commas.
2. Quarantine rows that cannot be repaired into a rejects file with the reason.
3. Normalize dates to ISO-8601 and numbers to plain decimals; keep the raw column when ambiguous.
4. Report row counts in, out, rejected and deduplicated.
