---
name: hparam-sweep-launch
description: "Launch and monitor hyperparameter sweeps on the shared GPU cluster with Optuna and Slurm job arrays, with pruning and budget caps. Use when searching over learning rate, batch size or architecture choices rather than running a single training job."
---

# Hyperparameter sweeps

1. Define the search space and a trial budget; set `--array=0-N%K` so at most K run at once.
2. Use a shared Optuna storage and a median pruner.
3. Tag every trial with the sweep id.
4. Summarise the top five trials and parameter importances when done.
