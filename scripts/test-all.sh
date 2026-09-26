#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/home"
node_bin="$(command -v node)"
if [[ "$node_bin" == */.asdf/shims/node ]] && command -v asdf >/dev/null 2>&1; then
  resolved="$(asdf which node 2>/dev/null || true)"
  if [[ -x "$resolved" ]]; then node_bin="$resolved"; fi
fi
python_bin=''
for candidate in python3 python3.13 python3.12 python3.11; do
  if command -v "$candidate" >/dev/null 2>&1; then
    resolved="$(command -v "$candidate")"
    if "$resolved" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
      python_bin="$resolved"
      break
    fi
  fi
done
if [[ -z "$python_bin" ]]; then
  printf 'Python 3.11+ is required for independent verification\n' >&2
  exit 2
fi
env -i PATH="$(dirname "$node_bin"):$PATH" HOME="$work/home" TMPDIR="$(cd /tmp && pwd -P)" LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 \
  bash -c '    set -euo pipefail
    root="$1"; work="$2"; python_bin="$3"
    cd "$root/orchestration"
    node --version
    npm test
    npm run check
    cd "$root"
    "$python_bin" verification/verify.py --self-test --sut "$root/orchestration"
    "$python_bin" verification/verify.py --suite offline --sut "$root/orchestration" --out "$work/offline"
  ' _ "$root" "$work" "$python_bin"
