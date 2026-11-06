#!/usr/bin/env bash
# Neovim with PhiTeX's live preview as apps/editors/nvim/phitex.lua gives it
# (`phitex watch --lsp`, the native engine), on a folder: your own config
# left out (nvim --clean), this file alone loaded, `phitex` the one given.
#
#   tools/dev/vim.sh [FOLDER] [PHITEX]
#
# FOLDER: the project (default: a demo with an amsmath article, made in
# target/vim-demo/). PHITEX: the phitex binary (default: target/native/phitex
# if there, else phitex on PATH); it must have `watch --lsp`. Then: type in
# the .tex file; <leader>lv (space l v) opens the pages in your browser;
# the statusline says what the engine is doing; :PhiTeXRebuild, :PhiTeXStop,
# :PhiTeXCaches, ... (the file's header). PHITEX_SETTINGS: a Lua table for
# PhitexSettings, e.g. '{ follow = "selection" }'.
set -euo pipefail
cd "$(dirname "$0")/../.."
repo=$PWD

phitex=${2:-}
[ -n "$phitex" ] || { [ -x target/native/phitex ] && phitex=$repo/target/native/phitex; } || phitex=$(command -v phitex || true)
[ -n "$phitex" ] && "$phitex" watch --help 2>/dev/null | grep -q -- --lsp || { echo "no phitex with watch --lsp (give its path as the second argument)" >&2; exit 1; }

folder=${1:-}
if [ -z "$folder" ]; then
  folder=$repo/target/vim-demo
  mkdir -p "$folder"
  [ -f "$folder/hello.tex" ] || printf '%s\n' '\documentclass{article}' '\usepackage{amsmath}' '\begin{document}' '\section{Hello}' 'Some text, $e^{i\pi}+1=0$, and a list:' '\begin{itemize}\item one\item two\end{itemize}' '\end{document}' > "$folder/hello.tex"
fi
folder=$(cd "$folder" && pwd)
main=$(grep -l '\\documentclass' "$folder"/*.tex 2>/dev/null | head -1 || true)

# (phitex.lua runs `phitex`: the one given, first on PATH; the init: space the
# leader, the engine's status in the statusline, then phitex.lua)
bin=$repo/target/vim-bin
mkdir -p "$bin"
ln -sf "$phitex" "$bin/phitex"
init=$repo/target/vim-init.lua
cat > "$init" <<LUA
vim.g.mapleader = " "
vim.o.number = true
PhitexSettings = ${PHITEX_SETTINGS:-{}}
dofile("$repo/apps/editors/nvim/phitex.lua")
vim.o.statusline = "%f %m%=%{v:lua.PhitexStatus()} "
LUA
echo "Neovim on $folder, phitex: $phitex (space l v: the pages)"
cd "$folder"
PATH=$bin:$PATH exec nvim --clean -u "$init" ${main:+"$main"}
