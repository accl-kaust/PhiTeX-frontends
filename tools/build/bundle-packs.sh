#!/usr/bin/env bash
# The Shelf packs the extension ships (shelf/data/bundled-packs.txt; empty since
# 0.5.2: the packs arXiv papers use most are fetched in the background after
# install, prefetch.ts, shelf/data/ahead.txt) into build/overleaf/packs/, with
# list.txt, and the list fetched ahead (packs/ahead.txt). From a Shelf
# checkout's releases (SHELF_RELEASES; default SHELF_REPO/releases, e.g.
# SHELF_RELEASES=$SHELF_REPO/releases-s3 for a local schema-3 release; the
# sandbox binds SHELF_REPO read-only), else downloaded from the live Shelf
# (needs --net). Writes Shelf's keep-packs.txt too (SHELF_REPO/keep-packs.txt):
# release.py's GC keeps the packs a shipped extension bundles.
set -euo pipefail
cd "$(dirname "$0")/../.."
repo="${SHELF_REPO:-$HOME/code/flinner/shelf.PhiTeX.org}"
# (by the names the shipped index gives them: content-named, under h/)
src="${SHELF_RELEASES:-$repo/releases}/tl2026/h"
rm -rf build/overleaf/packs
mkdir -p build/overleaf/packs
: > build/overleaf/packs/list.txt
named=$(gzip -dc shelf/shelf-index.tsv.gz | cut -f2 | sort -u)
while read -r id; do
  [ -z "$id" ] && continue
  h=$(grep -E "^${id//./\.}-[0-9a-f]{12}$" <<<"$named" | head -1 || true)
  # (a pack the release no longer has by that name: fetched from Shelf when used)
  [ -z "$h" ] && { echo "bundled pack $id: not in the shipped index, not bundled" >&2; continue; }
  if [ -f "$src/$h.pack" ]; then cp "$src/$h.pack" "build/overleaf/packs/$h.pack"
  else curl -fsS -o "build/overleaf/packs/$h.pack" "https://v1.shelf.phitex.org/tl2026/h/$h.pack"
  fi
  echo "$h" >> build/overleaf/packs/list.txt
done < shelf/data/bundled-packs.txt
# (and what is fetched ahead: shelf/data/ahead.txt, test/bench/arxiv/coverage.py --ahead)
cp shelf/data/ahead.txt build/overleaf/packs/ahead.txt
# (in tools/sandbox the checkout is read-only: run once outside it to write the list)
if [ -d "$repo" ]; then cp build/overleaf/packs/list.txt "$repo/keep-packs.txt" 2>/dev/null || echo "keep-packs.txt: $repo read-only here, not written" >&2; fi
echo "build/overleaf/packs: $(wc -l < build/overleaf/packs/list.txt) packs, $(du -sh build/overleaf/packs | cut -f1)"
