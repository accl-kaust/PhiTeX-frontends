#!/usr/bin/env bash
# Every frontend, built here: the browser extension (scripts/package.sh:
# store/phitex-instant-<version>.zip), the web frontend (web/dist), VS Code's
# (vscode/phitex-instant-<version>.vsix). (demo.phitex.org is built and
# deployed by CI on each push to main: .github/workflows/deploy-demo.yml.)
# Always the branch's latest on GitHub, here: the branch checked out and
# fast-forwarded to github/BRANCH, its PhiTeX checked out, its packages
# installed when their locks changed. Refused with uncommitted changes.
#
#   scripts/build-all.sh [BRANCH]   # default main
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${BUILD_ALL_FETCHED:-}" ]; then
  branch=${1:-main}
  # (the submodule not counted: it is checked out at the branch's commit below)
  [ -z "$(git status --porcelain --untracked-files=no --ignore-submodules)" ] || { echo "uncommitted changes: commit or stash them first" >&2; exit 1; }
  locks() { git rev-parse HEAD:package-lock.json HEAD:vscode/package-lock.json; }
  before=$(locks)
  git fetch github "$branch"
  git checkout "$branch"
  git merge --ff-only "github/$branch"
  git submodule update --init phitex
  [ "$(locks)" = "$before" ] || { scripts/sandbox --net npm ci && scripts/sandbox --net npm ci --prefix vscode; }
  echo "building $branch $(git rev-parse --short HEAD)"
  # (the branch's own build-all.sh, read anew: bash reads a script as it runs it)
  exec env BUILD_ALL_FETCHED=1 scripts/build-all.sh
fi
scripts/package.sh
scripts/build-vscode.sh --package
