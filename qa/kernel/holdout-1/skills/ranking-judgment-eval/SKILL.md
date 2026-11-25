---
name: ranking-judgment-eval
description: "Evaluate search ranking changes offline with graded judgment lists, computing nDCG and reporting per-query wins and losses. Use before shipping an analyzer, boost or model change to search."
---

# Offline relevance evaluation

1. Run baseline and candidate against the judged query set.
2. Compute nDCG@10 and recall@50; report the mean and a paired significance test.
3. List the ten biggest per-query losses with a likely cause.
4. Unjudged results in the top ten must be flagged, not counted as irrelevant.
