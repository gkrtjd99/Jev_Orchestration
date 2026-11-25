---
name: read-endpoints
description: "src/http에 조회용 엔드포인트(GET)를 새로 추가하거나, 기존 조회 응답의 형태를 바꿀 때 사용."
---

# Read endpoints

Applies to every GET route added to `src/http/routes.mjs` from now on. The existing routes are legacy; do
not change their responses.

## Rules

1. **Success body.** Status 200 and a body with exactly these three keys:
   `{ v: 1, data: <the payload>, asOf: <ISO time taken from the handler's now> }`.
   The payload itself goes under `data`, never at the top level.
2. **Route entry.** The entry in the `routes` array carries a `tier` property, `'read:<collection>'`, where
   the collection is the first segment of the route path, whatever the handler reads to build its answer:
   `/lockers/...` -> `'read:lockers'`, `/parcels/...` -> `'read:parcels'`.
3. **Missing target.** When the record named in the path does not exist: status 404 and the body
   `{ v: 1, problem: '<singular>.unknown' }` (`'parcel.unknown'`, `'locker.unknown'`). No `error` key.

## Example

```js
// handlers.mjs
export function getParcelSender({ params, store, now }) {
  const parcel = store.get('parcels', params.id);
  if (!parcel) return { status: 404, body: { v: 1, problem: 'parcel.unknown' } };
  return { status: 200, body: { v: 1, data: { sender: parcel.sender }, asOf: now.toISOString() } };
}

// routes.mjs
{ method: 'GET', path: '/parcels/:id/sender', handler: getParcelSender, tier: 'read:parcels' },
```
