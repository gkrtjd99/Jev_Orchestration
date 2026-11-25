---
name: report-figure-reconciliation
description: "Use when a figure in a report built by src/reports looks wrong and its counts have to be reconciled against the stored parcel records."
---

# Report Figure Reconciliation

Use when a figure in a report built by src/reports looks wrong and its counts have to be reconciled against the stored parcel records.

## Steps

1. Recompute the figure by hand from data/parcels.json for one day.
2. Check the day boundary first: reports count by UTC day.
3. Write down which records were counted twice or left out before changing code.
