#!/usr/bin/env bash
# The editors' checks against one phitex binary (the release gate and the
# nightly run them, PhiTeX's .github/workflows/release.yml and nightly.yml):
#   test/editors/run.sh PHITEX [emacs] [nvim]
# A project with its main file and a chapter it inputs (the cursor starts
# in the chapter: item 30's regression). Exits 1 if any check fails.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bin="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; shift
which=("${@:-emacs nvim}")
tmp="$(mktemp -d)"
mkdir -p "$tmp/bin" "$tmp/project/chapters"
ln -s "$bin" "$tmp/bin/phitex"
printf '\\documentclass{article}\n\\begin{document}\nMain text.\n\n\\input{chapters/ch1}\n\\end{document}\n' > "$tmp/project/main.tex"
printf 'Chapter one, its words on the page.\n' > "$tmp/project/chapters/ch1.tex"
export PATH="$tmp/bin:$PATH" PROJECT="$tmp/project" PROBE="$here/probe.mjs"
status=0
for e in ${which[@]}; do
  echo "== $e"
  case $e in
    emacs) out=$(timeout 600 emacs --batch -Q -l "$repo/editors/emacs/phitex.el" -l "$here/check.el" 2>&1); code=$? ;;
    nvim) out=$(PHITEX_NVIM_CONFIG="$repo/editors/nvim/phitex.lua" timeout 600 nvim --clean --headless -c "luafile $here/check.lua" 2>&1 | tr '\r' '\n'); code=${PIPESTATUS[0]} ;;
    *) echo "no editor $e"; exit 2 ;;
  esac
  grep -E '^(ok|FAIL) ' <<<"$out"
  # (a check that never reported, a crash: the whole output)
  if [ "$code" != 0 ] || ! grep -q '^ok the watch stops' <<<"$out" || grep -q '^FAIL ' <<<"$out"; then
    status=1
    grep -q '^FAIL ' <<<"$out" || { echo "-- $e said:"; tail -40 <<<"$out"; }
  fi
done
exit $status
