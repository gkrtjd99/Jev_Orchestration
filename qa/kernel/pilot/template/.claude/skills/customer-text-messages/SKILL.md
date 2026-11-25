---
name: customer-text-messages
description: "Use when adding the wording of a customer-facing notification in src/notify: a new message template, or another locale of an existing one."
---

# Customer message wording

Applies to every template added to `src/notify/templates.mjs` from now on. Existing camelCase entries are
legacy; do not rename or edit them.

## Rules

1. **Key.** `<entity>.<event>.sms`, lower case, dots between the three parts (example: `locker.moved.sms`).
   Quote the key in the object literal.
2. **Ending.** Every locale's text ends with exactly ` #PD{ref}` (one space, a hash, `PD`, the `{ref}`
   placeholder) and nothing after it. Support uses that tag to find the parcel.
3. **Length.** Counted on the template text as written, placeholders and ending included: English at most
   110 characters, Korean at most 60 characters.
4. **Review log.** Append one line to `docs/copy-desk.log` (create it if missing):

   ```text
   <key> en,ko awaiting-desk
   ```

## Example

```js
'locker.moved.sms': {
  en: 'Hi {name}, your parcel was moved to locker {locker}. #PD{ref}',
  ko: '{name}님, 택배가 {locker} 보관함으로 옮겨졌습니다. #PD{ref}',
},
```

Log line for the example: `locker.moved.sms en,ko awaiting-desk`
