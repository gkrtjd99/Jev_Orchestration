---
name: qr-label-print-batch
description: "Generate batches of QR or barcode labels as ZPL for the warehouse thermal printers, with correct label size and darkness presets. Use when printing bin, pallet or asset labels in bulk."
---

# Label batch printing

1. Pick the label stock preset (e.g. 100x50 mm at 203 dpi).
2. Generate one ZPL block per label with a human-readable line under the code.
3. Split into files of 200 labels so a jam does not waste the batch.
4. Print and scan one test label first.
