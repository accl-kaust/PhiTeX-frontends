#!/usr/bin/env bash
# The formats the extension ships (overleaf/formats/, read by the core's
# worker when this browser has none kept): pdfLaTeX's evaluated state and
# its package loads' records, made by CORE_WASM itself, on Node, from a
# cold build of an amsmath article (test/core-run.ts --cold --store), the
# store's `format/NAME` as NAME.gzdata, `format/NAME/pkgrec` as
# NAME.pkgrec.gzdata; and NAME.packs.txt, the packs a warm build of the
# article fetched on that format (the fonts' metrics, pdftex.map: what
# every first document reads, fetched at once by the worker when the
# format is read). NAME holds the engine's identity: a format made by
# another core.wasm is never asked for, so build them together (build.sh).
# (XeLaTeX's slots in the same way once XeTeX runs in wasm.) Its packs
# from target/shelf-cache/, else Shelf (needs the network then).
#
#   scripts/make-formats.sh [CORE_WASM] [OUT_DIR]   # default: target/core's core.wasm, target/formats
set -euo pipefail
cd "$(dirname "$0")/.."
wasm=${1:-target/core/wasm32-wasip1-threads/release/core.wasm}
out=${2:-target/formats}
st=target/formats-store
rm -rf "$st" "$out"
mkdir -p "$out"
node test/core-run.ts test/scenarios/live/main.tex --cold --wasm "$wasm" --store "$st"
for f in "$st"/format%2F*; do
  k=$(basename "$f")
  k=${k#format%2F}
  gzip -9 -c "$f" > "$out/${k//%2F/.}.gzdata"
done
# (the warm build: the packs a first document needs beside the format)
node test/core-run.ts test/scenarios/live/main.tex --wasm "$wasm" --store "$st" --packs "$st/packs.txt"
name=$(cd "$out" && ls *.gzdata | grep -v pkgrec | sed 's/\.gzdata$//')
cp "$st/packs.txt" "$out/$name.packs.txt"
ls -la "$out"
