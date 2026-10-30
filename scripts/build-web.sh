#!/usr/bin/env bash
# The web frontend (web/): PhiTeX in a browser tab, nothing installed (the
# demo phitex.org serves at /try, scripts/deploy-web.sh). Its bundles
# (esbuild: the app, and the Overleaf extension's own core worker and its
# threads), the mock's editor's grammar, and the browser build's files the
# shared code reads (overleaf/: scripts/build.sh first, as for
# build-vscode.sh; PHITEX_ASSETS names another checkout's overleaf/): the
# core and latexdiff modules, the shipped formats, texmf/, the packs'
# lists, the fonts, the shims, Shelf's index, and minted's runner
# (Pyodide), fetched only when a document runs minted.
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

# (the editor's grammar, Overleaf's, generated as scripts/mock-editor.sh
# does, with its type for the editor's TypeScript)
mkdir -p web/build
cp mock/editor/tokens.mjs web/build/tokens.mjs
[ web/build/latex.mjs -nt mock/editor/latex.grammar ] || "${sandbox[@]}" node_modules/.bin/lezer-generator mock/editor/latex.grammar -o web/build/latex.mjs 2>&1 | grep -v "generating a lot\|Consider splitting" || true
echo 'export declare const parser: import("@lezer/lr").LRParser;' > web/build/latex.d.mts

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
for d in pyodide minted; do [ -d "$assets/dist/$d" ] && cp -r "$assets/dist/$d" web/dist/dist/; done
for d in texmf fonts shims packs minted; do [ -d "$assets/$d" ] && cp -r "$assets/$d" web/dist/; done
# (the formats: each engine's newest only, the one this core.wasm made; older ones a core never asks for)
mkdir -p web/dist/formats
for e in $(ls "$assets/formats" | sed -n 's/^\([a-z]*\)-.*\.gzdata$/\1/p' | sort -u); do
  stem=$(ls -t "$assets/formats/$e"-*.gzdata | grep -v '\.pkgrec\.' | head -1)
  stem=$(basename "$stem" .gzdata)
  cp "$assets/formats/$stem".* web/dist/formats/
  echo "$stem" >> web/dist/formats/list.txt
done
# (each format's first build's bundled texmf/ files, fetched ahead by the page
# (host.ts's warmFormats): recorded here, by this core on this format with this
# texmf/, from the first sample's first build (test/core-run.ts --names), so
# the list is always the one these files make; its packs from Shelf, by its
# Pages address, which every network reaches)
# (each engine's first build from the document its format was made from or
# with: pdfLaTeX the article sample, XeLaTeX make-formats.sh's fontspec one)
while read -r stem; do
  engine=${stem%%-*}
  case $engine in
    pdflatex) doc=web/samples/article.tex ;;
    xelatex) doc=test/scenarios/fontspec/main.tex ;;
    *) echo "no first build to record for $engine's format" >&2; exit 1 ;;
  esac
  st=web/build/names-store
  rm -rf "$st"
  mkdir -p "$st"
  gunzip -c "$assets/formats/$stem.gzdata" > "$st/format%2F$stem"
  gunzip -c "$assets/formats/$stem.pkgrec.gzdata" > "$st/format%2F$stem%2Fpkgrec"
  "${sandbox[@]}" --net env SHELF_URL="${SHELF_URL:-https://shelf-phitex-v1.pages.dev/tl2026/}" node test/core-run.ts "$doc" --engine "$engine" \
    --wasm web/dist/dist/core.wasm --store "$st" --texmf web/dist/texmf --names "web/dist/formats/$stem.texmf.txt" | grep '^built'
  [ -s "web/dist/formats/$stem.texmf.txt" ] || { echo "no texmf/ files recorded for $stem" >&2; exit 1; }
done < web/dist/formats/list.txt
cp "$assets"/shelf-index.tsv.gzdata "$assets"/shelf-packs.tsv.gzdata "$assets"/shelf-release.json web/dist/
cp "$assets"/LICENSE.txt "$assets"/NOTICE.txt web/dist/ 2>/dev/null || true
du -sh web/dist web/dist/* web/dist/dist/*
