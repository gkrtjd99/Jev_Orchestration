# Skill routing evaluation set (`delegation.skills`)

> Update (2026-11-25): a second, blind label file (`skill-tasks.blind.jsonl`) was added after this README was written, so the "no second annotator" statements below are out of date. Both label sets agree on 160 of 160 tasks; see `qa/kernel/REPORT.ko.md` for why that figure should not be read as proof of label quality.


Labeled data for evaluating skill selection at the subagent delegation boundary
(see `docs/KERNEL.ko.md`, section "Skill 라우팅").

**All of this is synthetic and model-authored.** The 40 skills, the 160 task prompts and the gold
labels were written by an LLM (Claude) in a single authoring pass. No task comes from a real
session, no label was reviewed by a human, and there is no second annotator, so label noise and
inter-annotator agreement are unmeasured (null). Scores on this set say how well a router agrees
with one model's judgment on invented cases. They are not evidence of quality, time or cost
effects on real work.

## Files

| File | Content |
| --- | --- |
| `skills/<name>/SKILL.md` | 40 skills. YAML frontmatter (`name`, `description`) plus a short body. Folder name equals `name` and matches `/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/`. |
| `skill-tasks.jsonl` | 160 delegation prompts, one JSON object per line: `{id, lang, category, task}`. No labels. |
| `skill-tasks.gold.jsonl` | Labels, same order and ids: `{id, gold: [skill names], rationale}`. |
| `validate-skill-tasks.mjs` | Structural check (parsing, unique ids, gold names exist, category/gold-count consistency). |

The skills directory can be used directly as an extra catalog directory
(`--dirs <abs path>/qa/kernel/data/skills` for `orchestration/scripts/skills.mjs`, or `JEV_SKILL_DIRS`).

## Labeling rule

A skill is in `gold` if and only if **a careful engineer would have the subagent load it before
starting, because loading it would materially change how the task should be done** (a procedure,
convention or pitfall the worker would otherwise miss or get wrong).

Consequences of that rule:

- Keyword overlap is not a reason. "Remove the dead link to setup.pdf" mentions a PDF but no PDF
  skill changes the work, so gold is `[]`.
- Trivial or generic work (renames, one-line config edits, explanations, code search, ordinary
  debugging) is `[]` even when it happens inside a skill's domain.
- When a task only references another area as context ("we used to do this in GitHub Actions"),
  only the skill for the thing actually being changed is gold.
- `multi` tasks list a skill only if a distinct part of the task needs it.
- The broad skills `code-quality-guidelines` and `general-assistant` are never gold: their
  descriptions claim to apply to everything and loading them changes nothing specific.
  `engineering-handbook` is gold exactly once (bootstrapping a new service repository).
- The order of names inside `gold` carries no meaning.
- `gold` is a set to load. The file does not distinguish the kernel's `load` and `consider` tiers.

## Categories

| Category | Definition | Gold size |
| --- | --- | --- |
| `none` | Ordinary work a capable agent does unaided. Roughly a third of these mention a skill's vocabulary superficially (pdf, SQL, Docker, Stripe, release, test ...). | 0 |
| `single` | Exactly one skill applies and no close sibling competes for it. Some prompts never use the skill's vocabulary. | 1 |
| `multi` | Two skills are each needed for a distinct part of the task. | 2 |
| `confusable` | Exactly one member of a confusable group applies, and the wording pulls toward a sibling (often by naming the sibling's topic explicitly). | 1 |

`category` is present in the unlabeled task file because the task format requires it. It reveals
the gold-set size, so do not pass it to a router under test.

## Distribution

Counts as printed by `validate-skill-tasks.mjs`:

| Category | en | ko | Total | Share |
| --- | --- | --- | --- | --- |
| none | 34 | 22 | 56 | 35% |
| single | 34 | 22 | 56 | 35% |
| multi | 9 | 7 | 16 | 10% |
| confusable | 19 | 13 | 32 | 20% |
| Total | 96 (60%) | 64 (40%) | 160 | 100% |

Ids (`st-001` .. `st-160`) are in a fixed shuffled order and carry no category signal. Korean
prompts were written in Korean, not translated from the English ones. Task length ranges from one
short line to a paragraph.

38 of the 40 skills appear in gold at least once (1 to 5 times each); 104 tasks have a non-empty
gold set and 56 have an empty one.

## Confusable groups in the catalog

- `pdf-extract` / `pdf-forms` / `pdf-report-builder`
- `xlsx-modeling` / `csv-cleaning` / `data-profiling`
- `sql-migration` / `sql-query-tuning` / `postgres-backup-restore`
- `react-component-patterns` / `css-design-tokens`
- `unit-test-vitest` / `e2e-playwright` / `api-contract-testing` / `load-testing-k6`
- `github-actions-ci` / `gitlab-ci-pipelines`
- `terraform-modules` / `terraform-state-ops`
- `security-code-review` / `dependency-audit` / `secrets-scanning`
- `release-notes` / `semver-release`
- `i18n-extraction` / `korean-style-guide`
- `stripe-integration` / `webhook-receiver`
- `openapi-spec` / `api-contract-testing`
- `a11y-audit` / `web-perf-budget`

Catch-all sounding skills: `code-quality-guidelines`, `general-assistant`, `engineering-handbook`.

## Known limitations

- One author, one pass: borderline labels exist. Examples a reasonable reviewer could dispute:
  porting a pipeline from GitLab to GitHub is labeled `github-actions-ci` only; fixing a
  hardcoded color inside a component is labeled `css-design-tokens` only; listing last week's
  merged PR titles for an internal meeting is labeled `[]`.
- Skill descriptions are in English only, while 40% of tasks are Korean. Lexical retrieval
  (the `local` BM25 rule) has almost no token overlap on those tasks by construction.
- The catalog is tidy: every description is well written and non-overlapping skills are easy to
  tell apart. Real catalogs contain vague, duplicated or misleading descriptions.
- The data is not a sample of real delegation traffic, so the 35% `none` rate is a design choice,
  not an estimate of how often real tasks need no skill.

## Validation

```sh
node qa/kernel/data/validate-skill-tasks.mjs
```

Exits non-zero on any parse error, duplicate id or task text, unknown gold name, missing gold row,
language/category mismatch, or a gold-set size that contradicts the category.
