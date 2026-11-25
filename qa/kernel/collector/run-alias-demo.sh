#!/usr/bin/env bash
# Demonstrates the registry's declared resolved model ids (`resolvesTo`) on the paired-pilot evidence. Offline.
#   run-alias-demo.sh <evidence root> <work dir> <output dir>
# <evidence root> holds pilot/{runA,runB,transcriptsA,transcriptsB,evidence-projectA} as recorded.
# The hook state is COPIED into <work dir> once per scenario; the evidence itself is only read, the recorded
# .env files are never opened, and no registry of the evidence is written. Verification files are the ones
# committed under results/collector-20261125-r2.
#   (a) the recorded config, unchanged except for stateDir (which points at the copy): a real run
#   (b) the recorded config + an evaluation context name, no declaration: DRY RUN
#   (c) as (b), with a temp config that declares the ids written out below (DECLARE): DRY RUN
# The ids of (c) are typed here by hand, the way a user types them into a registry. Nothing is taken from a
# collector summary: what the collector observed is never turned into a declaration by a program.
# (c) is also written once for real on a further copy, to record what the observation report says afterwards.
# (b) and (c) show the mechanism. They are not importable evidence: the sessions ran under the default context.
set -euo pipefail
evidence="$1"; work="$2"; out="$3"
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
product="$here/../../../orchestration"
verification="$here/../results/collector-20261125-r2"
context="pilot-alias-demo-20261125"
DECLARE=(--declare claude-light=claude-sonnet-5-5 --declare claude-standard=claude-opus-5-5)
rm -rf -- "$work"; mkdir -p "$work" "$out"
demo_config() { node "$here/make-alias-demo-config.mjs" --work "$work" "$@"; }

for arm in A B; do
  state="$evidence/pilot/run$arm/home/.local/state/jev-hooks"
  recorded="$evidence/pilot/run$arm/home/.config/jev-hooks/config.json"
  transcripts="$evidence/pilot/transcripts$arm"
  common=(--transcripts "$transcripts" --verification "$verification/verification-arm$arm.json")
  # Arm A ran with the skills point off, so its hook state names no project skill (as in run-pilot-evidence.sh).
  if [[ "$arm" == A ]]; then common+=(--project "$evidence/pilot/evidence-projectA"); fi
  for scenario in a b c; do cp -R "$state" "$work/state$arm-$scenario"; done

  # (a) unchanged config, real run on the copy
  demo_config --config "$recorded" --state-dir "$work/state$arm-a" --out "$work/config$arm-a/config.json" > "$out/config-arm$arm.recorded.json"
  node "$product/scripts/collect.mjs" --config "$work/config$arm-a/config.json" "${common[@]}" --out "$work/candidates$arm-a" > "$out/summary-arm$arm.a-unchanged-config.json"
  node "$product/scripts/collect.mjs" --config "$work/config$arm-a/config.json" --report > "$out/observations-report-arm$arm.a-unchanged-config.json"

  # (b) a context name, no declaration, dry run
  demo_config --config "$recorded" --state-dir "$work/state$arm-b" --out "$work/config$arm-b/config.json" > /dev/null
  node "$product/scripts/collect.mjs" --config "$work/config$arm-b/config.json" "${common[@]}" --evaluation-context "$context" --dry-run > "$out/summary-arm$arm.b-context-no-declaration.dry-run.json"

  # (c) a context name and a temp config declaring the ids named in DECLARE, dry run
  demo_config --config "$recorded" --state-dir "$work/state$arm-c" --out "$work/config$arm-c/config.json" \
    "${DECLARE[@]}" > "$out/config-arm$arm.c-declared.json"
  node "$product/scripts/collect.mjs" --config "$work/config$arm-c/config.json" "${common[@]}" --evaluation-context "$context" --dry-run > "$out/summary-arm$arm.c-context-and-declaration.dry-run.json"
  # (c), written for real on its own copy: what the observation log and its report then say about these sessions
  cp -R "$state" "$work/state$arm-cw"
  demo_config --config "$recorded" --state-dir "$work/state$arm-cw" --out "$work/config$arm-cw/config.json" "${DECLARE[@]}" > /dev/null
  node "$product/scripts/collect.mjs" --config "$work/config$arm-cw/config.json" "${common[@]}" --evaluation-context "$context" --out "$work/candidates$arm-cw" > /dev/null
  node "$product/scripts/collect.mjs" --config "$work/config$arm-cw/config.json" --report > "$out/observations-report-arm$arm.c-declared-written.json"
done
find "$work" -path '*candidates*' -type f 2>/dev/null | wc -l | tr -d ' ' > "$out/candidate-file-count.txt" || true
# The evidence's own registries must be untouched.
for arm in A B; do grep -c resolvesTo "$evidence/pilot/run$arm/home/.config/jev-hooks/config.json" || true; done > "$work/resolvesTo-in-evidence.txt"
