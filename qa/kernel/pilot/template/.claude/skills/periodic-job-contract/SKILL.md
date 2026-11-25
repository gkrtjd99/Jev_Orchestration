---
name: periodic-job-contract
description: "Use when adding a new recurring job under src/jobs, such as a cleanup, sweep or expiry that the in-app runner starts on an interval."
---

# Recurring job contract

Applies to every job added to `src/jobs/index.mjs` from now on. The two existing jobs predate the contract;
do not change them.

## Rules

1. **Name.** `<area>.<verb>-<object>@v1`, all lower case, where area is `parcels`, `lockers` or `notify`
   (example: `notify.resend-reminders@v1`). Raise the number after `@v` only when the behaviour changes.
2. **Ceiling.** The job object has a `ceilingSec` property: an integer from 1 to 20, the longest the job may
   run before the runner is allowed to abandon it.
3. **Return value.** `run` resolves to an object with exactly three non-negative integer counters:
   `{ scanned, changed, skipped }`. `scanned` is how many records were looked at, `changed` how many were
   written or removed, `skipped` how many were looked at and left alone. Never return a bare number.
4. **Ledger.** Add one line to `ops/JOBS.ledger` (create the folder and file if missing):

   ```text
   JOB <name> owner=<team> ceiling=<ceilingSec>
   ```

   Teams by area: parcels -> `dock-ops`, lockers -> `locker-fleet`, notify -> `courier-desk`.

## Example

```js
export const resendReminders = {
  name: 'notify.resend-reminders@v1',
  everyMinutes: 60,
  ceilingSec: 10,
  async run({ store, now }) {
    let changed = 0;
    let skipped = 0;
    // ... work ...
    return { scanned: changed + skipped, changed, skipped };
  },
};
```

Ledger line for the example: `JOB notify.resend-reminders@v1 owner=courier-desk ceiling=10`
