#!/usr/bin/env bash
# The formats shipped, checked against every core shipped with them: each
# format (FORMATS_DIR/NAME.gzdata, its pkgrec) put back in a store as the
# hosts' store keeps it, and a warm build of make-formats.sh's document by
# each core (test/core-run.ts --warm). A core that does not use the format
# makes it again in the user's browser, fetching every language's
# hyphenation patterns, for tens of seconds: the build stops here instead.
#
#   scripts/build/check-formats.sh FORMATS_DIR CORE_WASM [CORE1_WASM]
set -euo pipefail
cd "$(dirname "$0")/../.."
formats=$1
shift
doc() { case $1 in pdflatex) echo test/scenarios/live/main.tex ;; xelatex) echo test/scenarios/fontspec/main.tex ;; esac; }
n=0
for f in "$formats"/*.gzdata; do
  name=$(basename "$f" .gzdata)
  [[ $name == *.pkgrec ]] && continue
  engine=${name%%-*}
  [ -n "$(doc "$engine")" ] || { echo "check-formats: no document for $engine ($name)" >&2; exit 1; }
  for wasm in "$@"; do
    st=target/check-formats-store
    rm -rf "$st" && mkdir -p "$st"
    gunzip -c "$f" > "$st/format%2F$name"
    gunzip -c "$formats/$name.pkgrec.gzdata" > "$st/format%2F$name%2Fpkgrec"
    single=()
    [[ $wasm == *wasm32-wasip1/* || $(basename "$wasm") == core1.wasm ]] && single=(--single)
    echo "check-formats: $name with $wasm"
    node test/core-run.ts "$(doc "$engine")" --engine "$engine" --wasm "$wasm" "${single[@]}" --store "$st" --warm
    n=$((n + 1))
  done
done
[ "$n" -gt 0 ] || { echo "check-formats: no format in $formats" >&2; exit 1; }
echo "check-formats: $n warm builds, each on its shipped format"
