# Working rules for PhiTeX.org

Guidance for anyone (human or agent) editing this repo. Keep it current.

## Build and run

Everything goes through the sandbox (bubblewrap: only the repo is writable,
no network without `--net`). Do not run `npm`/`node` directly.

```sh
tools/sandbox --net npm install
tools/sandbox npm run build        # tsc --noEmit + vite build; run this before committing
tools/sandbox npm run dev
```

To screenshot the built site for review, use Playwright through the sandbox
with the system Chromium:

```sh
tools/sandbox node scripts/shot.mjs     # writes to .cache/shots/ (gitignored)
# the script sets executablePath to /usr/bin/chromium and passes --no-sandbox
```

## Deploy

Hosted on Cloudflare Pages. Deploys run from GitHub Actions
(`.github/workflows/deploy.yml`) using Wrangler and a Cloudflare API token,
not the Cloudflare GitHub App (the `accl-kaust` org requires an owner to
approve that, which we sidestep). Every push to `main` builds and deploys.

Required repo secrets: `CLOUDFLARE_API_TOKEN` (custom token with
`Account > Cloudflare Pages: Edit`) and `CLOUDFLARE_ACCOUNT_ID`. Store
links can be set as repo variables (`VITE_CHROME_URL`, etc.); otherwise the
defaults in `links.ts` are used. The Pages project is `phitex-org`.

## Voice (this matters here)

- **No em dashes in prose.** Use a colon, a full stop, or a comma. The only
  em dashes allowed are inside UI labels like `main.tex — VS Code`.
- **No AI antitheses.** Avoid "X, not Y", "not just", "more than just". Write
  the plain claim.
- Write like a person. Short, declarative, confident. Match the existing
  headings (e.g. "Errors that show in the PDF itself.", "Questions.").

## Facts to keep accurate

These have been wrong before. Check against the engine repo if unsure.

- The engine is **AGPL-3.0-only**. This website is MIT OR Apache-2.0.
- Engines: **pdfLaTeX and XeLaTeX** (XeLaTeX's corpus check is pending).
  **LuaLaTeX** is planned, after the alpha.
- Output is **byte-identical to pdfTeX 1.40.29**, cold and after every edit;
  gated on the AMS's amsldoc at 1, 8 and 16 threads.
- How it works (2026-10-30, from the engine): pieces cut at paragraph ends,
  each a node with a read set; speculative parallel runs; mergeless commits;
  the loop-back per entry. The older "files → CST → SSA → pages → PDF" and
  "graph reduction of thunks" designs are gone: don't describe them.
- **No timing numbers** until they are measured on public documents (the old
  "10 ms on a 64-page thesis" and "cold 2× pdflatex" had no source).
- The Overleaf extension is listed on the Chrome Web Store, Firefox Add-ons
  and Edge Add-ons (`links.ts`). VS Code: not yet published ("coming soon").
- `phitex watch` serves a live preview on `127.0.0.1` (random-token URL) and
  redraws only the pages that changed. Same viewer as the extension.

The interactive editors are **design mocks** (`src/fake.ts`), not the real
engine. Per-keystroke latencies shown in animations are illustrative and
labelled as such in code comments; headline numbers must come from the
engine's benches or the extension's report.

## Design system

- All styling is in `src/style.css` (which `@import`s `replicas.css`). No
  framework, no Tailwind.
- Colors are CSS custom properties on `:root`. Dark mode is defined twice:
  under `@media (prefers-color-scheme: dark)` guarded by
  `:root:not([data-theme="light"])`, and under `:root[data-theme="dark"]`.
  Never hard-code a theme color in a rule that both modes share; add a token.
- Respect `prefers-reduced-motion`: every looping animation checks `reduced`
  and renders a static end state.
- The site makes **no third-party requests**: fonts and libraries are
  bundled. The only external resource is the Overleaf demo video, which is
  click-to-load (nothing fetched from YouTube until the viewer presses play).
  Keep it that way.

## Structure

- Multi-page Vite app. Each page is an entry in `vite.config.ts`
  (`index.html`, `overleaf.html`, `proof.html`, `install.html`). `/try` is a
  redirect (`public/_redirects`) to the demo's own site, demo.phitex.org.
- JS is split: `ui.ts` (shared chrome, loaded on every page), `replica.ts`
  (the editable demo, used by home and Overleaf), `main.ts` (home),
  `overleaf.ts` (Overleaf). Page-specific blocks guard on an element being
  present so a shared module no-ops where its DOM is absent.
- Links are wired by `ui.ts` from `src/links.ts` via attributes:
  `data-repo` (engine), `data-ext` (extension), `data-store="chrome|edge|firefox"`.
  Defaults live in `links.ts`; override with `VITE_*_URL` at build time.

## Don't

- Don't commit `dist/`, `node_modules/`, or `.cache/` (all gitignored).
- Don't add a dependency or a framework for something a few lines of vanilla
  can do.
- Don't claim a benchmark number the engine doesn't actually produce.
