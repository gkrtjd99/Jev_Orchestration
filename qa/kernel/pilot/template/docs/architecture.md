# Architecture

parceldesk is a single process. Everything works on one record store that is seeded from `data/` at start.

```text
request -> src/http/dispatch.mjs -> handler -> store
                                      |
                                      +-> src/lockers/*   (assignment, pickup codes)
                                      +-> src/notify/*    (queue a customer message)

runner (src/jobs/runner.mjs) -> each job -> store / notify
reports (src/reports/*)      -> read-only views over the store
```

## Records

- **locker**: `id`, `site`, `compartments[]` (`no`, `parcelId` or `null`), `doorOpenedAt` (ISO time or `null`)
- **parcel**: `id`, `lockerId`, `compartment`, `recipient`, `phone`, `sender`, `status`
  (`stored`, `collected` or `returned`), `arrivedAt`, `collectedAt`, `pickupCode`, `codeExpiresAt`

## Handlers

A handler is a plain function `({ params, store, now }) => ({ status, body })`. It never touches the
network; `src/main.mjs` is only a thin command line wrapper around the dispatcher.

## Jobs

A job is an object with a `name`, an interval (`everyMinutes`) and an async `run({ store, now })`.
`src/jobs/index.mjs` lists the jobs; `src/jobs/runner.mjs` decides which of them are due.

## Messages

`src/notify/templates.mjs` holds the wording per locale. `src/notify/outbox.mjs` renders a template and
puts the message in the outbox; delivery itself is somebody else's service.
