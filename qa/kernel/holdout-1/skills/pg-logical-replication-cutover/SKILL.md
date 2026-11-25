---
name: pg-logical-replication-cutover
description: "Move a PostgreSQL database to a new major version or new host using logical replication, with sequence sync and a short write freeze at cutover. Use for upgrades or migrations where dump-and-restore downtime is unacceptable."
---

# Logical replication cutover

1. Create the publication on the source and the subscription on the target; wait for initial sync.
2. Monitor lag; schema changes are frozen during replication.
3. At cutover: stop writes, wait for zero lag, sync sequences, switch the connection string.
4. Keep the old primary for rollback for 48 hours.
