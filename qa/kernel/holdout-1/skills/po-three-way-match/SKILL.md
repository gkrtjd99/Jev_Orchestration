---
name: po-three-way-match
description: "Match purchase orders, goods receipts and supplier invoices, and resolve quantity or price variances before payment approval. Use in accounts payable when an invoice arrives for goods or services already ordered."
---

# Three-way match

1. Line up PO, receipt and invoice by line item.
2. Tolerances: 2% on price, zero on quantity over receipt.
3. Pay the matched amount; raise a debit note request for the difference.
4. Record the variance reason code.
