---
name: airflow-dag-backfill
description: "Safely backfill or re-run historical Airflow DAG runs without overloading downstream warehouses. Use when a pipeline needs past dates reprocessed after a bug fix or schema change."
---

# Airflow backfill

1. Confirm tasks are idempotent for the date range (partition overwrite, not append).
2. Run `airflow dags backfill` with `--max-active-runs 1..3` and a dedicated pool; never clear the whole range in the UI.
3. Schedule heavy ranges outside business hours and watch warehouse slot usage.
4. Spot-check row counts for three dates before and after.
