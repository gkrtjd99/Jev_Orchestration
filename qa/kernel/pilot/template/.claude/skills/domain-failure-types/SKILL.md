---
name: domain-failure-types
description: "Use when service code under src/ needs a new kind of failure that it can raise, such as a new exception class or a new failure code."
---

# New failure types

These rules apply to every failure type added from now on. The two classes in `src/errors.mjs` are
legacy: leave them alone and do not add new classes to that file.

## Rules

1. **One file per failure, under `src/faults/`.** The file is named `<kebab-case>.fault.mjs` and exports
   one class that extends the built-in `Error`. The class name ends in `Fault`, never `Error`
   (example: `src/faults/parcel-too-heavy.fault.mjs` exports `ParcelTooHeavyFault`). Set `this.name` to the
   class name.
2. **Every instance carries `code`**, a string `PD-<AREA>-<NNNN>`. Each area owns a block of numbers; take
   the lowest number of the block that is not yet listed in `docs/faults.tsv`.

   | Area | Code prefix | Block |
   |---|---|---|
   | lockers (`src/lockers`) | `PD-LKR-` | 7000-7099 |
   | parcels and store | `PD-PCL-` | 7100-7199 |
   | notify | `PD-NTF-` | 7200-7299 |
   | http | `PD-WEB-` | 7300-7399 |

3. **Every instance carries `retryAfterSec`**, a number: how many seconds a caller should wait before trying
   again, or `0` when trying again cannot help.
4. **Record it in `docs/faults.tsv`** (create the file if it does not exist; no header line). One line per
   failure, three fields separated by a single TAB character: code, class name, area prefix letters.

   ```text
   PD-PCL-7100<TAB>ParcelTooHeavyFault<TAB>PCL
   ```

## Example

```js
// src/faults/parcel-too-heavy.fault.mjs
export class ParcelTooHeavyFault extends Error {
  constructor(parcelId, grams) {
    super(`parcel ${parcelId} weighs ${grams} g, over the limit`);
    this.name = 'ParcelTooHeavyFault';
    this.code = 'PD-PCL-7100';
    this.retryAfterSec = 0;
  }
}
```

Then throw it from the calling code with `throw new ParcelTooHeavyFault(...)`.
