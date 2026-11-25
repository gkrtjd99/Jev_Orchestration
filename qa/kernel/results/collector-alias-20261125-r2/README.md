# Declared resolved model ids on the pilot evidence, 2026-11-25 (after review)

Output of `orchestration/scripts/collect.mjs` (`outcome-collector-4`) run offline on COPIES of the hook state of the
two paired-pilot sessions, with their transcripts read in place. Produced by
`qa/kernel/collector/run-alias-demo.sh <evidence root> <work dir> <this folder>` (exit 0). Documentation:
`docs/KERNEL.ko.md`, section "결과 수집기" ("registry의 `resolvesTo`", "평가 행이 만들어지려면").

This folder replaces `../collector-alias-20261125/` (`outcome-collector-3`, before review), which is kept and marked
superseded. What differs: scenario (c) no longer calls sessions that ran before the declaration `declared`; the
summaries carry no `wouldNeed` registry fragment; the ids declared in (c) are written by hand in the script instead
of being taken from the summary of (b); an observation report after a real write of (c) is added. Row counts and the
numbers of (a) and (b) are the same as before.

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
| (a) recorded config, `stateDir` pointed at the copy and the registry `revision` set to the demo mark; real run on the copy | 0 rows. Withheld: `evaluation_context_not_configured` 8, `effective_model_alias_undeclared` 7, `delegation_not_routed` 1 | 0 rows. `evaluation_context_not_configured` 8, `effective_model_alias_undeclared` 8 |
| (b) `--evaluation-context pilot-alias-demo-20261125`, no declaration; dry run | 0 rows. `session_ran_under_default_evaluation_context` 7, `effective_model_alias_undeclared` 7, `delegation_not_routed` 1 | 0 rows. `session_ran_under_default_evaluation_context` 8, `effective_model_alias_undeclared` 8 |
| (c) the same context and a temp config that declares two ids typed into the script; dry run | 0 rows. `session_ran_under_default_evaluation_context` 7, `importer_refuses:STALE_EVIDENCE_PROFILE` 7, `effective_model_declared_after_session` 7, `delegation_not_routed` 1 | 0 rows. `session_ran_under_default_evaluation_context` 8, `importer_refuses:STALE_EVIDENCE_PROFILE` 8, `effective_model_declared_after_session` 8 |
| model match of the routed, joined delegations in (a) and (b) | exact 0, declared 0, declared-not-in-force 0, alias-undeclared 7, mismatch 0 | exact 0, declared 0, declared-not-in-force 0, alias-undeclared 8, mismatch 0 |
| model match in (c) | exact 0, declared 0, declared-not-in-force 7, alias-undeclared 0, mismatch 0 | exact 0, declared 0, declared-not-in-force 8, alias-undeclared 0, mismatch 0 |
| observation report after (c) written for real on a further copy | compared 7, declared 0, declaredNotInForce 7, acceptedRate 0 | compared 8, declared 0, declaredNotInForce 8, acceptedRate 0 |
| candidate files written | 0 | 0 |

A task can be withheld for several reasons, so the reason counts of one cell do not add up to the 8 tasks.

What (b) listed as observed (`modelMatch.undeclared`, the same in (a); all four `declarable: true`). It is an
observation, not a declaration and not a registry fragment:

| registry entry | backend (alias) | id the host recorded | delegations A / B |
|---|---|---|---|
| `claude-light` | `sonnet` | `claude-sonnet-5-5` | 1 / 1 |
| `claude-standard` | `opus` | `claude-opus-5-5` | 6 / 7 |

The collector added nothing to any registry. The temp config of (c) was built by
`qa/kernel/collector/make-alias-demo-config.mjs` from two declarations typed into `run-alias-demo.sh`
(`claude-light=claude-sonnet-5-5`, `claude-standard=claude-opus-5-5`). The helper does not read a collector summary,
refuses to write outside the given work directory, and sets the registry `revision` of everything it writes to
`DEMO-NOT-FOR-INSTALL` (which is why the `config-arm*.json` files here show that revision; a revision is not part
of a profile fingerprint). The two recorded `config.json` files have the same SHA-256 before and after the run, the
number of files under the two recorded state directories is unchanged (116 and 169), a hash over all of those state
files is unchanged, and `resolvesTo` occurs 0 times in the recorded configs. The recorded `.env` files were not
opened. Running the script a second time gave byte-identical output.

In (c) the model reason `effective_model_alias_undeclared` is gone, but the 15 delegations are not `declared`: the
declaration was not part of the profile definition those sessions ran with (their routes carry another
fingerprint). They are `declared-not-in-force`, withheld as `effective_model_declared_after_session`, and the
observation report written from them has `acceptedRate` 0 (the superseded folder would have given 1).

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
| `observations-report-arm{A,B}.c-declared-written.json` | The same report after (c) was run for real (not dry) on a further copy |
| `config-arm{A,B}.recorded.json` | The Claude entries of the recorded registry and the recorded evaluation context (no paths, no other config) |
| `config-arm{A,B}.c-declared.json` | The same for the temp config of (c), with the declarations it added |
| `candidate-file-count.txt` | Number of candidate evaluation files all runs wrote in total: 0 |

The summaries hold counts, hashes, enums and validated identifiers only (the collector's own validators). They carry
unkeyed task hashes of the pilot's synthetic tasks, as the earlier result folders do.
