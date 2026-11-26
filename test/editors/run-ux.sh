#!/usr/bin/env bash
# The editors' checks of a new user's paths (check-ux.lua, check-ux.el) against one
# phitex binary: test/editors/run-ux.sh PHITEX [nvim] [emacs]. Exits 1 if any fails.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bin="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; shift
which=("${@:-nvim emacs}")
tmp="$(mktemp -d)"
mkdir -p "$tmp/bin" "$tmp/project" "$tmp/run"
ln -s "$bin" "$tmp/bin/phitex"
printf '\\documentclass{article}\n\\begin{document}\nHello world.\n\nSome motivation text that is long enough to wrap onto a second line of the page, so the paragraph is real.\n\\end{document}\n' > "$tmp/project/main.tex"
export PATH="$tmp/bin:$PATH" PROJECT="$tmp/project" XDG_RUNTIME_DIR="$tmp/run"
if ! command -v kpsewhich > /dev/null; then
  export XDG_CONFIG_HOME="$tmp/config"
  mkdir -p "$XDG_CONFIG_HOME/phitex"
  echo 'files = "shelf"' > "$XDG_CONFIG_HOME/phitex/phitex.toml"
fi
status=0
for e in ${which[@]}; do
  echo "== $e"
  case $e in
    nvim) out=$(PHITEX_NVIM_CONFIG="$repo/apps/editors/nvim/phitex.lua" timeout 600 nvim --clean --headless -c "luafile $here/check-ux.lua" 2>&1 | tr '\r' '\n'); code=${PIPESTATUS[0]} ;;
    emacs) out=$(timeout 600 emacs --batch -Q -l "$repo/apps/editors/emacs/phitex.el" -l "$here/check-ux.el" 2>&1); code=$? ;;
    *) echo "no editor $e"; exit 2 ;;
  esac
  grep -E '^(ok|FAIL) ' <<<"$out"
  if [ "$code" != 0 ] || grep -q '^FAIL ' <<<"$out" || ! grep -q '^ok ' <<<"$out"; then
    status=1
    grep -q '^FAIL ' <<<"$out" || { echo "-- $e said:"; tail -40 <<<"$out"; }
  fi
done
rm -rf "$tmp"
exit $status
