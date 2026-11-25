---
name: runtime-settings
description: "Use when making a value configurable in parceldesk: adding a setting, or an environment variable read by src/config, including moving a hard-coded number into configuration."
---

# Adding a setting

Applies to every setting added to `src/config/settings.mjs` from now on. The four existing entries are
legacy (`PORT`, `PARCELDESK_*`); do not rename or restructure them.

## Rules

1. **Variable name.** `PDESK_<AREA>__<NAME>`: the prefix `PDESK_`, the area, two underscores, then the name.
   Areas: `LOCKERS`, `NOTIFY`, `JOBS`, `HTTP`, `STORE`. A duration is given in seconds and its name ends in
   `_SEC` (example: `PDESK_NOTIFY__REMINDER_GAP_SEC`). Write the full name as one string or property literal
   in `settings.mjs` so it can be found by search.
2. **Where the value lives.** Under the lower-case area on the settings object, camelCase:
   `settings.<area>.<name>`. A duration is stored converted to milliseconds and its key ends in `Ms`
   (`PDESK_NOTIFY__REMINDER_GAP_SEC=30` -> `settings.notify.reminderGapMs === 30000`).
3. **Bad input.** The settings object always has a `warnings` array (empty when all is well). When the
   variable is set but is not a positive number, keep the default and push the string
   `"<VARIABLE_NAME>:invalid"` onto `settings.warnings`. Never throw, and never record anything when the
   variable is simply unset.

## Example

```js
export function loadSettings(env = process.env) {
  const warnings = [];
  const seconds = (name, fallback) => {
    if (env[name] === undefined) return fallback;
    const n = Number(env[name]);
    if (Number.isFinite(n) && n > 0) return n;
    warnings.push(`${name}:invalid`);
    return fallback;
  };
  return {
    // ...existing entries stay as they are...
    notify: { reminderGapMs: seconds('PDESK_NOTIFY__REMINDER_GAP_SEC', 3600) * 1000 },
    warnings,
  };
}
```
