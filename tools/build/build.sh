#!/usr/bin/env bash
# Build the browser extension into build/overleaf/ (load that directory
# unpacked): its sources (apps/overleaf: src/, and common/src through
# apps/overleaf/src/common; its pages, icons and manifest.base.json) to
# build/overleaf/dist and beside it, the engine and its assets with them.
# Nothing is written into apps/.
#
#   tools/build/build.sh          # release
#   tools/build/build.sh --dev    # also match the local mock (http://localhost:<any port>/project/*)
#
# The engine is PhiTeX's (the phitex/ submodule): crates/wasm/live built by
# its scripts/wasm-live.sh into target/wasm-live, core.wasm (threaded, the
# browser's workers on one shared memory: common/src/wasm/), core1.wasm
# (Firefox's, one thread) and diff.wasm (Compare's latexdiff); cargo in the
# sandbox, PhiTeX read-only. PHITEX_WASM_DIR: a directory with those three
# built elsewhere (a build machine's), taken instead. The formats are made
# here by that very core (make-formats.sh) unless the directory has
# formats/ beside them, and checked against both cores either way.
set -euo pipefail
cd "$(dirname "$0")/../.."
# (each step said as it begins: what the build is doing now)
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# (the slow part first, the engine and its formats, into target/: an
# extension loaded from build/overleaf/ keeps working until they're copied in)
wasm=${PHITEX_WASM_DIR:-}
if [ -z "$wasm" ]; then
  # (the toolchain phitex/rust-toolchain.toml pins, with its wasm targets,
  # installed here once: rustup writes ~/.rustup, read-only in the sandbox)
  step "Rust toolchain (phitex/rust-toolchain.toml)"
  (cd phitex && rustup toolchain install)
  step "The wasm cores and latexdiff (phitex/scripts/wasm-live.sh)"
  wasm=target/wasm-live
  tools/sandbox env CARGO_TARGET_DIR="$PWD/target/phitex-wasm" phitex/scripts/wasm-live.sh "$PWD/$wasm"
fi
core="$wasm/core.wasm" core1="$wasm/core1.wasm" diff="$wasm/diff.wasm"
# (the index the formats are made on, and the extension ships: Shelf's current release)
step "Shelf's release (tools/build/check-shelf.sh)"
tools/sandbox --net tools/build/check-shelf.sh
if [ -d "$wasm/formats" ]; then
  formats="$wasm/formats"
else
  # (its formats, made by it: a first open reads pdfLaTeX's instead of building it)
  step "Making the formats (pdfLaTeX, XeLaTeX) with that core"
  tools/sandbox --net tools/build/make-formats.sh "$core" target/formats
  formats=target/formats
