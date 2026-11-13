# Store listings: Chrome Web Store, Edge Add-ons, Firefox Add-ons

Everything the dashboards ask for, ready to paste. The uploads are built by
`tools/build/package.sh` (→ `build/phitex-instant-<version>.zip` for Chrome
and Edge, `build/phitex-instant-<version>-firefox.zip` for Firefox) and
copied into `store/`. Firefox also asks for the source:
`store/phitex-instant-<version>-source.zip`, with `BUILD.md` at its top.

The VS Code extension's listing (Marketplace, Open VSX) is its own README,
`apps/vscode/README.md`; its package is `build/phitex-<version>.vsix`
(`tools/build/build-vscode.sh --package`).

## Store listing

**Name** (from the manifest): PhiTeX Instant for Overleaf (unofficial)

**Summary** (≤ 132 characters; the manifest's description):
> Unofficial, experimental: an instant PhiTeX preview beside Overleaf's PDF, and folders for projects. Not affiliated with Overleaf.

**Description:**

> PhiTeX Instant adds a live preview to Overleaf's PDF pane. Switch between
> Overleaf's PDF and ⚡ Instant, and the page follows your typing, usually
> within milliseconds, with no Recompile.
>
> It is powered by PhiTeX 1.0, a TeX engine that keeps your document
> compiled while you edit it: a keystroke rebuilds only what it reaches,
> and the result is the PDF pdfLaTeX makes. The engine runs in your
> browser, as WebAssembly. Your documents are never sent anywhere.
>
> New in 1.0:
> • Link previews: rest the pointer on a \ref or \eqref and a small window
>   shows the target. Pin it, move it, resize it.
> • Citation cards: hover a citation for the works it cites, a group or a
>   range like [1–3] included.
> • Back and forward after following a link, with the mouse's buttons too.
>   Ctrl+click opens the target in a new tab.
> • Compare any two versions from the project's history: the page shows
>   the changes as latexdiff marks them, and keeps following your edits.
> • Loading animations to pick from, and prebuilt formats, so a first open
>   starts fast.
>
> Also:
> • pdfLaTeX and XeLaTeX (fontspec, unicode-math, polyglossia), with TeX
>   Live's OpenType fonts or your own: Arabic, Hebrew, Chinese and more
> • BibTeX, biber and makeindex inside the build: references settle by
>   themselves
> • Figures (PNG, JPEG, PDF), TikZ, and minted listings in colour
> • Errors and warnings on the page, with a click to the line
> • Double-click the page to find the source; the words at the cursor are
>   marked on the page
> • Folders for your projects on Overleaf's project list
> • TeX Live's packages downloaded once, when a document first needs them,
>   and kept for offline use (see and clear the cache in the settings)
>
> This is an UNOFFICIAL extension. It is not made, endorsed or supported by
> Overleaf. For anything that matters, use Overleaf's own PDF, one click
> away. Before its first use it asks you to accept that it is provided as
> is, without warranty.
>
> Free software under the GNU AGPL, version 3 only:
> https://github.com/accl-kaust/PhiTeX-frontends

**Category:** Tools (Chrome: Productivity › Tools; Firefox: Other) ·
**Language:** English · **Homepage:** https://phitex.org/overleaf.html ·
**Support:** https://github.com/accl-kaust/PhiTeX-frontends/issues

**Graphics** (in `store/`):
- Icon: `icon-128.png` (128×128, the extension's own)
- Screenshots, 1280×800 (Chrome takes 5, Edge 10, Firefox any):
  1. `screenshot-1-instant.png`: ⚡ Instant beside the editor, following a keystroke
  2. `screenshot-2-links.png`: a link preview, pinned, over an equation reference
  3. `screenshot-3-cites.png`: a citation card for a group of works
  4. `screenshot-4-errors.png`: an error on the page, with the problems list
  5. `screenshot-5-looks.png`: Settings › Appearance, the loading animations
- Small promo tile: `promo-small-440x280.png` (440×280)
- Marquee promo tile: `promo-marquee-1400x560.png` (1400×560)
- Edge's logo: `icon-128.png` works (it asks for 300×300 at most)

`store/promo.html` is the tiles' source; `node store/shots.mjs` renders them.

## Privacy practices

**Single purpose:**
> Show a locally computed TeX preview of the Overleaf project being edited,
> next to Overleaf's own PDF, and organize the user's Overleaf projects
> into folders.

**Permission justifications:**
- `storage`: keeps the extension's own settings (on/off, which preview
  opens, the page view, the panel's layout, acceptance of the terms). No
  document content is stored.
- `unlimitedStorage`: the TeX Live packages a document uses are downloaded
  once and kept in the browser's IndexedDB, for fast and offline builds. A
  thesis can use a few hundred MB of them. *Package cache → Clear* in the
  settings deletes them.
- `alarms`: every six hours, the background worker fetches the TeX Live
  packages most papers use, ahead of a first open. The list is the same for
  everyone and says nothing about the user's documents. It can be turned
  off in the settings.
- `activeTab`: lets the settings popup start the tour or show what's new in
  the Overleaf tab the user is on.
- Host access (content scripts on `https://www.overleaf.com/project*`):
  adds the switch and the preview to Overleaf's editor and reads the
  project being edited (from the editor and the project's own files, as
  the signed-in user) to typeset it locally; on the project list, adds the
  folders.

**Remote code:** No. All code, including the WebAssembly engine, ships in
the package (CSP `script-src 'self' 'wasm-unsafe-eval'`).

**Data usage:** tick nothing. The extension collects none of: personally
identifiable information, health, financial, authentication, personal
communications, location, web history, user activity, website content.
It reads the Overleaf project to typeset it, in the browser, and sends it
nowhere. The folders are kept in the user's own Overleaf account (a
project named `.phitex-data`, made only when the user first makes a
folder and agrees to it).
- I do not sell or transfer user data to third parties ✓
- I do not use or transfer user data for purposes unrelated to the single purpose ✓
- I do not use or transfer user data to determine creditworthiness or for lending ✓

Firefox's `data_collection_permissions` is `none` (in the Firefox manifest).

**Privacy policy URL:** host `docs/PRIVACY.md` (for example
https://github.com/accl-kaust/PhiTeX-frontends/blob/main/docs/PRIVACY.md)
and paste its URL.

## Distribution

- **Visibility:** to get reviewed without going public, choose **Private**
  (trusted testers) or **Unlisted**, or keep **Public** but untick
  *publish automatically after review* (deferred publishing).
- **Trader status:** non-trader (free, no monetization, no ads).
- **Regions:** all.

## Notes for the reviewer

> To test: open any Overleaf project (a free account works), then click
> "⚡ Instant" in the PDF toolbar and accept the terms. A LaTeX document
> works; for example, replace main.tex with:
>
>     \documentclass{article}
>     \usepackage{hyperref}
>     \begin{document}
>     \section{Hello}\label{s}
>     This paragraph follows your typing. See Section~\ref{s}.
>     \end{document}
>
> Rest the pointer on the "1" of "Section 1" for a link preview.
>
> The extension's network requests: overleaf.com (the project's files and
> history, as the signed-in user) and Shelf (v1.shelf.phitex.org, else
> shelf-phitex-v1.pages.dev): TeX Live's package files, fetched by name
> when a document needs one, and a list of common ones fetched ahead.
> Nothing about the document is sent. The engine runs locally, in a worker
> of a hidden extension frame in the Overleaf tab (the extension's own
> page, not Overleaf's).
>
> addons-linter: 0 errors, 2 warnings, both `innerHTML` in
> `dist/common/viewer/viewer.js`: a citation card's fields, each escaped
> (`&`, `<`, `>`, `"` as character references) before it is inserted, and
> the Back menu's buttons, whose only values are numbers. Pyodide (minted's
> Python) and its `eval` are vendored unmodified. The JavaScript is bundled
> by esbuild and not minified; the source and its build steps are in the
> source archive (BUILD.md).

## Updates

Each upload is reviewed again. Code-only updates within the same
permissions are the quick kind. A new permission or host makes Chrome ask
existing users again, and disables the extension until they accept. Bump
`apps/overleaf/manifest.base.json`'s version and add an entry to
`apps/overleaf/src/news.ts`, which users see once after updating.
