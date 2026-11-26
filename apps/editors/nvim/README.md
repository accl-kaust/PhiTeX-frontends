# PhiTeX for Neovim

PhiTeX's live preview in Neovim 0.11 or later: the buffer is built as you
type, TeX's errors are diagnostics, the pages are in a browser tab, a
double-click on a page jumps to its source, and the cursor is shown on the
page as you move.

## Install

1. Install PhiTeX 1.0 or newer (`phitex --version`):

   ```sh
   curl -fsSL https://phitex.org/install.sh | sh
   ```

   Without it, the plugin offers to download the latest release into
   `~/.local/bin` (`:PhiTeXInstall`), checked against its signature (it
   needs `curl` and `minisign`).

2. Add the plugin. With lazy.nvim:

   ```lua
   { "accl-kaust/PhiTeX-frontends",
     config = function(p) dofile(p.dir .. "/apps/editors/nvim/phitex.lua") end }
   ```

   With vim-plug: `Plug 'accl-kaust/PhiTeX-frontends', { 'rtp': 'apps/editors/nvim' }`.
   Or copy `phitex.lua` to `~/.config/nvim/plugin/phitex.lua`.

3. Open a `.tex` file. The status line shows what the engine is doing if
   you add `%{v:lua.PhitexStatus()}` to it:

   ```lua
   vim.o.statusline = "%f %m%=%{v:lua.PhitexStatus()} "
   ```

   `<leader>lv` opens the pages in your browser.

A project with several `.tex` files names its main one in `phitex.toml`
(`main = "paper.tex"`); otherwise the one with a `\documentclass` is built,
and a chapter opened first builds the document that includes it.

## Commands

| Command | What it does |
|---|---|
| `:PhiTeXViewer` | open the pages in the browser (`<leader>lv`) |
| `:PhiTeXRebuild` | build again from scratch |
| `:PhiTeXSavePdf [path]` | save the PDF |
| `:PhiTeXStop`, `:PhiTeXRestart` | stop the watch, start it again |
| `:PhiTeXAttach` | use a `phitex watch` already running in a terminal for this file |
| `:PhiTeXCaches`, `:PhiTeXClearCache [build\|packages\|all]` | the caches |
| `:PhiTeXInstall` | download the latest release |
| `:PhiTeXDoctor` | check the setup (also `:checkhealth phitex`) |

Settings go in `PhitexSettings` before the plugin loads, for example
`PhitexSettings = { threads = 4, follow = "selection" }`. The comment at the
top of `phitex.lua` lists them all.

A watch started in a terminal (`phitex watch paper.tex`) is used when you
open one of its files (`attach = "auto"`). If that watch ends, the plugin
starts its own for the open buffers.

## Troubleshooting

- **Nothing happens / no status.** Run `:PhiTeXDoctor`. It shows the
  plugin's version, the `phitex` it runs and its version, whether this
  buffer has a watch (attached or started here), the running watches, the
  settings in effect and the last error. `y` in it copies the report.
- **"phitex is too old".** Run `phitex upgrade` in a terminal, then
  `:PhiTeXRestart`.
- **The pages don't open.** The address is in `:PhiTeXDoctor` and in
  `phitex session list`; open it in any browser.
- **Errors stay after `:e!`.** Update the plugin: a buffer read again from
  disk is sent to the watch whole.
- **Something looks like a bug.** Open an issue with the doctor's report:
  https://github.com/accl-kaust/PhiTeX/issues/new/choose (the report names
  files and settings, never your document's text).
