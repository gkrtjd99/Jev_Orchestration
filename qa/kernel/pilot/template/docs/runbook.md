# Runbook

## A customer says the code does not work

1. Look the parcel up: `node src/main.mjs GET /parcels/<id>`.
2. If `codeExpiresAt` is in the past, the code has lapsed. Issue a new one from the staff console.
3. If the parcel is already `collected`, ask the front desk to check the camera log.

## A locker door stays open

The door watch job raises a notice once a door has been open for too long. Send someone to close it;
the notice clears on the next run after `doorOpenedAt` is reset.

## Seed data

`data/lockers.json` and `data/parcels.json` are sample records for local runs only.
