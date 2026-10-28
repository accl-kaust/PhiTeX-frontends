#!/usr/bin/env bash
# VS Code with the extension as it is in vscode/src (bundled again first),
# on a folder, the preview by `phitex watch --lsp` (the native engine).
#
#   scripts/vscode-dev.sh [FOLDER] [PHITEX]
#
# FOLDER: the project (default: a demo with an amsmath article, made in
# target/vscode-demo/). PHITEX: the phitex binary (default: target/native/
# phitex if there, else phitex on PATH); it must have `watch --lsp` (PhiTeX
# dev 32c7adca or newer). VS Code runs with a profile of its own in
# target/vscode-dev/ (its settings: phitex.engine "phitex watch" and
# phitex.path), so your own settings, extensions and the folder's
# .vscode/ are left as they are. Then: open a .tex file, Ctrl+Alt+P.
# PHITEX_CODE_FLAGS: more flags for code (e.g. --disable-gpu).
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$PWD

phitex=${2:-}
[ -n "$phitex" ] || { [ -x target/native/phitex ] && phitex=$repo/target/native/phitex; } || phitex=$(command -v phitex || true)
[ -n "$phitex" ] && "$phitex" watch --help 2>/dev/null | grep -q -- --lsp || { echo "no phitex with watch --lsp (give its path as the second argument)" >&2; exit 1; }

folder=${1:-}
if [ -z "$folder" ]; then
  folder=$repo/target/vscode-demo
  mkdir -p "$folder"
  [ -f "$folder/hello.tex" ] || printf '%s\n' '\documentclass{article}' '\usepackage{amsmath}' '\begin{document}' '\section{Hello}' 'Some text, $e^{i\pi}+1=0$, and a list:' '\begin{itemize}\item one\item two\end{itemize}' '\end{document}' > "$folder/hello.tex"
fi
folder=$(cd "$folder" && pwd)

# (the extension's bundle, as scripts/build-vscode.sh makes it)
scripts/sandbox node_modules/.bin/esbuild --bundle --log-level=warning --sourcemap=inline vscode/src/extension.ts \
  --platform=node --format=cjs --target=node20 --external:vscode --outfile=vscode/dist/extension.js

profile=$repo/target/vscode-dev
mkdir -p "$profile/user/User" "$profile/extensions"
cat > "$profile/user/User/settings.json" <<EOF
{
  "phitex.engine": "phitex watch",
  "phitex.path": "$phitex",
  "workbench.startupEditor": "none"
}
EOF

main=$(grep -l '\\documentclass' "$folder"/*.tex 2>/dev/null | head -1 || true)
echo "VS Code on $folder, phitex: $phitex"
code ${PHITEX_CODE_FLAGS:-} --new-window --user-data-dir "$profile/user" --extensions-dir "$profile/extensions" \
  --extensionDevelopmentPath "$repo/vscode" "$folder" ${main:+"$main"}
