#!/usr/bin/env bash
# The prebuilt core's key: what core.wasm, diff.wasm and the formats are made
# from, as committed (their trees' and the PhiTeX submodule's hashes), so a
# core uploaded by scripts/build-all.sh is the one CI's deploy of the demo
# finds for the same commit (.github/workflows/deploy-demo.yml).
#
#   scripts/core-key.sh           # the key, 16 hex digits
#   scripts/core-key.sh --dirty   # those inputs' uncommitted changes (none: empty)
set -euo pipefail
cd "$(dirname "$0")/.."
paths=(core diff-wasm phitex rust-toolchain.toml scripts/make-formats.sh test/core-run.ts texmf test/scenarios/live test/scenarios/fontspec)
if [ "${1:-}" = --dirty ]; then git status --porcelain -- "${paths[@]}"; exit; fi
for p in "${paths[@]}"; do git rev-parse "HEAD:$p"; done | sha256sum | cut -c1-16
