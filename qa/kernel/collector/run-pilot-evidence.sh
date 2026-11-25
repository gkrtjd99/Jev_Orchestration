#!/usr/bin/env bash
# Runs the outcome collector on the paired-pilot evidence and the re-check session's hook state. Offline.
#   run-pilot-evidence.sh <evidence root> <work dir> <output dir>
# <evidence root> holds pilot/{runA,runB,transcriptsA,transcriptsB,evidence-projectA} and recheck/run as recorded.
# The hook state is COPIED into <work dir> first; the evidence itself is only read. Everything written to
# <output dir> passes the collector's own validators (hashes, numbers, enums, validated names).
set -euo pipefail
evidence="$1"; work="$2"; out="$3"
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
product="$here/../../../orchestration"
state() { printf '%s/home/.local/state/jev-hooks' "$1"; }
rm -rf -- "$work"; mkdir -p "$work" "$out"
cp -R "$(state "$evidence/pilot/runA")" "$work/stateA"
cp -R "$(state "$evidence/pilot/runB")" "$work/stateB"
cp -R "$(state "$evidence/recheck/run")" "$work/stateR"

node "$here/make-verification.mjs" --project "$evidence/pilot/evidence-projectA" --transcripts "$evidence/pilot/transcriptsA" --out "$out/verification-armA.json" --artifact-out "$work/checker-armA.json" > "$out/verification-armA.summary.json"
node "$here/make-verification.mjs" --project "$evidence/pilot/runB/project" --transcripts "$evidence/pilot/transcriptsB" --out "$out/verification-armB.json" --artifact-out "$work/checker-armB.json" > "$out/verification-armB.summary.json"

# What-if, dry run: with an evaluation context named, which withholding reasons remain?
node "$product/scripts/collect.mjs" --state-dir "$work/stateA" --transcripts "$evidence/pilot/transcriptsA" --project "$evidence/pilot/evidence-projectA" --verification "$out/verification-armA.json" --evaluation-context pilot-20261125 --dry-run > "$out/summary-armA.with-context.dry-run.json"
node "$product/scripts/collect.mjs" --state-dir "$work/stateB" --transcripts "$evidence/pilot/transcriptsB" --verification "$out/verification-armB.json" --evaluation-context pilot-20261125 --dry-run > "$out/summary-armB.with-context.dry-run.json"

# The real runs (no evaluation context is configured in the recorded sessions, so none is passed).
node "$product/scripts/collect.mjs" --state-dir "$work/stateA" --transcripts "$evidence/pilot/transcriptsA" --project "$evidence/pilot/evidence-projectA" --verification "$out/verification-armA.json" --out "$work/candidatesA" > "$out/summary-armA.json"
node "$product/scripts/collect.mjs" --state-dir "$work/stateB" --transcripts "$evidence/pilot/transcriptsB" --verification "$out/verification-armB.json" --out "$work/candidatesB" > "$out/summary-armB.json"
# Second run on the same state: must write nothing new.
node "$product/scripts/collect.mjs" --state-dir "$work/stateB" --transcripts "$evidence/pilot/transcriptsB" --verification "$out/verification-armB.json" --out "$work/candidatesB" > "$out/summary-armB.second-run.json"
# The re-check session: its transcripts were not kept, so only the hook state is summarised.
node "$product/scripts/collect.mjs" --state-dir "$work/stateR" > "$out/summary-recheck.state-only.json"

for arm in A B; do
  node "$product/scripts/collect.mjs" --state-dir "$work/state$arm" --report > "$out/observations-report-arm$arm.json"
  cat "$work/state$arm"/observations-log/observations-*.jsonl > "$out/observations-arm$arm.jsonl"
done
node "$product/scripts/decisions.mjs" --action report --log-dir "$work/stateB/decisions-log" --point delegation.skills --source observed-load > "$out/calibration-armB.observed-load.json"
node "$product/scripts/decisions.mjs" --action report --log-dir "$work/stateB/decisions-log" --point delegation.skills > "$out/calibration-armB.all-sources.json"
node "$here/calibration-by-question.mjs" --log-dir "$work/stateB/decisions-log" --source observed-load > "$out/calibration-armB.observed-load.by-question.json"
ls "$work/candidatesA" "$work/candidatesB" 2>/dev/null | wc -l | tr -d ' ' > "$work/candidate-file-count.txt"
