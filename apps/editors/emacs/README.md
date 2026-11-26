# PhiTeX for Emacs

`phitex-mode`: PhiTeX's live preview in Emacs 29 or later, with AUCTeX or
Emacs's own `latex-mode`. The buffer is built as you type, TeX's errors are
Flymake diagnostics at their places, the pages are in a browser tab, a
double-click on a page jumps to its source, and the cursor is shown on the
page as you move. It runs beside eglot or lsp-mode (texlab, digestif).

## Install

1. Install PhiTeX 1.0 or newer (`phitex --version`):

   ```sh
   curl -fsSL https://phitex.org/install.sh | sh
   ```

   Without it, the mode offers to download the latest release into
   `~/.local/bin` (`M-x phitex-install`), checked against its signature (it
   needs `curl` and `minisign`).

2. Load `phitex.el` and call `phitex-setup`, which turns the mode on in
   LaTeX and plain TeX buffers, with AUCTeX (`LaTeX-mode`) or without it
   (`latex-mode`):

   ```elisp
   (load "~/path/to/phitex.el")
   (phitex-setup)
   ```

   With use-package and Emacs 30's `:vc`:

   ```elisp
   (use-package phitex
     :vc (:url "https://github.com/accl-kaust/PhiTeX-frontends"
          :lisp-dir "apps/editors/emacs" :rev :newest)
     :config (phitex-setup))
   ```

   With straight.el: `:straight (phitex :type git :host github :repo
   "accl-kaust/PhiTeX-frontends" :files ("apps/editors/emacs/*.el") :depth 1
   :nonrecursive t)` and the same `:config`.

   (`(add-hook 'LaTeX-mode-hook #'phitex-mode)` alone does nothing without
   AUCTeX: Emacs's own mode runs `latex-mode-hook`. `phitex-setup` covers
   both.)

3. Open a `.tex` file. The mode line shows `⚡ 67 ms ✗2`; `M-x
   phitex-open-viewer` opens the pages in your browser.

A project with several `.tex` files names its main one in `phitex.toml`
(`main = "paper.tex"`); otherwise the one with a `\documentclass` is built,
and a chapter opened first builds the document that includes it.

## Commands

| Command | What it does |
|---|---|
| `phitex-open-viewer` | open the pages in the browser |
| `phitex-rebuild` | build again from scratch |
| `phitex-save-pdf` | save the PDF |
| `phitex-stop`, `phitex-restart` | stop the watch, start it again |
| `phitex-attach` | use a `phitex watch` already running in a terminal |
| `phitex-caches`, `phitex-clear-cache` | the caches |
| `phitex-install` | download the latest release |
| `phitex-doctor` | check the setup |

Settings: `phitex-settings` (the engine's: `:threads`, `:main`, `:follow`,
`:files`) and `M-x customize-group RET phitex`. The commentary at the top of
`phitex.el` lists them all.

A watch started in a terminal is used when you open one of its files
(`phitex-attach` is `auto`). If that watch ends, the mode starts its own.

## Troubleshooting

- **Nothing happens / no ⚡ in the mode line.** Check that the mode is on
  (`M-x phitex-mode`), then run `M-x phitex-doctor`. It shows which
  `phitex.el` is loaded, the `phitex` it runs and its version, the running
  watches, this buffer's watch, the settings in effect and the last error.
  `w` in it copies the report.
- **"phitex is too old".** Run `phitex upgrade` in a terminal, then `M-x
  phitex-restart`.
- **The pages don't open.** The address is in the `*phitex log*` buffer and
  in `phitex session list`; open it in any browser.
- **Something looks like a bug.** Open an issue with the doctor's report:
  https://github.com/accl-kaust/PhiTeX/issues/new/choose (the report names
  files and settings, never your document's text).
