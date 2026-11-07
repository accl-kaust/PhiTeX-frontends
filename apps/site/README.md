# PhiTeX.org

The website for **PhiTeX**, a fast, modern TeX compiler: incremental,
parallel, and byte-identical to pdfLaTeX and XeLaTeX.

A static, framework-free site built with Vite and TypeScript.

- **`/`** — the compiler: the banner, why PhiTeX, the editors, a live
  editor, the CLI and how an edit is rebuilt. The animations and pictures in
  `public/anim/` and `public/img/` come from the PhiTeX repo's `assets/`.
- **`/overleaf`** (`overleaf.html`) — the browser extension that puts PhiTeX
  inside Overleaf, with install links for Chrome, Edge and Firefox.
- **`/measured.html`**: correctness and speed, from bench.json.
- **`/install.html`** — installing the CLI (Linux, macOS), the extension and the editors.
- **`/try`** — redirects to the demo, its own site: demo.phitex.org.

Related repositories:

- Engine / CLI: <https://github.com/accl-kaust/PhiTeX>
- Browser & VS Code extension: <https://github.com/accl-kaust/PhiTeX-extension>

## Develop

Every `npm` command runs inside the project sandbox (bubblewrap: only the
repo is writable, and there is no network unless `--net` is given):

```sh
tools/sandbox --net npm install   # once, needs network
tools/sandbox npm run dev         # dev server at http://127.0.0.1:5173
tools/sandbox npm run build       # type-check + build to dist/
tools/sandbox npm run preview     # serve the built dist/
tools/sandbox npm test            # wasm harness tests
```

`dist/` is a plain static bundle and deploys to any static host. The pages
are emitted as `index.html`, `overleaf.html`, `measured.html`; for a bare
`/overleaf` URL, add a host rewrite from `/overleaf` to `/overleaf.html`.

## Build-time configuration

Links are set from environment variables at build time (sensible defaults
point at the repositories above):

| Variable | Links to |
|---|---|
| `VITE_REPO_URL` | the engine repository ("Get PhiTeX", GitHub icon) |
| `VITE_EXT_URL` | the extension repository ("Install for VS Code", source) |
| `VITE_CHROME_URL` / `VITE_EDGE_URL` / `VITE_FIREFOX_URL` | per-store listings |

```sh
VITE_CHROME_URL=https://chrome.google.com/... tools/sandbox npm run build
```

## Layout

```
index.html, overleaf.html, measured.html, install.html   the pages
src/
  ui.ts          shared chrome: theme, nav, reveal, links
  main.ts        home page: the ribbon, how-it-works steps, ACCL's footer intro
  overleaf.ts    /overleaf page
  replica.ts     the editable editor demo (home + Overleaf)
  style.css      the whole design system (imports replicas.css)
  demo/, fake.ts the on-page demo content and its illustrative typesetter
  install.ts     /install: the install page's tabs and copy buttons
public/
  anim/          the README's animations (from the PhiTeX repo's assets/), embedded in frames
  img/, logo/    the README's pictures (site colours) and the logos
  fonts/         Computer Modern (CMU, subset to Latin, Greek and math), Noto Sans, DM Mono
  vendor/accl/   ACCL's logo intro (ammar.engineer/web/accl-logo) with GSAP
```

The interactive editors on the page are **design mocks**: they illustrate
the experience with a lightweight typesetter (`src/fake.ts`), not the real
engine. Performance figures on the site come from the compiler's own
benches and from the extension's measurements.

## License

The website in this repository is MIT OR Apache-2.0. The PhiTeX engine
(separate repository) is licensed under AGPL-3.0-only.

Created by [ACCL, KAUST](https://accl.kaust.edu.sa/). Not affiliated with
or endorsed by Overleaf.
