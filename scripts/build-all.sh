#!/usr/bin/env bash
# Every frontend, built here: the browser extension (scripts/package.sh:
# store/phitex-instant-<version>.zip), the web frontend (web/dist), VS Code's
# (vscode/phitex-instant-<version>.vsix). Then what CI cannot build, the core
# (core.wasm, diff.wasm, the formats, minted's wheels), uploaded for
# demo.phitex.org's deploy on a push to main (.github/workflows/deploy-demo.yml):
# release "cores", asset core-KEY.tar.gz (scripts/core-key.sh). Not uploaded
# when the core's inputs have uncommitted changes: the key would name another core.
# Always the branch's latest on GitHub (main: what CI deploys), here: the
# branch checked out and fast-forwarded to github/BRANCH, its PhiTeX checked
# out, its packages installed when their locks changed. Refused with
# uncommitted changes.
#
#   scripts/build-all.sh [BRANCH]   # default main
set -euo pipefail
cd "$(dirname "$0")/.."
repo=accl-kaust/PhiTeX-frontends
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

key=$(scripts/core-key.sh)
dirty=$(scripts/core-key.sh --dirty)
if [ -n "$dirty" ]; then printf 'the core'"'"'s inputs uncommitted, core-%s not uploaded:\n%s\n' "$key" "$dirty"; exit 0; fi
if gh release view cores -R "$repo" --json assets -q '.assets[].name' 2>/dev/null | grep -qx "core-$key.tar.gz"; then echo "core-$key uploaded already"; exit 0; fi
b="target/core-$key"
rm -rf "$b" && mkdir -p "$b/formats" "$b/minted"
cp overleaf/dist/core.wasm overleaf/dist/diff.wasm "$b/"
cp overleaf/formats/* "$b/formats/"
cp /usr/share/texmf-dist/scripts/minted/*.whl "$b/minted/"
tar -czf "$b.tar.gz" -C "$b" .
gh release view cores -R "$repo" > /dev/null 2>&1 ||
  gh release create cores -R "$repo" --latest=false --title "Prebuilt cores" --notes "The wasm core, latexdiff and the formats, built by scripts/build-all.sh; one asset per core-KEY (scripts/core-key.sh), read by the demo's deploy."
gh release upload cores "$b.tar.gz" -R "$repo"
echo "core-$key uploaded ($(du -h "$b.tar.gz" | cut -f1))"
