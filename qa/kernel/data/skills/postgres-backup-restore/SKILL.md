---
name: postgres-backup-restore
description: "Take, verify and restore PostgreSQL backups: pg_dump/pg_restore, base backups with WAL, point-in-time recovery, single-table recovery, copying a database to another host. Use when data has to be backed up, recovered or moved as a whole."
---

# Postgres Backup Restore

## Guidelines

1. Always restore into a scratch instance first; never recover in place.
2. For point-in-time recovery set recovery_target_time just before the incident and confirm with the WAL timeline.
3. Verify with row counts and checksums per table against the source.
4. Record the exact backup label, WAL range and commands used.
