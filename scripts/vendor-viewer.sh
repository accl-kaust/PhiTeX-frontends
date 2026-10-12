#!/usr/bin/env bash
# The viewer every host shows lives in PhiTeX's viewer/src (the panel, the
# session it runs on, the pages drawn by MuPDF): copied from the PhiTeX
# commit viewer.pin names into common/src/vendor/viewer/, never edited here
# (a change is a PhiTeX commit, then a repin). The commit's export is
# ~/code/tmp/phitex-<commit> (git -C PhiTeX archive <commit> viewer
# scripts/fetch-mupdf.sh | tar -x -C there).
#   scripts/vendor-viewer.sh          # copy
#   scripts/vendor-viewer.sh --check  # fail if the copy differs from the pin
set -euo pipefail
cd "$(dirname "$0")/.."
pin=$(cat viewer.pin)
src="$HOME/code/tmp/phitex-$pin/viewer/src"
dst=common/src/vendor/viewer
[ -d "$src" ] || { echo "no $src (export PhiTeX $pin there)" >&2; exit 1; }
if [ "${1:-}" = "--check" ]; then
  diff -r "$src" "$dst" > /dev/null || { echo "common/src/vendor/viewer differs from PhiTeX $pin's viewer/src: run scripts/vendor-viewer.sh" >&2; exit 1; }
  echo "viewer: as PhiTeX $pin"
  exit 0
fi
rm -rf "$dst"
mkdir -p "$dst"
cp "$src"/*.ts "$dst"/
echo "viewer: copied from PhiTeX $pin ($(ls "$dst" | wc -l) files)"
