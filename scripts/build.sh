#!/usr/bin/env bash
# Build the browser extension into overleaf/ (load that directory unpacked):
# its TypeScript (overleaf/src, and common/src through overleaf/src/common)
# to overleaf/dist, the engine and its assets beside it.
#
#   scripts/build.sh          # release
#   scripts/build.sh --dev    # also match the local mock (http://localhost:<any port>/project/*)
#
# The wasm core: core/ (PhiTeX's live document, phitex-live) for
# wasm32-wasip1-threads, a WASI reactor whose threads are the browser's
# workers on one shared memory (common/src/wasm/); cargo in the sandbox
# (PhiTeX read-only), its target directory inside this repo; with it, the
# formats it ships (scripts/make-formats.sh: pdfLaTeX's, made by that very
# core.wasm). PHITEX_WASM_DIR: a directory with core.wasm, diff.wasm and
# formats/ built elsewhere (a build machine's, together), copied instead.
set -euo pipefail
cd "$(dirname "$0")/.."

# (the slow part first, the engine and its formats, into target/: an
# extension loaded from overleaf/ keeps working until they're copied in)
if [ -n "${PHITEX_WASM_DIR:-}" ]; then
  core="$PHITEX_WASM_DIR/core.wasm" diff="$PHITEX_WASM_DIR/diff.wasm" formats="$PHITEX_WASM_DIR/formats"
else
  # (a reactor binary: its `_initialize` run once by thread 0; the memory,
  # stack and exports are core/build.rs's. SIMD on: hayro, vello_cpu and
  # zlib take their scalar paths without it; every browser the extension
  # runs in, and Node, has wasm SIMD)
  (cd core && CARGO_TARGET_DIR="$PWD/../target/core" ../scripts/sandbox env CARGO_TARGET_WASM32_WASIP1_THREADS_RUSTFLAGS="-Zwasi-exec-model=reactor -C target-feature=+simd128" \
    cargo build --release --target wasm32-wasip1-threads)
  core=target/core/wasm32-wasip1-threads/release/core.wasm
  # (its formats, made by it: a first open reads pdfLaTeX's instead of building it)
  scripts/sandbox --net scripts/make-formats.sh "$core" target/formats
  formats=target/formats
  # PhiTeX's latexdiff (phitex-diff) as its own small wasm module, for the
  # compare: diff-wasm/, on phitex/'s phitex-diff
  (cd diff-wasm && CARGO_TARGET_DIR="$PWD/target" ../scripts/sandbox cargo build --release --target wasm32-unknown-unknown)
  diff=diff-wasm/target/wasm32-unknown-unknown/release/phitex_diff_wasm.wasm
