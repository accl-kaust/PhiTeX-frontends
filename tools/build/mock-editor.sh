#!/usr/bin/env bash
# The mock page's editor (tools/mock/editor/): Overleaf's LaTeX grammar generated
# into a Lezer parser, and CodeMirror 6 bundled into tools/mock/build/editor.js.
# Run through the sandbox: tools/sandbox tools/build/mock-editor.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p tools/mock/build
cp tools/mock/editor/tokens.mjs tools/mock/build/tokens.mjs
npx lezer-generator tools/mock/editor/latex.grammar -o tools/mock/build/latex.mjs
npx esbuild tools/mock/editor/editor.mjs --bundle --format=esm --log-level=warning --outfile=tools/mock/build/editor.js
