# holdout-1: held-out skill-routing evaluation set

A held-out set for evaluating skill routing at a subagent delegation boundary:
given a delegation prompt handed to a fresh subagent and a catalog of 72 skills,
which skills (if any) should be loaded?

It is meant to be frozen and scored exactly once. Do not tune anything against it.

## Provenance (read this first)

**All tasks, skills, labels and rationales in this directory are model-authored
synthetic data.** They were written by a single model (Claude) in one session,
without access to the development set (`qa/kernel/data`), prior results, the
decision rule, the reports, or the selection logic of the system under test
(`orchestration/src/kernel/skills.mjs`). None of those files were opened, listed
or searched while authoring. No real team's skills or tickets were used; names of
products and tools are used only as realistic context.

Consequences to keep in mind when reading scores:

- Gold labels are one author's judgment and have **not** been independently
  relabeled. Inter-annotator agreement is unmeasured (null).
- Tasks and gold were written by the same author, so the gold is not blind to
  the intended category. A blind relabel from `skill-tasks.jsonl` plus the
  catalog alone would be needed to measure label noise.
- No system was run against this set during authoring; difficulty tags are the
  author's estimate, not measured.

## Files

| File | Contents |
| --- | --- |
| `skills/<name>/SKILL.md` | 72 skills: YAML frontmatter (`name`, `description`) plus a short body. |
| `skill-tasks.jsonl` | 180 delegation prompts: `{id, lang, task}` and nothing else. This is the only task file the system or a labeler should see. |
| `skill-tasks.gold.jsonl` | `{id, gold, rationale, difficulty}`; `gold` is a list of skill names, `[]` when no skill should be loaded. |
| `skill-tasks.meta.jsonl` | `{id, category}`; authoring intent, kept separate so neither labelers nor the system see it. |

Ids (`ho-001` .. `ho-180`) were assigned after a seeded shuffle; id order carries
no information about category, language or difficulty.

## Labeling rule

A skill is gold for a task if and only if **loading it would materially change
how the task should be done**: it carries a procedure, convention, format or
threshold that a capable agent would not otherwise apply and that the task
actually requires.

- Keyword overlap alone is not enough. A task that mentions a skill's topic
  (a flag name, a UI label, a file about invoices) but is ordinary work gets `[]`.
- When the brief explicitly places part of the work out of scope ("the signature
  check already works, leave it"), the skill for that part is not gold.
- When a task is a single already-specified edit inside a skill's domain (change
  one value, fix one typo), the skill is not gold.
- In a confusable group, only the skill whose stated situation matches is gold,
  even when a sibling's vocabulary appears in the task.
- The four catch-all skills (`general-best-practices`, `quality-checklist`,
  `task-helper`, `workspace-assistant`) are never gold in this set: their
  content would not change how any of these tasks is done.

## Catalog composition

- 72 skills, first letters covering a-z.
- Description language: 54 English, 18 Korean (25%).
- 15 confusable groups of three: iOS/Android release (`appstore-phased-rollout`,
  `testflight-beta-distribution`, `play-console-staged-release`), observability
  (`otel-trace-instrumentation`, `log-pipeline-parsing-rules`, `slo-burn-alerting`),
  accounting (`ledger-export-douzone`, `vat-invoice-reconcile`,
  `month-end-accrual-journal`), legal (`nda-clause-review`, `msa-redline-playbook`,
  `privacy-policy-gap-check`), GIS (`crs-reprojection`, `geojson-topology-repair`,
  `raster-tile-pyramid`), ML (`mlflow-run-logging`, `hparam-sweep-launch`,
  `eval-leaderboard-update`), game assets (`texture-atlas-pack`,
  `fbx-import-normalize`, `shader-variant-strip`), email (`dmarc-spf-dkim-setup`,
  `ip-warmup-schedule`, `bounce-complaint-triage`), spreadsheets
  (`xlsx-financial-model-audit`, `gsheet-pivot-report`, `scenario-sensitivity-table`),
  hardware (`board-bringup-checklist`, `uart-console-debug`, `jtag-flash-recovery`),
  video (`hls-ladder-encode`, `subtitle-burnin-sync`, `video-loudness-normalize`),
  search (`synonym-dictionary-tuning`, `ranking-judgment-eval`, `query-rewrite-rules`),
  HR (`onboarding-doc-pack`, `offboarding-access-revoke`, `probation-review-template`),
  procurement (`purchase-request-draft`, `vendor-quote-compare`, `po-three-way-match`),
  PostgreSQL (`pg-online-migration`, `pg-slow-query-plan`,
  `pg-logical-replication-cutover`). Some groups also overlap each other
  (for example `po-three-way-match` vs `vat-invoice-reconcile`).
- 4 catch-all skills (listed above).
- 23 standalone skills.

## Task composition (as produced, counted by the validation script)

| | en | ko | mixed | total |
| --- | --- | --- | --- | --- |
| none (gold `[]`) | 28 | 25 | 10 | 63 (35%) |
| single (one skill) | 28 | 25 | 10 | 63 (35%) |
| multi (two skills) | 8 | 7 | 3 | 18 (10%) |
| confusable (one of a group) | 17 | 15 | 4 | 36 (20%) |
| total | 81 (45%) | 72 (40%) | 27 (15%) | 180 |

- Gold size: 63 tasks with 0 skills, 99 with 1, 18 with 2.
- Author-estimated difficulty: 40 easy, 91 medium, 49 hard.
- 68 of 72 skills appear as gold at least once; the 4 that never do are the
  catch-alls. No skill is gold more than 4 times.
- `mixed` means Korean sentences with English technical terms.

Hard cases included on purpose: briefs that never use the skill's vocabulary;
tasks where the obvious keyword points at the wrong skill; Korean tasks whose
skill is described in English and English tasks whose skill is described in
Korean; no-skill tasks that mention a skill's keywords; and borderline cases
where a single specified edit falls inside a skill's domain.

## Scoring notes

- Compare the predicted set with `gold` as sets. For `gold: []` the correct
  output is abstention (no skill).
- `skill-tasks.meta.jsonl` and `skill-tasks.gold.jsonl` must not be passed to
  the system under test or to labelers.
- This directory is not yet frozen: no `HOLDOUT.json` exists, and freezing
  (hashing, commit) is a separate later step.
