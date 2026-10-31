#!/usr/bin/env bash
# The store uploads: a release build of the browser extension (overleaf/), zipped.
#   scripts/build/package.sh        → build/phitex-instant-<version>.zip (Chrome Web Store, Edge Add-ons)
# (Firefox: none for now; the core runs on threads, workers on shared memory,
# which Firefox's extension pages don't give it: its single-threaded build
# is still to come)
# Checks: the release manifest (no localhost), only what the extension
# runs (no sources, tests or maps), the wasm core and the license in.
set -euo pipefail
cd "$(dirname "$0")/../.."
# (each step said as it begins: what the build is doing now)
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
scripts/build/build.sh
step "Packaging the browser extension (store/)"
version=$(scripts/sandbox node -p 'require("./overleaf/manifest.json").version')
out="build/phitex-instant-$version.zip"
mkdir -p build
rm -f "$out"

if grep -q localhost overleaf/manifest.json; then echo "manifest has localhost: not a release build" >&2; exit 1; fi
files=(manifest.json popup.html offscreen.html LICENSE.txt NOTICE.txt icons fonts shims dist texmf packs minted formats shelf-index.tsv.gzdata shelf-packs.tsv.gzdata shelf-release.json)
for f in "${files[@]}"; do [ -e "overleaf/$f" ] || { echo "missing overleaf/$f" >&2; exit 1; }; done
[ -s overleaf/dist/core.wasm ] || { echo "no core.wasm" >&2; exit 1; }
ls overleaf/formats/pdflatex-*.gzdata > /dev/null 2>&1 || { echo "no pdfLaTeX format in overleaf/formats (scripts/build/make-formats.sh)" >&2; exit 1; }
[ -s overleaf/texmf/names.txt ] || { echo "no texmf/ (scripts/build/fetch-texmf.sh)" >&2; exit 1; }
[ -s overleaf/shelf-index.tsv.gzdata ] || { echo "no shelf-index.tsv.gzdata (scripts/build/shelf-index.sh, then build.sh)" >&2; exit 1; }
# (Edge refuses a package that holds archives)
if find overleaf/dist overleaf/minted overleaf/packs overleaf/texmf -name "*.zip" -o -name "*.gz" -o -name "*.whl" -o -name "*.tgz" | grep -q .; then echo "an archive in the package (Edge refuses it)" >&2; exit 1; fi
if grep -q localhost overleaf/dist/common/shelf.js; then echo "shelf.js points at localhost: not a release build" >&2; exit 1; fi
if find overleaf/dist -name '*.map' | grep -q .; then echo "source maps in dist" >&2; exit 1; fi

(cd overleaf && scripts_zip=1 zip -q -r -X "../$out" "${files[@]}")
echo "$out ($(du -h "$out" | cut -f1))"

unzip -l "$out" | tail -n +4 | head -n -2 | awk '{print "  " $4}'

# (the web frontend from the same build: demo.phitex.org, scripts/build/deploy-web.sh)
step "Building the web demo (build/web)"
scripts/build/build-web.sh > /dev/null
echo "build/web ($(du -sh build/web | cut -f1))"