fi
rm -rf overleaf/dist overleaf/formats && mkdir -p overleaf/dist overleaf/formats
cp "$core" overleaf/dist/core.wasm
cp "$diff" overleaf/dist/diff.wasm
cp "$formats"/* overleaf/formats/
# (the full license, shipped in the extension, where its links point)
# (packs/: the list fetched ahead, and any Shelf packs shipped: data/bundled-packs.txt, none now)
scripts/bundle-packs.sh
cp LICENSE overleaf/LICENSE.txt
cp NOTICE overleaf/NOTICE.txt
# The bundled packages (scripts/fetch-texmf.sh), flat by name: shelf.ts reads
# them before asking Shelf.
rm -rf overleaf/texmf && cp -r texmf overleaf/texmf
# Shelf's index (texmf path -> pack), its pack table (each pack's SHA-256
# and size) and its release.json (how names
# resolve per engine), made by Shelf's release.py: scripts/shelf-index.sh
# (named .gzdata: Edge's store refuses archives inside a package)
# (SHELF_INDEX, SHELF_PACKS, SHELF_RELEASE: another release's, a local Shelf's for a --dev build)
cp "${SHELF_INDEX:-shelf-index.tsv.gz}" overleaf/shelf-index.tsv.gzdata
cp "${SHELF_RELEASE:-shelf-release.json}" overleaf/shelf-release.json
cp "${SHELF_PACKS:-shelf-packs.tsv.gz}" overleaf/shelf-packs.tsv.gzdata
# The extension's TypeScript, as the modules it loads (dist/: the content
# script's, the offscreen document's, the core's worker and its threads')
scripts/sandbox npx tsc -p overleaf
# The dashboard's content scripts, the folders (overleaf/src/folders/, in the
# page's world) and their settings bridge (dashboard.ts): a content script
# is a classic script, so each one bundle, not the modules tsc made of them
scripts/sandbox node_modules/.bin/esbuild overleaf/src/folders/main.ts --bundle --log-level=warning --format=iife --target=chrome116 --outfile=overleaf/dist/folders.js
scripts/sandbox node_modules/.bin/esbuild overleaf/src/dashboard.ts --bundle --log-level=warning --format=iife --target=chrome116 --outfile=overleaf/dist/dashboard.js --allow-overwrite
rm -rf overleaf/dist/folders
# Latin Modern (GUST Font License), the fonts the pages are drawn in (page2.ts):
# common/fonts (kept up to date from TeX Live here; CI, which has none, takes
# them as committed), and the XeLaTeX stand-ins (common/shims, engines.ts),
# each frontend's copy
lm=/usr/share/texmf-dist/fonts/opentype/public
[ -n "${CI:-}" ] || cp $lm/lm/lmroman10-{regular,bold,italic,bolditalic}.otf $lm/lm/lmmono10-regular.otf $lm/lm-math/latinmodern-math.otf common/fonts/
rm -rf overleaf/fonts overleaf/shims && cp -r common/fonts common/shims overleaf/
rm -rf overleaf/dist/mupdf
# minted: Pyodide (Python in wasm), the engine's latexminted runner, and TeX
# Live's four wheels (latexminted, latexrestricted, latex2pydata, Pygments;
# MINTED_WHEELS: another directory of them, CI's from the prebuilt core);
# bundled, loaded by the core's worker at a project's first \write18
mkdir -p overleaf/dist/pyodide overleaf/dist/minted overleaf/minted
cp node_modules/pyodide/{pyodide.mjs,pyodide.asm.mjs,pyodide.asm.wasm,pyodide-lock.json,package.json} overleaf/dist/pyodide/
# (.data, not .zip or .whl: Edge's store refuses archives inside a package)
cp node_modules/pyodide/python_stdlib.zip overleaf/dist/pyodide/python_stdlib.data
rm -f overleaf/minted/*.whl
cp phitex/tools/minted-pyodide/runner.mjs overleaf/dist/minted/
: > overleaf/minted/wheels.txt
wheels=(${MINTED_WHEELS:-/usr/share/texmf-dist/scripts/minted}/*.whl)
[ -e "${wheels[0]}" ] || { echo "no minted wheels in ${MINTED_WHEELS:-/usr/share/texmf-dist/scripts/minted}" >&2; exit 1; }
for w in "${wheels[@]}"; do cp "$w" "overleaf/minted/$(basename "$w").data"; basename "$w" >> overleaf/minted/wheels.txt; done
echo "minted: $(du -sh overleaf/dist/pyodide | cut -f1) Pyodide, $(wc -l < overleaf/minted/wheels.txt) wheels"

# The manifest: manifest.base.json, plus (--dev) the local mock's origin.
dev=false; for a in "$@"; do [ "$a" = "--dev" ] && dev=true; done
# (the engine's commit, the phitex/ submodule's, as version_name: debug reports name it)
engine=$(git -C phitex rev-parse --short HEAD)
scripts/sandbox node -e '
  const fs = require("fs"), m = JSON.parse(fs.readFileSync("overleaf/manifest.base.json"));
  m.version_name = `${m.version_name ?? m.version} (engine ${process.argv[2]})`;
  if (process.argv[1] === "true") {
    for (const c of m.content_scripts) c.matches.push("http://localhost/project/*");
    m.web_accessible_resources[0].matches.push("http://localhost/*");
  }
  fs.writeFileSync("overleaf/manifest.json", JSON.stringify(m, null, 2) + "\n");' "$dev" "$engine"
# (SHELF_LOCAL=1 with --dev: Shelf from a local server,
# ../shelf.PhiTeX.org/serve.py, serving a release's h/ packs, with
# SHELF_INDEX that release's index; else the live Shelf, whose index
# shelf-index.tsv.gz is)
$dev && [ "${SHELF_LOCAL:-}" = 1 ] && sed -i 's|https://shelf-phitex.pages.dev/|http://localhost:8124/|' overleaf/dist/common/shelf.js
# Every module the content script imports must be web-accessible.
scripts/sandbox node -e '
  const fs = require("fs"), m = JSON.parse(fs.readFileSync("overleaf/manifest.json"));
  const listed = new Set(m.web_accessible_resources.flatMap((w) => w.resources));
  const seen = new Set(), todo = ["dist/content-main.js"];
  while (todo.length) {
    const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
    for (const [, dep] of fs.readFileSync("overleaf/" + f, "utf8").matchAll(/^import (?:[^;]*? from )?"(\.\.?\/[^"]+)";/gm)) todo.push(require("path").posix.join(require("path").posix.dirname(f), dep));
  }
  const glob = (p) => [...listed].some((l) => l === p || (l.endsWith("/*.js") && p.startsWith(l.slice(0, -4)) && !p.slice(l.length - 4).includes("/")));
  const missing = [...seen].filter((f) => !glob(f));
  if (missing.length) { console.error("not in web_accessible_resources:", missing.join(" ")); process.exit(1); }'
ls -la overleaf/dist/core.wasm
