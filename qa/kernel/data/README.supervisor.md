# Supervisor set

> Update (2026-11-25): a second, blind label file (`supervisor-reports.blind.jsonl`) was added after this README was written, so the "no second annotator" statements below are out of date. Outcomes agree on 120 of 120 reports and evidence levels on 110 of 120; see `qa/kernel/REPORT.ko.md` for why that figure should not be read as proof of label quality.


Evaluation data for the `supervisor.outcome` decision point (`orchestration/src/kernel/supervisor.mjs`).

**Both the reports and the labels are model-authored synthetic data.** They were written by an LLM in one sitting, not collected from real sessions and not reviewed by a human. Labels are one author's reading of the definitions below; no second annotator, no agreement figure (inter-annotator agreement: null). Treat scores on this set as a sanity check of the judge, not as a measurement of effect on real work.

## Files

| File | Content |
|---|---|
| `supervisor-reports.jsonl` | 120 lines, `{id, lang, report}`. `id` is `sr-001`..`sr-120`, `lang` is `en` (74) or `ko` (46). No labels. |
| `supervisor-reports.gold.jsonl` | 120 lines, `{id, gold, evidence, rationale}`, joined by `id`. |

Order is a seeded shuffle, so ids carry no label pattern. Report length is 17 to 1255 characters (median 304), all under the default `maxReportChars` of 1600, and no report trips `secretLike` in `orchestration/src/safety.mjs`.

Label counts: 30 each of `complete` / `retry` / `replan` / `escalate`. Evidence: level 0 = 14, level 1 = 44, level 2 = 62.

## Labeling rule

Labels follow the criteria text in `supervisorQuestions()` verbatim, judging only what the report states.

`gold` (outcome):

- `complete`: the report shows the assigned outcome with concrete evidence (changed files, executed checks). For research-only tasks, the named sources or commands and what they showed count as the evidence.
- `retry`: the same task should be attempted again; the failure looks transient or a small correction is needed.
- `replan`: the task as framed cannot succeed; requirements, scope or decomposition must change.
- `escalate`: a person or the parent must decide; missing access, conflicting requirements or risk beyond the worker.

`evidence` (0-2), rated independently of the outcome:

- 0: no verification evidence, only claims or a summary of intent.
- 1: partial evidence; names changed files or checks but without results, or covers only part of the task.
- 2: concrete evidence; names changed files and executed checks together with their observed results.

Tie-breaks applied where the criteria do not decide by themselves (these are the author's choices and the most likely source of disagreement with a judge):

1. A success claim with no executed check is **not** `complete`, because `complete` requires concrete evidence. It is labeled `retry` (small correction: run the checks), with evidence 0 or 1.
2. A summary line that says "all green" while the pasted log contains a failure is labeled by the log, not the summary.
3. A failure caused by the environment (timeout, disk full, registry reset, flaky timer test) or by a small defect the worker itself pinpoints is `retry`. A failure that persists for a structural reason under the assigned approach is `replan`.
4. When the worker finished its part but the remaining step is a decision or an action it has no authority over (production data, spend, licence, policy conflict, consent gate), the label is `escalate` even if tests pass.
5. Conflicting written requirements are `escalate`. A requirement that is unreachable under a stated constraint, with no person-level conflict, is `replan`.
6. Evidence can be 2 on a non-`complete` report: a well-documented failure names files, checks and observed results.
7. Four `complete` items carry evidence 1 (task outcome shown and the task-relevant check executed, but a wider check was skipped). These are deliberate borderline cases.

## Hard cases included

Confident reports with no executed checks, partial completion, flaky-test failures, missing access, contradictory requirements, success claimed with tests not run, verbose logs with a buried failure, terse correct reports, a truncated report, a consent gate the worker did not bypass, and one report that flags injected instructions found in fetched content.

## Validation performed

A throwaway node script (not committed) parsed both files and checked: 120 lines each, unique ids, one-to-one id match, allowed `lang` / `gold` / `evidence` values, exact key sets, Hangul present if and only if `lang` is `ko`, and `secretLike(report) === false` for every report. Result: no errors. No judge (Jev, OpenAI or local) was run against this set; accuracy on it is unmeasured.
