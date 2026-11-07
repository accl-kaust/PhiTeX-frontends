#!/usr/bin/env bash
# The formats the extension ships (build/overleaf/formats/, read by the core's
# worker when this browser has none kept): each engine's evaluated state
# and its package loads' records, made by CORE_WASM itself, on Node, from a
# cold build of a small document (test/harness/core-run.ts --cold --store): an
# amsmath article for pdfLaTeX, a fontspec article for XeLaTeX
# (test/scenarios/fontspec/main.tex). The store's `format/NAME` is shipped
# as NAME.gzdata (its package loads' records, `format/NAME/pkgrecs/HASH`,
# are hints the core makes again: not shipped); and
# NAME.packs.txt, the packs a warm build of the document fetched on that
# format (the fonts' metrics, pdftex.map: what every first document reads,
# fetched at once by the worker when the format is read). NAME holds the
# engine's identity: a format made by another core.wasm is never asked
# for, so build them together (build.sh). Its packs from
# target/shelf-cache/, else Shelf (needs the network then).
#
#   tools/build/make-formats.sh [CORE_WASM] [OUT_DIR]   # default: target/wasm-live/core.wasm, target/formats
set -euo pipefail
cd "$(dirname "$0")/../.."
wasm=${1:-target/wasm-live/core.wasm}
out=${2:-target/formats}
rm -rf "$out"
mkdir -p "$out"
# (ENGINE DOCUMENT: that engine's format, from a store of its own)
make() {
  local engine=$1 doc=$2 st=target/formats-store-$1
  rm -rf "$st"
  node test/harness/core-run.ts "$doc" --engine "$engine" --cold --wasm "$wasm" --store "$st"
  local name=""
  for f in "$st"/format%2F*; do
    local k
    k=$(basename "$f")
    k=${k#format%2F}
    [[ $k == *%2F* ]] && continue
    gzip -9 -c "$f" > "$out/$k.gzdata"
    name=$k
  done
  # (the warm build: the packs a first document needs beside the format)
  node test/harness/core-run.ts "$doc" --engine "$engine" --wasm "$wasm" --store "$st" --packs "$st/packs.txt"
  cp "$st/packs.txt" "$out/$name.packs.txt"
}
make pdflatex test/scenarios/live/main.tex
make xelatex test/scenarios/fontspec/main.tex
ls -la "$out"
