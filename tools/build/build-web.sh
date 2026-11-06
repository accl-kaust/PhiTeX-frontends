#!/usr/bin/env bash
# The web frontend (apps/web/): PhiTeX in a browser tab, nothing installed (the
# demo at demo.phitex.org: tools/build/deploy-web.sh, or CI's deploy-demo.yml). Its bundles
# (esbuild: the app, and the Overleaf extension's own core worker and its
# threads), the mock's editor's grammar, and the browser build's files the
# shared code reads (build/overleaf/: tools/build/build.sh first, as for
# build-vscode.sh; PHITEX_ASSETS names another checkout's build/overleaf/): the
# core and latexdiff modules, the shipped formats, shelf/texmf/, the packs'
# lists, the fonts, the shims, Shelf's index, and minted's runner
# (Pyodide), fetched only when a document runs minted.
#
#   tools/build/build-web.sh     # build/web/
#
# Served under COOP same-origin and COEP credentialless (the core's threads
# share one memory): phitex.org's _headers, apps/web/test/serve.mjs.
set -euo pipefail
cd "$(dirname "$0")/../.."
assets="${PHITEX_ASSETS:-build/overleaf}"
[ -s "$assets/dist/core.wasm" ] || { echo "no $assets/dist/core.wasm: tools/build/build.sh first (or PHITEX_ASSETS=<a checkout's build/overleaf/>)" >&2; exit 1; }
sandbox=(/home/lambda/.local/bin/bw)
[ -x "${sandbox[0]}" ] || sandbox=(tools/sandbox)

# (the editor's grammar, Overleaf's, generated as tools/build/mock-editor.sh
# does, with its type for the editor's TypeScript)
mkdir -p apps/web/build
cp tools/mock/editor/tokens.mjs apps/web/build/tokens.mjs
[ apps/web/build/latex.mjs -nt tools/mock/editor/latex.grammar ] || "${sandbox[@]}" node_modules/.bin/lezer-generator tools/mock/editor/latex.grammar -o apps/web/build/latex.mjs 2>&1 | grep -v "generating a lot\|Consider splitting" || true
echo 'export declare const parser: import("@lezer/lr").LRParser;' > apps/web/build/latex.d.mts

"${sandbox[@]}" node_modules/.bin/tsc -p apps/web
rm -rf build/web
mkdir -p build/web/dist
es=(node_modules/.bin/esbuild --bundle --minify --log-level=warning --platform=browser --format=esm --target=es2022)
"${sandbox[@]}" "${es[@]}" apps/web/src/main.ts --loader:.tex=text --loader:.bib=text --loader:.pdf=binary --outfile=build/web/dist/web.js
"${sandbox[@]}" "${es[@]}" apps/overleaf/src/worker.ts --outfile=build/web/dist/worker.js
"${sandbox[@]}" "${es[@]}" apps/overleaf/src/thread.ts --outfile=build/web/dist/thread.js
# (a page imports web.js (mount); the bundles sit in dist/, the platform's root one up, as in the extension)
echo 'export * from "./dist/web.js";' > build/web/web.js
cp apps/web/index.html apps/web/static/* build/web/
# (demo.phitex.org's headers, Cloudflare Pages: the page cross-origin isolated, its threads share one
# memory; credentialless keeps Shelf's packs (CORS) loading. The formats' names change with
# their contents (immutable); the rest is asked again each visit (an ETag's 304 when unchanged))
cat > build/web/_headers <<'HEADERS'
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
  X-Content-Type-Options: nosniff
/formats/*
  Cache-Control: public, max-age=31536000, immutable
HEADERS

for f in core.wasm diff.wasm; do cp "$assets/dist/$f" build/web/dist/; done
for d in pyodide minted; do [ -d "$assets/dist/$d" ] && cp -r "$assets/dist/$d" build/web/dist/; done
for d in texmf fonts shims packs minted; do [ -d "$assets/$d" ] && cp -r "$assets/$d" build/web/; done
# (the formats: each engine's newest only, the one this core.wasm made; older ones a core never asks for)
mkdir -p build/web/formats
for e in $(ls "$assets/formats" | sed -n 's/^\([a-z]*\)-.*\.gzdata$/\1/p' | sort -u); do
  stem=$(ls -t "$assets/formats/$e"-*.gzdata | grep -v '\.pkgrec\.' | head -1)
  stem=$(basename "$stem" .gzdata)
  cp "$assets/formats/$stem".* build/web/formats/
  echo "$stem" >> build/web/formats/list.txt
done
# (each format's first build's bundled shelf/texmf/ files, fetched ahead by the page
# (host.ts's warmFormats): recorded here, by this core on this format with this
# shelf/texmf/, from the first sample's first build (test/harness/core-run.ts --names), so
# the list is always the one these files make; its packs from Shelf, by its
# Pages address, which every network reaches)
# (each engine's first build from the document its format was made from or
# with: pdfLaTeX the article sample, XeLaTeX make-formats.sh's fontspec one)
while read -r stem; do
  engine=${stem%%-*}
  case $engine in
    pdflatex) doc=apps/web/samples/article/main.tex ;;
    xelatex) doc=test/scenarios/fontspec/main.tex ;;
    *) echo "no first build to record for $engine's format" >&2; exit 1 ;;
  esac
  st=apps/web/build/names-store
  rm -rf "$st"
  mkdir -p "$st"
  gunzip -c "$assets/formats/$stem.gzdata" > "$st/format%2F$stem"
  gunzip -c "$assets/formats/$stem.pkgrec.gzdata" > "$st/format%2F$stem%2Fpkgrec"
  "${sandbox[@]}" --net env SHELF_URL="${SHELF_URL:-https://shelf-phitex-v1.pages.dev/tl2026/}" node test/harness/core-run.ts "$doc" --engine "$engine" \
    --wasm build/web/dist/core.wasm --store "$st" --texmf build/web/texmf --names "build/web/formats/$stem.texmf.txt" | grep '^built'
  [ -s "build/web/formats/$stem.texmf.txt" ] || { echo "no shelf/texmf/ files recorded for $stem" >&2; exit 1; }
done < build/web/formats/list.txt
cp "$assets"/shelf-index.tsv.gzdata "$assets"/shelf-packs.tsv.gzdata "$assets"/shelf-release.json build/web/
cp "$assets"/LICENSE.txt "$assets"/NOTICE.txt build/web/ 2>/dev/null || true
du -sh build/web build/web/* build/web/dist/*
