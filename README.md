# PhiTeX frontends

[PhiTeX](https://github.com/accl-kaust/PhiTeX) is a TeX engine that
rebuilds incrementally: an edit re-runs only what it changed, so ordinary
text and headings reach the page in a few milliseconds. This repository
holds the places you use it from: a browser extension for Overleaf, VS
Code, Emacs and Neovim, a demo in the browser, and phitex.org.

> **Experimental.** When PhiTeX's pages and a regular `pdflatex` run
> disagree, `pdflatex` is right.

![The ⚡ Instant preview in Overleaf's PDF pane](store/screenshot-1-instant.png)

## The frontends

| Frontend | Where | Engine |
| --- | --- | --- |
| **Overleaf** (Chrome, Edge, Firefox) | `overleaf/` | PhiTeX as WebAssembly, in the browser |
| **VS Code** | `vscode/` ([its README](vscode/README.md)) | WebAssembly inside VS Code, or the `phitex` command |
| **Emacs** | `editors/emacs/phitex.el` | the `phitex` command (`phitex watch --lsp`) |
| **Neovim** 0.11 | `editors/nvim/phitex.lua` | the `phitex` command (`phitex watch --lsp`) |
| **The demo** | `web/`, at demo.phitex.org | WebAssembly, in the browser |
| **phitex.org** | `site/` | the project's site and install page |

Every frontend shows pages with PhiTeX's viewer (`phitex/viewer/`). In
it you can select and search text, which stays sharp at any zoom. Each
frontend also gives you:

- **Source ↔ page**: the word at your cursor is marked on the page, and a
  double-click on the page opens its source.
- **Problems**: errors and warnings are listed and underlined on the page.
  Each has **Copy for an AI assistant**: the message with the source around
  it, the preamble, the macros and files it came from, TeX's notes and the
  log.
- **Settings**: one dialog in tabs, each frontend's own settings beside the
  viewer's.

A package a document needs is downloaded once from **Shelf**
(`v1.shelf.phitex.org`), TeX Live 2026 split into packs, and then kept.
The browser frontends ship LaTeX's core and fetch the rest. The `phitex`
command keeps its own cache.

### Overleaf

An unofficial extension: not made, endorsed or supported by Overleaf.
Overleaf's own PDF stays the real one: use ⚡ Instant to write, and
Overleaf's Recompile for the PDF you submit.

- A **PDF | ⚡ Instant** switch next to Recompile (**Alt+Shift+P**). The
  ⚡ view is typeset by pdfTeX or XeTeX, chosen from the preamble,
  running in your browser. Your project's classes, `.bib` files and PDF,
  PNG and JPEG figures are used.
- BibTeX and makeindex run inside the build and re-run only for what
  changed. `minted` works through Pygments running as Python in
  WebAssembly.
- When an edit breaks the document (an unclosed `{`, say), the last good
  page stays on screen, dimmed, with the reason.
- Collaborators show on the page where they are, in their colour.
- The download button gives the ⚡ PDF; its ▾ menu still gives Overleaf's.
- It follows Overleaf's light or dark theme and its dark PDF switch.
- **Folders** on the project dashboard: nested folders and a status column
  (idea, drafting, submitted, …), kept in a project of yours,
  `.phitex-data`.

**Install**: from the Chrome Web Store, Microsoft Edge Add-ons or Firefox
Add-ons *(links with the public release)*. It works in Chromium browsers
and Firefox 142 or later. Open a project on overleaf.com, switch the PDF
pane to ⚡ Instant, and accept the short terms the first time. A project's
first open downloads the packages it uses (a few seconds, up to a minute on
a slow connection); later opens start at once and work offline.

**Settings**: the ⚙ in the PDF toolbar.

| Tab | |
| --- | --- |
| Preview | what a project opens with, the engine (Auto, pdfLaTeX, XeLaTeX), what the highlight follows, collaborators, the main file |
| Appearance | dark PDF (off, on, match the theme), the loading animation, underlines |
| Build | clean rebuild, reload the files, a debug check against a fresh build |
| Packages | the packs kept (Clear), the most to keep, fetching common ones ahead |
| Updates and tips | tips, the tour, what's new |
| Overleaf | on or off, the dashboard's folders, the terms, reset |

**Limits**:
- LuaLaTeX can't be previewed yet. The card offers pdfLaTeX instead.
- XeLaTeX's page view draws text in black whatever `\textcolor` says.
- Shell escape is restricted, as in TeX Live; only `minted`'s command runs.
- Only BibTeX and makeindex run (no biber, no xindy).
- `microtype`'s font expansion is not supported yet.
- A big document's first open needs memory and time: a 64-page thesis
  shows its pages in about half a minute.
- The extension depends on Overleaf's page structure, which is not a
  public API.
- One project per tab.

**A bug**: ⓘ → **Report a problem…** shows an anonymized report (versions,
timings, errors, package names; no document text, files named
`file1.tex`, …) to copy or email to flinner@nand.sh. Nothing is sent
unless you send it.

### VS Code

**Ctrl+Alt+P** (**Cmd+Alt+P**) on a `.tex` file opens the preview beside
the editor. It also compares the document with a past git commit, marking
the changes as `latexdiff` would. The built-in engine needs nothing
installed; `phitex.engine` switches to the `phitex` command. See
[vscode/README.md](vscode/README.md).

### Emacs and Neovim

Both run `phitex watch --lsp` as the TeX buffer's preview server, beside
texlab or whatever else serves it. Each buffer is built as you type, with
TeX's errors as diagnostics. The pages are in a browser tab that the
command serves. The mode line (Emacs) or `PhitexStatus()` (Neovim) shows
the last build's time and its problems.

- **Emacs**: `phitex-mode`, by use-package (`:vc`) or by loading
  `phitex.el`.
- **Neovim 0.11**: lazy.nvim, or the file in your config.

`M-x phitex-install` and `:PhiTeXInstall` download the `phitex` command
when there is none. The install steps are on phitex.org's install page and
at the top of each file.

### The demo

demo.phitex.org typesets a sample project, or your own, in the browser
with nothing installed. It is deployed on each push to `main`
(`.github/workflows/deploy-demo.yml`).

## Privacy

**Your documents never leave your machine.**

- The typesetter runs locally in every frontend. No code is downloaded at
  run time.
- A package is fetched from Shelf with a plain GET of its pack's name, such
  as `…/tl2026/h/pgf-3f9a2c41b0de.pack`. No document text, file name or
  identifier is sent. At most once a day the browser frontends read
  `…/tl2026/release.json` to learn of a newer index. Shelf is static files
  on Cloudflare Pages, which sees the request and your IP address; Shelf
  keeps no logs of its own.
- No analytics, accounts or tracking.
- The Overleaf extension reads your project from overleaf.com as you do,
  and never writes to it (except the folders' own `.phitex-data`, when
  folders are on). Its permissions:
  - `offscreen` (Chrome, Edge): the typesetter's background worker;
    Firefox's background page does this instead.
  - `storage`: the settings.
  - `activeTab`: the popup's tour.
  - Access to `https://www.overleaf.com/project/*` only.

The extension's full policy is [PRIVACY.md](PRIVACY.md).

## How it works

```
editor ── edits as byte ranges ──▶ session.ts ── one build in flight ──▶ core (PhiTeX)
                                       ▲                                    │ missing file
                                       │ pages, problems, source ↔ page     ▼
                                    viewer ◀──────── PDF + glyph origins   Shelf
```

- **Incremental builds**: the engine records the job as a program in SSA
  form, a graph of steps and the state each reads. An edit re-runs only the
  steps whose inputs changed, then links the output from every step's
  effects.
- **Edits**: every editor change becomes byte-range edits. At most one
  build is in flight; what you type meanwhile goes into the next.
- **Pages**: a second worker draws the page you're reading first, then the
  rest ahead of time. They are vector graphics with the fonts' real
  outlines.
- **Source ↔ page**: the engine records, for each glyph it ships, the
  source bytes it came from.
- **Start-up**: the packages the preamble names are fetched in parallel. A
  file the build still lacks is fetched from inside the build. A format
  made at build time (`formats/`) holds LaTeX's core, against the Shelf
  release shipped.
- `common/session.ts` knows no editor and no browser (`EditorHost`,
  `CoreTransport`, `PreviewSink`). Each frontend supplies those, and a
  `Platform` for files, storage and fetch.

## Building

The engine is the `phitex/` submodule, followed at PhiTeX's `dev`:

    git submodule update --init phitex

You need:
- the Rust toolchain in `rust-toolchain.toml`, with the `wasm32-wasip1`
  target;
- Node 22 or later;
- bubblewrap, for `scripts/sandbox`, which runs build steps without
  network access or `$HOME`.

```sh
scripts/sandbox --net npm ci --ignore-scripts
scripts/build/build.sh           # the wasm core, the formats, the extension → overleaf/
scripts/build/package.sh         # the store zips → build/ (Chrome and Edge; Firefox)
scripts/build/build-vscode.sh    # VS Code → vscode/
scripts/build/build-web.sh       # the demo → build/web/
```

To try the extension, open `chrome://extensions`, turn on *Developer
mode*, choose *Load unpacked* and pick `overleaf/`.

`shelf-index.tsv.gz`, `shelf-packs.tsv.gz` and `shelf-release.json` are
the Shelf release shipped (`scripts/build/shelf-index.sh`). The formats
are made against it. A newer Shelf release means shipping it with its
formats made again; otherwise the browser rebuilds the format and fetches
every language's hyphenation patterns.

## Development

The mock Overleaf (`mock/`) imitates what the extension reads:
CodeMirror 6, the file tree, the project endpoints and the PDF pane.

    scripts/build/build.sh --dev
    scripts/sandbox scripts/build/mock-editor.sh        # once: the mock's editor → mock/build/
    scripts/sandbox --net node mock/server.mjs          # http://localhost:8123/project/mock
    scripts/dev/chrome.sh [url]                         # Chromium with the extension, DevTools on :9222
    scripts/sandbox node --test test/                   # unit tests

Scripted runs:
- They skip the terms and the tour (`scripts/dev/onboarded.mjs`).
- After a change to the core, restart the browser: the offscreen document
  keeps the old wasm across reloads.

```sh
scripts/sandbox --net node scripts/dev/mock-run.mjs test/scenarios/ci.json [--fresh]
scripts/build/package.sh && node scripts/dev/fx-run.mjs     # Firefox: the store package on the mock
```

`mock-run.mjs` runs a scenario in headless Chromium. It writes the trace,
the screenshots and the core's log to `target/mock-run/<name>/`.

A scenario can:
- play steps, such as typing, replacing text, reloading, opening a second
  tab, changing the main document, or double-clicking the page or the
  editor (the full list is in the script's header);
- be `strict`, so any exception or console error fails it;
- set a `budget`: the first page within so many ms, at most so many
  packages fetched, none matching a pattern.

## Checks

- **Each push** (`.github/workflows/ci.yml`): the extensions' TypeScript
  and the unit tests, among them the format lock (`test/formats.test.ts`).
- **PhiTeX's release gate and nightly** (its `frontends.yml`, at the
  commit its `ci/frontends.commit` names) build the wasm core and every
  frontend and run them in Chrome:
  - the extension on the mock (`test/scenarios/ci*.json`);
  - the demo (`web/test/check.mjs`);
  - VS Code's wasm engine;
  - Emacs, Neovim and VS Code's native engine (`test/editors/run.sh`).

  A run fails on an error or over its budget:
  - `ci.json`, from an empty cache: the first page within 20 s, at most
    8 packages, no hyphenation patterns;
  - each of `ci-reload.json`'s reloads: within 15 s, with no package
    fetched.
- **By hand before a release**: overleaf.com itself, and VS Code's UI.

## Repository

| Path | |
| --- | --- |
| `common/` | what the frontends share: the session, the core's worker and host, packages and their cache, the fonts; `common/src/viewer` links to `phitex/viewer/src` |
| `overleaf/` | the extension: manifest, content scripts, offscreen document, popup, the folders |
| `vscode/`, `editors/`, `web/`, `site/` | the other frontends |
| `phitex/` | the engine (submodule) |
| `mock/` | the mock Overleaf |
| `scripts/` | `build/`, `dev/`, `debug/`, `sandbox` |
| `test/` | unit tests, scenarios, the editors' checks |
| `store/`, `STORE.md` | the store listings' screenshots, icons and text |

## License

GNU Affero General Public License, **version 3 only** (`AGPL-3.0-only`); see
[LICENSE](LICENSE) and [NOTICE](NOTICE). This applies to every revision of
this repository, including any with earlier or placeholder license
metadata. Provided as is, without any warranty.

Bundled third-party components keep their own licenses: TeX Live's files
(mostly LPPL), Pyodide (MPL-2.0), Pygments (BSD-2-Clause), latexminted and
latexrestricted (LPPL-1.3c), latex2pydata (BSD-3-Clause), pdf.js
(Apache-2.0).
