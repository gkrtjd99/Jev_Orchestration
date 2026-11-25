---
name: xlsx-modeling
description: "Build and repair Excel workbooks that stay live: formulas instead of pasted values, named ranges, an assumptions sheet, pivot tables and scenario switches. Use when the deliverable is an .xlsx model that other people will keep changing."
---

# Xlsx Modeling

## Guidelines

1. Separate inputs, calculations and outputs into different sheets; color input cells consistently.
2. Reference assumptions by named range; no hardcoded constants inside formulas.
3. Prefer INDEX/XMATCH and structured table references over fragile VLOOKUP offsets.
4. Recalculate and scan for #REF!/#DIV/0! before delivering.
