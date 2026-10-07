# Working rules for PhiTeX.org

Guidance for anyone (human or agent) editing this repo. Keep it current.

## Build and run

Everything goes through the sandbox (bubblewrap: only the repo is writable,
no network without `--net`). Do not run `npm`/`node` directly.

```sh
scripts/sandbox --net npm install
scripts/sandbox npm run build        # tsc --noEmit + vite build; run this before committing
scripts/sandbox npm run dev
```

To screenshot the built site for review, use Playwright through the sandbox
with the system Chromium:

```sh
scripts/sandbox node scripts/shot.mjs     # writes to .cache/shots/ (gitignored)
# the script sets executablePath to /usr/bin/chromium and passes --no-sandbox
```

## Voice (this matters here)

- **No em dashes in prose.** Use a colon, a full stop, or a comma. The only
  em dashes allowed are inside UI labels like `main.tex — VS Code`.
- **No AI antitheses.** Avoid "X, not Y", "not just", "more than just". Write
  the plain claim.
- Write like a person. Short, declarative, confident. Match the existing
  headings (e.g. "Errors that point at the line.", "Questions.").

## Facts to keep accurate

These have been wrong before. Check against the engine repo if unsure.

- The engine is **AGPL-3.0-only**. This website is MIT OR Apache-2.0.
- Engines: **pdfTeX and XeTeX**. There is **no LuaTeX** yet (say "planned").
- Output is **byte-identical to pdfTeX 1.40.29**, cold and after every edit.
- SSA = **static single assignment** (standard term; don't write "dynamic").
- Native word-edit rebuild on a 64-page thesis is about **10 ms**; a cold
  tracked build is roughly 2x a plain pdflatex run.
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
  (`index.html`, `overleaf.html`, `proof.html`, `pick.html`).
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
