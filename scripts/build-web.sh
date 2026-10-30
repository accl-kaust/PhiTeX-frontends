#!/usr/bin/env bash
# The web frontend (web/): PhiTeX in a browser tab, nothing installed (the
# demo phitex.org serves at /try, scripts/deploy-web.sh). Its bundles
# (esbuild: the app, and the Overleaf extension's own core worker and its
# threads), the mock's editor's grammar, and the browser build's files the
# shared code reads (overleaf/: scripts/build.sh first, as for
# build-vscode.sh; PHITEX_ASSETS names another checkout's overleaf/): the
# core and latexdiff modules, the shipped formats, texmf/, the packs'
# lists, the fonts, the shims, Shelf's index. Not minted (Pyodide: too big
# for a demo; a \write18 is refused).
#
#   scripts/build-web.sh     # web/dist/
#
# Served under COOP same-origin and COEP credentialless (the core's threads
# share one memory): phitex.org's _headers, web/test/serve.mjs.
set -euo pipefail
cd "$(dirname "$0")/.."
assets="${PHITEX_ASSETS:-overleaf}"
[ -s "$assets/dist/core.wasm" ] || { echo "no $assets/dist/core.wasm: scripts/build.sh first (or PHITEX_ASSETS=<a checkout's overleaf/>)" >&2; exit 1; }
sandbox=(/home/lambda/.local/bin/bw)
[ -x "${sandbox[0]}" ] || sandbox=(scripts/sandbox)

# (the editor's grammar, as scripts/mock-editor.sh makes it)
mkdir -p mock/build
cp mock/editor/tokens.mjs mock/build/tokens.mjs
[ mock/build/latex.mjs -nt mock/editor/latex.grammar ] || "${sandbox[@]}" node_modules/.bin/lezer-generator mock/editor/latex.grammar -o mock/build/latex.mjs

"${sandbox[@]}" node_modules/.bin/tsc -p web
rm -rf web/dist
mkdir -p web/dist/dist
es=(node_modules/.bin/esbuild --bundle --minify --log-level=warning --platform=browser --format=esm --target=es2022)
"${sandbox[@]}" "${es[@]}" web/src/main.ts --loader:.tex=text --outfile=web/dist/dist/web.js
"${sandbox[@]}" "${es[@]}" overleaf/src/worker.ts --outfile=web/dist/dist/worker.js
"${sandbox[@]}" "${es[@]}" overleaf/src/thread.ts --outfile=web/dist/dist/thread.js
# (a page imports web.js (mount); the bundles sit in dist/, the platform's root one up, as in the extension)
echo 'export * from "./dist/web.js";' > web/dist/web.js
cp web/index.html web/dist/

for f in core.wasm diff.wasm; do cp "$assets/dist/$f" web/dist/dist/; done
for d in texmf formats fonts shims packs; do cp -r "$assets/$d" web/dist/; done
cp "$assets"/shelf-index.tsv.gzdata "$assets"/shelf-packs.tsv.gzdata "$assets"/shelf-release.json web/dist/
cp "$assets"/LICENSE.txt "$assets"/NOTICE.txt web/dist/ 2>/dev/null || true
du -sh web/dist web/dist/* web/dist/dist/*
