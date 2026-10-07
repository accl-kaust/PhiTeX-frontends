# PhiTeX.org

The website for **PhiTeX**, a fast, modern TeX compiler: incremental,
parallel, and byte-identical to pdfTeX and XeTeX.

A static, framework-free site built with Vite and TypeScript.

- **`/`** — the compiler: the `phitex watch` CLI, how incremental rebuilds
  work (files → CST → SSA → pages → PDF), the numbers, and a live editor.
- **`/overleaf`** (`overleaf.html`) — the browser extension that puts PhiTeX
  inside Overleaf, with install links for Chrome, Edge and Firefox.
- **`/proof.html`** — byte-exactness and benchmarks.

Related repositories:

- Engine / CLI: <https://github.com/accl-kaust/PhiTeX>
- Browser & VS Code extension: <https://github.com/accl-kaust/PhiTeX-extension>

## Develop

Every `npm` command runs inside the project sandbox (bubblewrap: only the
repo is writable, and there is no network unless `--net` is given):

```sh
scripts/sandbox --net npm install   # once, needs network
scripts/sandbox npm run dev         # dev server at http://127.0.0.1:5173
scripts/sandbox npm run build       # type-check + build to dist/
scripts/sandbox npm run preview     # serve the built dist/
scripts/sandbox npm test            # wasm harness tests
```

`dist/` is a plain static bundle and deploys to any static host. The pages
are emitted as `index.html`, `overleaf.html`, `proof.html`; for a bare
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
VITE_CHROME_URL=https://chrome.google.com/... scripts/sandbox npm run build
```

## Layout

```
index.html, overleaf.html, proof.html, pick.html   the pages
src/
  ui.ts          shared chrome: theme, nav, reveal, links
  main.ts        home page: CLI hero, document-flow, demos
  overleaf.ts    /overleaf page
  replica.ts     the editable editor demo (home + Overleaf)
  style.css      the whole design system (imports replicas.css)
  demo/, fake.ts the on-page demo content and its illustrative typesetter
  fonts/         Computer Modern (CMU), Noto Sans, DM Mono
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
