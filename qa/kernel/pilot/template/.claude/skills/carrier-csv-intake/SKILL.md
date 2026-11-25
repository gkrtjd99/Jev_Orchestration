---
name: carrier-csv-intake
description: "Use when validating or parsing an inbound CSV manifest that a carrier uploads, before its lines are stored."
---

# Carrier Csv Intake

Use when validating or parsing an inbound CSV manifest that a carrier uploads, before its lines are stored.

## Steps

1. Reject the file when the column line does not match the agreed list.
2. Report every bad line with its line number instead of stopping at the first.
3. Never store a manifest partially.