fi
# (each core on the formats it ships with, before anything is replaced: a
# core that would make its format again in the browser stops the build)
step "Checking the formats against both cores"
tools/sandbox --net tools/build/check-formats.sh "$formats" "$core" "$core1"
rm -rf build/overleaf && mkdir -p build/overleaf/dist build/overleaf/formats
# (the extension's own files, as they are: its pages and icons)
cp -r apps/overleaf/{popup.html,engine.html,firefox-bg.html,icons} build/overleaf/
cp "$core" build/overleaf/dist/core.wasm
cp "$core1" build/overleaf/dist/core1.wasm
cp "$diff" build/overleaf/dist/diff.wasm
cp "$formats"/* build/overleaf/formats/
# (their names: Firefox's worker reads them before its core starts, worker1.ts)
(cd build/overleaf/formats && ls -- *.gzdata | grep -v '\.pkgrec\.gzdata$' | sed 's/\.gzdata$//') > build/overleaf/formats/names.txt
# (the full license, shipped in the extension, where its links point)
# (packs/: the list fetched ahead, and any Shelf packs shipped: shelf/data/bundled-packs.txt, none now)
step "The extension's files (packs, shelf/texmf/, Shelf's index)"
tools/build/bundle-packs.sh
cp LICENSE build/overleaf/LICENSE.txt
cp NOTICE build/overleaf/NOTICE.txt
# The bundled packages (tools/build/fetch-texmf.sh), flat by name: shelf.ts reads
# them before asking Shelf.
rm -rf build/overleaf/texmf && cp -r shelf/texmf build/overleaf/texmf
# Shelf's index (texmf path -> pack), its pack table (each pack's SHA-256
# and size) and its release.json (how names
# resolve per engine), made by Shelf's release.py: tools/build/shelf-index.sh
# (named .gzdata: Edge's store refuses archives inside a package)
# (SHELF_INDEX, SHELF_PACKS, SHELF_RELEASE: another release's, a local Shelf's for a --dev build)
cp "${SHELF_INDEX:-shelf/shelf-index.tsv.gz}" build/overleaf/shelf-index.tsv.gzdata
cp "${SHELF_RELEASE:-shelf/shelf-release.json}" build/overleaf/shelf-release.json
cp "${SHELF_PACKS:-shelf/shelf-packs.tsv.gz}" build/overleaf/shelf-packs.tsv.gzdata
# The extension's TypeScript, as the modules it loads (dist/: the content
# script's, the engine iframe's, the core's worker)
step "The extension's TypeScript (apps/overleaf/ to build/overleaf/)"
tools/sandbox npx tsc -p apps/overleaf --outDir build/overleaf/dist
# The dashboard's content scripts, the folders (apps/overleaf/src/folders/, in the
# page's world) and their settings bridge (dashboard.ts): a content script
# is a classic script, so each one bundle, not the modules tsc made of them
tools/sandbox node_modules/.bin/esbuild apps/overleaf/src/folders/main.ts --bundle --log-level=warning --format=iife --target=chrome116 --outfile=build/overleaf/dist/folders.js
tools/sandbox node_modules/.bin/esbuild apps/overleaf/src/dashboard.ts --bundle --log-level=warning --format=iife --target=chrome116 --outfile=build/overleaf/dist/dashboard.js --allow-overwrite
rm -rf build/overleaf/dist/folders
# The core's worker, one module (engine.ts starts it from a blob of its text:
# Chrome loads no extension script into a worker of an iframe in a web page),
# minted's runner and Pyodide's modules in it (pyodide.ts: it can import
# nothing at run time); Pyodide's Node-only imports left as they are
tools/sandbox node_modules/.bin/esbuild apps/overleaf/src/worker1.ts --bundle --log-level=warning --format=esm --target=chrome116 --alias:phitex-minted-runner=./phitex/tools/minted-pyodide/runner.mjs '--external:node:*' --external:ws --outfile=build/overleaf/dist/engine-worker.js
# (and Pyodide's eval and computed import() in it made to throw: tools/build/no-eval.mjs)
tools/sandbox node tools/build/no-eval.mjs build/overleaf/dist/engine-worker.js
step "Fonts and minted (Pyodide)"
# Latin Modern (GUST Font License), the fonts the pages are drawn in (page2.ts):
# common/fonts (kept up to date from TeX Live here; CI, which has none, takes
# them as committed), and the XeLaTeX stand-ins (common/shims, engines.ts),
# each frontend's copy
lm=/usr/share/texmf-dist/fonts/opentype/public
[ -n "${CI:-}" ] || cp $lm/lm/lmroman10-{regular,bold,italic,bolditalic}.otf $lm/lm/lmmono10-regular.otf $lm/lm-math/latinmodern-math.otf common/fonts/
rm -rf build/overleaf/fonts build/overleaf/shims && cp -r common/fonts common/shims build/overleaf/
rm -rf build/overleaf/dist/mupdf
# minted: Pyodide (Python in wasm), the engine's latexminted runner, and TeX
# Live's four wheels (latexminted, latexrestricted, latex2pydata, Pygments;
# MINTED_WHEELS: another directory of them, CI's from the prebuilt core);
# bundled, loaded by the core's worker at a project's first \write18
mkdir -p build/overleaf/dist/pyodide build/overleaf/dist/minted build/overleaf/minted
cp node_modules/pyodide/{pyodide.mjs,pyodide.asm.mjs,pyodide.asm.wasm,pyodide-lock.json,package.json} build/overleaf/dist/pyodide/
# (.data, not .zip or .whl: Edge's store refuses archives inside a package)
cp node_modules/pyodide/python_stdlib.zip build/overleaf/dist/pyodide/python_stdlib.data
rm -f build/overleaf/minted/*.whl
cp phitex/tools/minted-pyodide/runner.mjs build/overleaf/dist/minted/
: > build/overleaf/minted/wheels.txt
wheels=(${MINTED_WHEELS:-/usr/share/texmf-dist/scripts/minted}/*.whl)
[ -e "${wheels[0]}" ] || { echo "no minted wheels in ${MINTED_WHEELS:-/usr/share/texmf-dist/scripts/minted}" >&2; exit 1; }
for w in "${wheels[@]}"; do cp "$w" "build/overleaf/minted/$(basename "$w").data"; basename "$w" >> build/overleaf/minted/wheels.txt; done
echo "minted: $(du -sh build/overleaf/dist/pyodide | cut -f1) Pyodide, $(wc -l < build/overleaf/minted/wheels.txt) wheels"

step "The manifest"
# The manifest: manifest.base.json, plus (--dev) the local mock's origin.
dev=false; for a in "$@"; do [ "$a" = "--dev" ] && dev=true; done
# (the engine's commit, the phitex/ submodule's, as version_name: debug reports name it)
engine=$(git -C phitex rev-parse --short HEAD)
tools/sandbox node -e '
  const fs = require("fs"), m = JSON.parse(fs.readFileSync("apps/overleaf/manifest.base.json"));
  m.version_name = `${m.version_name ?? m.version} (engine ${process.argv[2]})`;
  if (process.argv[1] === "true") {
    for (const c of m.content_scripts) c.matches.push("http://localhost/project/*");
    m.web_accessible_resources[0].matches.push("http://localhost/*");
  }
  fs.writeFileSync("build/overleaf/manifest.json", JSON.stringify(m, null, 2) + "\n");' "$dev" "$engine"
# (SHELF_LOCAL=1 with --dev: Shelf from a local server,
# ../shelf.PhiTeX.org/serve.py, serving a release's h/ packs, with
# SHELF_INDEX that release's index; else the live Shelf, whose index
# shelf-index.tsv.gz is)
$dev && [ "${SHELF_LOCAL:-}" = 1 ] && sed -i 's|https://shelf-phitex.pages.dev/|http://localhost:8124/|' build/overleaf/dist/common/shelf.js
# Every module the content script imports must be web-accessible.
tools/sandbox node -e '
  const fs = require("fs"), m = JSON.parse(fs.readFileSync("build/overleaf/manifest.json"));
  const listed = new Set(m.web_accessible_resources.flatMap((w) => w.resources));
  const seen = new Set(), todo = ["dist/content-main.js"];
  while (todo.length) {
    const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
    for (const [, dep] of fs.readFileSync("build/overleaf/" + f, "utf8").matchAll(/^import (?:[^;]*? from )?"(\.\.?\/[^"]+)";/gm)) todo.push(require("path").posix.join(require("path").posix.dirname(f), dep));
  }
  const glob = (p) => [...listed].some((l) => l === p || (l.endsWith("/*.js") && p.startsWith(l.slice(0, -4)) && !p.slice(l.length - 4).includes("/")));
  const missing = [...seen].filter((f) => !glob(f));
  if (missing.length) { console.error("not in web_accessible_resources:", missing.join(" ")); process.exit(1); }'
ls -la build/overleaf/dist/core.wasm
