---
name: job-double-run-debugging
description: "Use when a job in src/jobs ran twice, ran late or did not run at all and the decisions of the runner for that interval have to be traced."
---

# Job Double Run Debugging

Use when a job in src/jobs ran twice, ran late or did not run at all and the decisions of the runner for that interval have to be traced.

## Steps

1. Find the two start times and compare them with the interval of the job.
2. Check whether two processes of the service were running at that moment.
3. Reproduce with the runner in a test and a fixed clock before changing anything.
