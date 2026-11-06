#!/usr/bin/env bash
# Every frontend, built here: the browser extension (tools/build/package.sh:
# build/phitex-instant-<version>.zip), the web frontend (build/web), VS Code's
# (build/phitex-instant-<version>.vsix): all of it in build/. (demo.phitex.org is built and
# deployed by CI on each push to main: .github/workflows/deploy-demo.yml.)
# Always the branch's latest on GitHub, here: the branch checked out and
# fast-forwarded to github/BRANCH, its PhiTeX checked out, its packages
# installed when their locks changed. Refused with uncommitted changes.
#
#   tools/build-all.sh [BRANCH]   # default main
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${BUILD_ALL_FETCHED:-}" ]; then
  branch=${1:-main}
  # (the submodule not counted: it is checked out at the branch's commit below)
  [ -z "$(git status --porcelain --untracked-files=no --ignore-submodules)" ] || { echo "uncommitted changes: commit or stash them first" >&2; exit 1; }
  locks() { git rev-parse HEAD:package-lock.json HEAD:apps/vscode/package-lock.json; }
  before=$(locks)
  git fetch github "$branch"
  git checkout "$branch"
  git merge --ff-only "github/$branch"
  git submodule update --init phitex
  [ "$(locks)" = "$before" ] || { tools/sandbox --net npm ci && tools/sandbox --net npm ci --prefix apps/vscode; }
  echo "building $branch $(git rev-parse --short HEAD)"
  # (the branch's own build-all.sh, read anew: bash reads a script as it runs it)
  exec env BUILD_ALL_FETCHED=1 tools/build-all.sh
fi
# (each step said as it begins: what the build is doing now)
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
step "The browser extension and the web demo (tools/build/package.sh)"
tools/build/package.sh
step "The VS Code extension (tools/build/build-vscode.sh --package)"
tools/build/build-vscode.sh --package
step "Done"
ls -1t build/phitex-instant-*.zip build/phitex-instant-*.vsix 2>/dev/null | head -2
echo "build/web (the web demo, as CI deploys it)"
