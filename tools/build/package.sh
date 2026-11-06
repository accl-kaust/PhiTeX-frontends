#!/usr/bin/env bash
# The store uploads: a release build of the browser extension (build/overleaf/), zipped.
#   tools/build/package.sh        → build/phitex-instant-<version>.zip (Chrome Web Store, Edge Add-ons)
#                                     build/phitex-instant-<version>-firefox.zip (Firefox Add-ons)
# (Firefox's extension pages have no shared memory: its package runs the
# single-threaded core, dist/core1.wasm, on its background page, firefox-bg.html)
# Checks: the release manifest (no localhost), only what the extension
# runs (no sources, tests or maps), the wasm core and the license in.
set -euo pipefail
cd "$(dirname "$0")/../.."
# (each step said as it begins: what the build is doing now)
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
tools/build/build.sh
step "Packaging the browser extension (store/)"
version=$(tools/sandbox node -p 'require("./build/overleaf/manifest.json").version')
out="build/phitex-instant-$version.zip"
mkdir -p build
rm -f "$out"

if grep -q localhost build/overleaf/manifest.json; then echo "manifest has localhost: not a release build" >&2; exit 1; fi
files=(manifest.json popup.html offscreen.html LICENSE.txt NOTICE.txt icons fonts shims dist texmf packs minted formats shelf-index.tsv.gzdata shelf-packs.tsv.gzdata shelf-release.json)
for f in "${files[@]}"; do [ -e "build/overleaf/$f" ] || { echo "missing build/overleaf/$f" >&2; exit 1; }; done
[ -s build/overleaf/dist/core.wasm ] || { echo "no core.wasm" >&2; exit 1; }
ls build/overleaf/formats/pdflatex-*.gzdata > /dev/null 2>&1 || { echo "no pdfLaTeX format in build/overleaf/formats (tools/build/make-formats.sh)" >&2; exit 1; }
[ -s build/overleaf/texmf/names.txt ] || { echo "no shelf/texmf/ (tools/build/fetch-texmf.sh)" >&2; exit 1; }
[ -s build/overleaf/shelf-index.tsv.gzdata ] || { echo "no shelf-index.tsv.gzdata (tools/build/shelf-index.sh, then build.sh)" >&2; exit 1; }
# (Edge refuses a package that holds archives)
if find build/overleaf/dist build/overleaf/minted build/overleaf/packs build/overleaf/texmf -name "*.zip" -o -name "*.gz" -o -name "*.whl" -o -name "*.tgz" | grep -q .; then echo "an archive in the package (Edge refuses it)" >&2; exit 1; fi
if grep -q localhost build/overleaf/dist/common/shelf.js; then echo "shelf.js points at localhost: not a release build" >&2; exit 1; fi
if find build/overleaf/dist -name '*.map' | grep -q .; then echo "source maps in dist" >&2; exit 1; fi

# (Firefox's core and its worker are Firefox's package's only)
(cd build/overleaf && scripts_zip=1 zip -q -r -X "../../$out" "${files[@]}" -x dist/core1.wasm dist/worker1.js)
echo "$out ($(du -h "$out" | cut -f1))"

unzip -l "$out" | tail -n +4 | head -n -2 | awk '{print "  " $4}'

step "Packaging for Firefox (build/firefox/)"
fx="build/phitex-instant-$version-firefox.zip" stage=build/firefox
rm -rf "$stage" "$fx" && mkdir -p "$stage"
[ -s build/overleaf/dist/core1.wasm ] || { echo "no core1.wasm (the single-threaded core: tools/build/build.sh)" >&2; exit 1; }
# (the threaded core and its threads and the offscreen page out: no shared
# memory there; the formats in, which the single-threaded core reads too:
# check-formats.sh)
for f in "${files[@]}" firefox-bg.html; do case $f in offscreen.html) ;; *) cp -r "build/overleaf/$f" "$stage/" ;; esac; done
[ -s "$stage/formats/names.txt" ] || { echo "the Firefox package has no formats (formats/names.txt): a first open would make one in the browser" >&2; exit 1; }
rm -rf "$stage"/dist/{core.wasm,worker.js,thread.js}
tools/sandbox node -e '
  const fs = require("fs"), f = process.argv[1] + "/manifest.json", m = JSON.parse(fs.readFileSync(f));
  // (in Firefox an MV3 background is a page: the core runs there, offscreen.ts in it)
  m.background = { page: "firefox-bg.html" };
  m.permissions = m.permissions.filter((p) => p !== "offscreen");
  // (Chrome-only keys: Firefox warns at each one; version_name too)
  for (const k of ["minimum_chrome_version", "cross_origin_embedder_policy", "cross_origin_opener_policy", "version_name"]) delete m[k];
  // (128: content scripts in the page world; nothing collected, as AMO asks it said)
  m.browser_specific_settings = { gecko: { id: "phitex-instant@phitex.org", strict_min_version: "128.0", data_collection_permissions: { required: ["none"] } } };
  fs.writeFileSync(f, JSON.stringify(m, null, 2) + "\n");' "$stage"
(cd "$stage" && zip -q -r -X "../$(basename "$fx")" .)
echo "$fx ($(du -h "$fx" | cut -f1))"

# (the web frontend from the same build: demo.phitex.org, tools/build/deploy-web.sh)
step "Building the web demo (build/web)"
tools/build/build-web.sh > /dev/null
echo "build/web ($(du -sh build/web | cut -f1))"
