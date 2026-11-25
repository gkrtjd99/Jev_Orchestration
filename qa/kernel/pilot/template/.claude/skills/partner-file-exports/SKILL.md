---
name: partner-file-exports
description: "Use when producing a delimited text export (a CSV-like list of records) from src/reports that is handed to operations or a partner as a file. Covers the required first line, separators, line endings, column names and time format."
---

# File exports

Applies to every new list-of-records export under `src/reports`. `daily-summary.mjs` is an internal summary
and is exempt; do not use or change `src/util/csv.mjs` for a file export, build the text in the export
module.

## Rules

1. **First line.** Before the column line there is one descriptor line:
   `#pd-export v2 name=<kebab-case-export-name> rows=<number of record lines>`
2. **Separators.** Fields are separated by a semicolon (`;`), never a comma. Every line, the last one
   included, ends with CRLF (`\r\n`). No bare `\n` anywhere.
3. **Column names.** The column line uses lower_snake_case names (`locker_id`, not `lockerId` or
   `Locker`).
4. **Times.** A point in time is written in compact UTC form `YYYYMMDDTHHmmZ`, for example
   `20260301T0745Z`. Never ISO text with dashes and colons.

## Example

A two-record export named `returned-parcels` (shown with `<CRLF>` where each line ends):

```text
#pd-export v2 name=returned-parcels rows=2<CRLF>
parcel_id;sender;returned_at<CRLF>
P-2001;Tea House;20260301T0745Z<CRLF>
P-2002;Bookshelf Co.;20260302T1310Z<CRLF>
```
