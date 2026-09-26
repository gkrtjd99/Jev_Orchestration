#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
node scripts/check.mjs
node --test test/*.test.mjs
node scripts/install.mjs "$@"
