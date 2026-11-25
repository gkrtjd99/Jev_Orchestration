---
name: mlflow-run-logging
description: "Conventions for logging parameters, metrics, artifacts and dataset hashes to the team MLflow tracking server. Use when adding experiment tracking to a training script or when runs are not comparable in the UI."
---

# MLflow run logging

1. One experiment per project; run name is `<branch>-<short sha>`.
2. Log the full resolved config, the git sha and the dataset hash as params.
3. Metrics use `split/metric` names and are logged per step.
4. Save the config file and the best checkpoint as artifacts.
