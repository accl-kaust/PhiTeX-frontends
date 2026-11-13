#!/usr/bin/env bash
# The VS Code extension (apps/vscode/): its bundles (esbuild: the extension
# host's, the core's threads' entry, the webview's; and test/smoke.ts's),
# and the browser build's files the shared code reads (build/overleaf/:
# run tools/build/build.sh first): the core and latexdiff modules, the shipped
# formats, shelf/texmf/, the packs, the fonts.
#
#   tools/build/build-vscode.sh            # build/vscode/: the extension, unpacked (dist/, texmf/, ...)
#   tools/build/build-vscode.sh --package  # and build/phitex-<v>.vsix
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -s build/overleaf/dist/core.wasm ] || { echo "no build/overleaf/dist/core.wasm: tools/build/build.sh first" >&2; exit 1; }
# (the extension unpacked in build/vscode/: its manifest, README and icons
# from apps/vscode, the rest built; nothing written into apps/)
rm -rf build/vscode && mkdir -p build/vscode/dist
cp -r apps/vscode/{package.json,README.md,icon.png,media,.vscodeignore} build/vscode/

tools/sandbox bash -c 'cd apps/vscode && ../../node_modules/.bin/tsc -p .'
es=(node_modules/.bin/esbuild --bundle --log-level=warning --sourcemap=inline)
tools/sandbox "${es[@]}" apps/vscode/src/extension.ts --platform=node --format=cjs --target=node20 --external:vscode --outfile=build/vscode/dist/extension.js
tools/sandbox "${es[@]}" apps/vscode/src/thread.ts --platform=node --format=cjs --target=node20 --outfile=build/vscode/dist/thread.js
tools/sandbox "${es[@]}" apps/vscode/test/smoke.ts --platform=node --format=esm --target=node22 --external:vscode --outfile=build/vscode/dist/smoke.mjs
tools/sandbox "${es[@]}" apps/vscode/src/webview.ts --platform=browser --format=iife --target=es2022 --outfile=build/vscode/dist/webview.js

# (what the shared code reads, by the same paths as in the browser package)
for f in core.wasm diff.wasm; do
  cp build/overleaf/dist/$f build/vscode/dist/$f
done
rm -f build/vscode/dist/worker.js build/vscode/dist/assets*
rm -rf build/vscode/dist/mupdf
for d in texmf packs fonts shims formats minted; do
  rm -rf "build/vscode/$d"
  cp -r "build/overleaf/$d" "build/vscode/$d"
done
# (minted's runner: Pyodide and PhiTeX's latexminted runner, as the browser's; apps/vscode/src/core.ts)
for d in pyodide minted; do
  rm -rf "build/vscode/dist/$d"
  cp -r "build/overleaf/dist/$d" "build/vscode/dist/$d"
done
cp build/overleaf/shelf-index.tsv.gzdata build/overleaf/shelf-packs.tsv.gzdata build/overleaf/shelf-release.json build/overleaf/LICENSE.txt build/overleaf/NOTICE.txt build/vscode/

if [ "${1:-}" = --package ]; then
  # (no source maps in the package)
  for f in extension thread webview; do
    if [ $f = webview ]; then o=(--platform=browser --format=iife --target=es2022); else o=(--platform=node --format=cjs --target=node20 --external:vscode); fi
    tools/sandbox node_modules/.bin/esbuild --bundle --log-level=warning apps/vscode/src/$f.ts "${o[@]}" --outfile=build/vscode/dist/$f.js
  done
  tools/sandbox --net bash -c 'cd build/vscode && npx --yes @vscode/vsce@3 package --no-dependencies --allow-missing-repository --out ../'
fi
du -sh build/vscode/dist build/vscode/texmf build/vscode/packs build/vscode/fonts 2>/dev/null
