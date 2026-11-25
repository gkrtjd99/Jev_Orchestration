#!/bin/sh
# Proves that the distinctive strings of each target skill's conventions appear nowhere in template/
# except in that skill's own SKILL.md. Prints every hit; exits 1 when there is one.
cd "$(dirname "$0")/template" || exit 2
status=0
check() {
  skill="$1"; pattern="$2"
  hits=$(grep -rnE --exclude-dir=node_modules -e "$pattern" . | grep -v "^./.claude/skills/$skill/SKILL.md:")
  own=$(grep -cE -e "$pattern" "./.claude/skills/$skill/SKILL.md")
  if [ -n "$hits" ]; then
    status=1
    echo "LEAK  $skill"
    echo "$hits"
  else
    echo "ok    $skill  (0 hits outside its SKILL.md; $own matching lines inside it)"
  fi
}
check domain-failure-types   'Fault|faults|\.fault\.|PD-[A-Z]{3}-|retryAfterSec|-70[0-9]{2}'
check periodic-job-contract  'ceilingSec|ceiling=|@v[0-9]|JOBS\.ledger|scanned|skipped|owner=|dock-ops|locker-fleet|courier-desk'
check customer-text-messages '\.sms|#PD|\{ref\}|copy-desk|awaiting-desk'
check runtime-settings       'PDESK_|[A-Z]__[A-Z]|:invalid|warnings|[a-z]Ms([^a-z]|$)|_SEC([^A-Z]|$)'
check partner-file-exports   'pd-export|rows=|[Ss]emicolon|CRLF|\\r\\n|YYYYMMDD|snake_case|[0-9]{8}T[0-9]{4}Z|locker_id|_at([^a-z]|$)'
check read-endpoints         'asOf|tier|read:|\.unknown|problem|v: 1'
exit $status
