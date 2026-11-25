# Declared resolved model ids on the pilot evidence, 2026-11-25

Output of `orchestration/scripts/collect.mjs` (`outcome-collector-3`) run offline on COPIES of the hook state of the
two paired-pilot sessions, with their transcripts read in place. Produced by
`qa/kernel/collector/run-alias-demo.sh <evidence root> <work dir> <this folder>` (exit 0). Documentation:
`docs/KERNEL.ko.md`, section "결과 수집기" ("registry의 `resolvesTo`", "평가 행이 만들어지려면").

Earlier results on the same evidence (`../collector-20261125-r2/`, `outcome-collector-2`) are left as they were.
The verification files used here are the ones committed there (`verification-arm{A,B}.json`).

## What was asked

The registry of the pilot sessions names Claude models by alias (`sonnet`, `opus`). The host records the id it
resolved (`claude-sonnet-5-5`, `claude-opus-5-5`). The evidence importer accepts an effective model only when it is
string-equal to the profile's backend, or - new - to an id the user declared for that registry entry (`resolvesTo`).

## Three scenarios

**(b) and (c) are dry runs that show the mechanism. They are not importable evidence**, and nothing in this folder
is: the recorded sessions ran under the default evaluation context.

| | arm A (8 delegations, 7 routed) | arm B (8 delegations, 8 routed) |
|---|---|---|
| (a) recorded config, only `stateDir` pointed at the copy; real run on the copy | 0 rows. Withheld: `evaluation_context_not_configured` 8, `effective_model_alias_undeclared` 7, `delegation_not_routed` 1 | 0 rows. `evaluation_context_not_configured` 8, `effective_model_alias_undeclared` 8 |
| (b) `--evaluation-context pilot-alias-demo-20261125`, no declaration; dry run | 0 rows. `session_ran_under_default_evaluation_context` 7, `effective_model_alias_undeclared` 7, `delegation_not_routed` 1 | 0 rows. `session_ran_under_default_evaluation_context` 8, `effective_model_alias_undeclared` 8 |
| (c) the same context and a temp config that declares the ids (b) listed; dry run | 0 rows. `session_ran_under_default_evaluation_context` 7, `importer_refuses:STALE_EVIDENCE_PROFILE` 7, `delegation_not_routed` 1 | 0 rows. `session_ran_under_default_evaluation_context` 8, `importer_refuses:STALE_EVIDENCE_PROFILE` 8 |
| model match of the routed, joined delegations in (a) and (b) | exact 0, declared 0, alias-undeclared 7, mismatch 0 | exact 0, declared 0, alias-undeclared 8, mismatch 0 |
| model match in (c) | exact 0, declared 7, alias-undeclared 0, mismatch 0 | exact 0, declared 8, alias-undeclared 0, mismatch 0 |
| candidate files written | 0 | 0 |

A task can be withheld for several reasons, so the reason counts of one cell do not add up to the 8 tasks.

What (b) told the user to look at (`modelMatch.undeclared`, the same in (a)):

| registry entry | backend (alias) | id the host recorded | delegations A / B |
|---|---|---|---|
| `claude-light` | `sonnet` | `claude-sonnet-5-5` | 1 / 1 |
| `claude-standard` | `opus` | `claude-opus-5-5` | 6 / 7 |

The collector added nothing to any registry. The temp config of (c) was built by
`qa/kernel/collector/make-alias-demo-config.mjs`, a demo helper that does mechanically, on a temp copy, what the
product leaves to the user (declare an id after checking it). The two recorded `config.json` files have the same
SHA-256 before and after the run, the number of files under the two recorded state directories is unchanged, and
`resolvesTo` occurs 0 times in the recorded configs. The recorded `.env` files were not opened.

What remains in (c), and why neither reason can be configured away:

- `session_ran_under_default_evaluation_context` (15): the route events of both sessions record the context
  `native-default-unvalidated`. A row is produced only for the context a session ran under.
- `importer_refuses:STALE_EVIDENCE_PROFILE` (15): a declaration is part of the profile fingerprint. The routes carry
  the fingerprint of the profiles as they were defined without the declaration.

So these two sessions can never be imported. That a declared id does produce a row which the importer accepts is
shown only by tests with synthetic sessions (`orchestration/test/collector.test.mjs`, "end to end: ...").

## Cross-check of the model id the host resolved at launch

`modelMatch.resolvedModelCheck` in each summary:

- `hostResult`: the `resolvedModel` of the Agent result as Main's transcript keeps it, against the model the
  subagent's own rows name: agreed 8 of 8 in arm A and 8 of 8 in arm B (16 of 16), disagreed 0.
- `hookEvent`: the same value as the PostToolUse hook stores it in the `spawn_observed` event: absent 16 of 16.
  The hooks of these sessions predate that field, so this half of the check has no real-session result.

## Files

| File | Content |
|---|---|
| `summary-arm{A,B}.a-unchanged-config.json` | Collector summary, scenario (a) |
| `summary-arm{A,B}.b-context-no-declaration.dry-run.json` | Collector summary, scenario (b) |
| `summary-arm{A,B}.c-context-and-declaration.dry-run.json` | Collector summary, scenario (c) |
| `observations-report-arm{A,B}.a-unchanged-config.json` | `collect.mjs --config ... --report` after (a): delegations by match kind and the (empty) evidence store |
| `config-arm{A,B}.recorded.json` | The Claude entries of the recorded registry and the recorded evaluation context (no paths, no other config) |
| `config-arm{A,B}.c-declared.json` | The same for the temp config of (c), with the declarations it added |
| `candidate-file-count.txt` | Number of candidate evaluation files the three scenarios wrote in total: 0 |

The summaries hold counts, hashes, enums and validated identifiers only (the collector's own validators). They carry
unkeyed task hashes of the pilot's synthetic tasks, as the earlier result folders do.
