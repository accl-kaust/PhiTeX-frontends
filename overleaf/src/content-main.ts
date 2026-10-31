// Overleaf's wiring of a PreviewSession: the page hook (hook.ts, in the
// page's world) for the editor, the project ZIP for the files, a chrome
// port to the offscreen document, which relays it to this tab's core (a
// worker of its own: worker.ts, the core's viewer protocol, CoreSession),
// and the panel. The session is in its remote mode, as on `phitex watch`:
// the core's events say when the pages are in (settled) and what the build
// found (diagnostics); this script opens the project itself (its files,
// then setMain), and the editor's edits go to the core as requests.

import "./platform.ts";
import { platform } from "./common/platform.ts";
import type { Edit } from "./common/viewer/edits.ts";
import { older } from "./common/version.ts";
import { PreviewSession, guessMain, type CoreReq, type CoreRes, type CoreTransport, type CoreEvent, type EditorHost } from "./common/viewer/session.ts";
import { charOffset } from "./common/viewer/edits.ts";
import { readZip } from "./common/zip.ts";
import { type DiffRunner, compareButton } from "./diffui.ts";
import { AGREE, TERMS, asIs } from "./terms.ts";
import { callout, calloutStyle, type Callout } from "./callout.ts";
import { h } from "./dom.ts";
import { filesAt, type Version } from "./history.ts";
import { Compare, gate, LATEXDIFF_LOOK } from "./common/viewer/compare.ts";
import { SUPPORT, unseen, type News } from "./news.ts";
import { Panel, type DiffLook, type PanelPrefs, type Prefs, type ViewState } from "./common/viewer/panel.ts";
import { channel, follow, tee, type Ask } from "./mirror.ts";
import { approximable, resolve, shimTexts, type Engine, type EngineChoice } from "./common/viewer/engines.ts";
import { StripPages } from "./common/strippages.ts";

/** The panel's preferences, in the extension's own storage (not the page's). */
const prefs: Prefs = {
  load: async () => ((await chrome.storage.local.get("panel")).panel as Partial<PanelPrefs>) ?? {},
  save: (p) => void chrome.storage.local.set({ panel: p }),
};

const project = () => location.pathname.replace(/\/$/, "").replace(/\/detached$/, "");
/** Overleaf's "Open PDF in separate tab": this tab mirrors the editor's (mirror.ts). */
/**
 * fetch as the page (its cookies, its origin): Firefox's content scripts
 * have `content.fetch` for that, their plain fetch being the extension's
 * (no Overleaf session cookie, a cross-origin request); Chrome's fetch is
 * the page's already.
 */
const rawPageFetch: typeof fetch = (globalThis as unknown as { content?: { fetch?: typeof fetch } }).content?.fetch?.bind((globalThis as unknown as { content: object }).content) ?? fetch;
const pageFetch: typeof fetch = (u, o) => {
  devMark(`fetch ${String(u).replace(/^.*\/project\/[^/]+/, "")}`);
  return rawPageFetch(u, o).then(
    (r) => (devMark(`fetched ${r.status}`), r),
    (e) => (devMark(`fetch failed: ${e}`), Promise.reject(e)),
  );
};

const DETACHED = /^\/project\/[0-9a-f]{24}\/detached\/?$/.test(location.pathname);

// (debug scripts, on the local mock only, never overleaf.com: the storage
// as after the onboarding, so no run clicks through the terms and the tour;
// scripts/onboarded.mjs posts it, then reloads)
// ("trace": the session's last events and this script's errors, for a
// browser whose automation can't reach content scripts: Firefox)
const devErrors: string[] = [];
/** (localhost only: where startup got to, for the "trace" above) */
function devMark(m: string): void {
  if (location.hostname === "localhost") devErrors.push(`${Math.round(performance.now())} ${m}`);
}
if (location.hostname === "localhost") {
  addEventListener("error", (e) => devErrors.push(String(e.error?.stack ?? e.message)));
  addEventListener("unhandledrejection", (e) => devErrors.push(String((e.reason as Error)?.stack ?? e.reason)));
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.src !== "phitex-dev") return;
    if (e.data.type === "onboard") {
      const o = e.data.storage;
      if (o && typeof o === "object") void chrome.storage.local.set(o).then(() => window.postMessage({ src: "phitex-dev", type: "onboarded" }, location.origin));
    } else if (e.data.type === "trace") {
      const s = (globalThis as unknown as { __phitexSession?: { trace: unknown[] } }).__phitexSession;
      window.postMessage({ src: "phitex-dev", type: "traced", trace: JSON.stringify({ session: !!s, trace: s?.trace.slice(-30), errors: devErrors.slice(-30) }) }, location.origin);
    }
  });
}
/** A detached PDF tab follows this editor tab (then no floating window here: the PDF is there). */
let mirrored = false;
/** Closed docs are fetched again this often (collaborators' edits), and diffed in. */
const FOLLOW_MS = 10_000;

/** Doc paths → ids, from the file tree (every doc the tree has rendered). */
function docIds(): Map<string, string> {
  const ids = new Map<string, string>();
  for (const e of document.querySelectorAll<HTMLElement>('.file-tree-list [data-file-type="doc"][data-file-id]')) {
    const names: string[] = [];
    for (let li: Element | null = e.closest('[role="treeitem"]'); li; li = li.parentElement?.closest('[role="treeitem"]') ?? null)
      names.unshift(li.getAttribute("aria-label") ?? "");
    ids.set(names.join("/"), e.dataset.fileId!);
  }
  return ids;
}

/**
 * The project's text docs, each on its own: `/entities` for the paths, the
 * file tree for their ids, `/doc/:id/download` for the text (no binaries
 * ever fetched). A doc whose id the tree has not rendered (a folder never
 * opened) comes from the project ZIP, the one fallback.
 */
/** Where the project's binary files go (the core, by the offscreen document); set once connected. */
let giveBinary: ((path: string, bytes: Uint8Array) => Promise<unknown>) | undefined;
/** The project's binary files as last read (a compare's session gets them too). */
let lastBinaries: Record<string, Uint8Array> = {};

async function fetchDocs(panel: Panel, only?: (path: string) => boolean): Promise<Record<string, string>> {
  const t = performance.now();
  const files: Record<string, string> = {};
  if (!only) {
    // (the whole project: its ZIP, every doc's current text and the binary
    // files, figures, in one request, ~1 s; given to the core before the
    // first build. No waiting on the file tree, whose collapsed folders
    // never show their docs' ids)
    panel.reading({ h: "Downloading the project from Overleaf…" });
    const z = await pageFetch(`${project()}/download/zip`, { credentials: "include" });
    if (!z.ok) throw new Error(`project download failed: ${z.status}`);
    const size = Number(z.headers.get("content-length")) || 0;
    const mb = (n: number) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`);
    // (the bytes as they arrive, said on the card: Chrome's own fetch only;
    // Firefox's content.fetch gives the page's stream, which this script's
    // readers never finish reading)
    let own: Uint8Array;
    if (z.body && rawPageFetch === fetch) {
      const parts: Uint8Array[] = [];
      let got = 0;
      const rd = z.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        panel.reading({ h: "Downloading the project from Overleaf…", detail: size ? `${mb(got)} of ${mb(size)}` : mb(got), pct: size ? Math.min(100, Math.round((100 * got) / size)) : undefined });
      }
      own = new Uint8Array(got);
      let at = 0;
      for (const p of parts) (own.set(p, at), (at += p.length));
    } else {
      if (size) panel.reading({ h: "Downloading the project from Overleaf…", detail: mb(size) });
      // (copied into this script's own memory: Firefox's content.fetch gives
      // the page's ArrayBuffer, which this script's streams (DecompressionStream)
      // never finish reading)
      const pageBuf = new Uint8Array(await z.arrayBuffer());
      own = new Uint8Array(pageBuf.length);
      own.set(pageBuf);
    }
    const zbuf = own.buffer as ArrayBuffer;
    devMark(`zip ${zbuf.byteLength} bytes`);
    const { files: zipped, binaries: bin } = await readZip(zbuf, (name, k, n) => panel.reading({ h: "Unpacking the project…", detail: name, done: k + 1, total: n }));
    devMark(`unzipped ${Object.keys(zipped).length} files`);
    Object.assign(files, zipped);
    lastBinaries = bin;
    if (giveBinary) {
      // (figures and other binary files, handed to the engine before the first build)
      const all = Object.entries(bin);
      let given = 0;
      await Promise.all(
        all.map(async ([p, b]) => {
          await giveBinary!(p, b);
          panel.reading({ h: "Handing figures to the engine…", detail: p, done: ++given, total: all.length });
        }),
      );
    }
    panel.reading({ h: "Project read · checking packages…", detail: `${Object.keys(files).length} files, ${Object.keys(bin).length} figures and other files` });
    panel.files(Object.keys(files), [], `${(performance.now() - t).toFixed(0)} ms; ${Object.keys(bin).length} binary files`);
    return files;
  }
  // (a refresh, of the docs not open: each by its id, those the tree shows;
  // a doc it doesn't show waits for the next refresh or a reload)
  const r = await pageFetch(`${project()}/entities`, { credentials: "include" });
  if (!r.ok) throw new Error(`project listing failed: ${r.status}`);
  const { entities } = (await r.json()) as { entities: { path: string; type: string }[] };
  const ids = docIds();
  await Promise.all(
    entities
      .filter((e) => e.type === "doc")
      .map((e) => e.path.replace(/^\//, ""))
      .filter((p) => only(p) && ids.has(p))
      .map(async (p) => {
        const d = await pageFetch(`${project()}/doc/${ids.get(p)}/download`, { credentials: "include" });
        if (d.ok) files[p] = await d.text();
      }),
  );
  return files;
}

class OverleafHost implements EditorHost {
  private opens: ((f: string, t: string) => void)[] = [];
  private changes: ((f: string, e: Edit[], len?: number) => void)[] = [];
  private panel: Panel;
  constructor(panel: Panel) {
    this.panel = panel;
    window.addEventListener("message", (e) => {
      if (e.source !== window || e.data?.src !== "phitex-hook") return;
      const m = e.data;
      if (!m.file) return;
      if (m.type === "open") for (const cb of this.opens) cb(m.file, m.text);
      else if (m.type === "changes") {
        const es = m.edits.map(([from, to, text]: [number, number, string]) => ({ from, to, text }));
        for (const cb of this.changes) cb(m.file, es, m.len);
      }
    });
  }
  loadProject() {
    return fetchDocs(this.panel);
  }
  onOpen(cb: (f: string, t: string) => void) {
    this.opens.push(cb);
  }
  onChanges(cb: (f: string, e: Edit[], len?: number) => void) {
    this.changes.push(cb);
  }
  /** The whole text again (the session's copy differs from the editor's): the hook announces the open file. */
  resend() {
    window.postMessage({ src: "phitex-content", type: "hello" }, location.origin);
  }
  ready() {
    // (the hook announces the open file again: the editor's text, unsaved
    // edits and all, wins over the ZIP's)
    window.postMessage({ src: "phitex-content", type: "hello" }, location.origin);
  }
}

/** Whether the extension was reloaded or updated under this tab (its content script then cut off). */
const contextGone = () => !chrome.runtime?.id;
const GONE = "PhiTeX Instant was updated or reloaded: reload this tab to use it";
/**
 * Base64 to bytes: atob's string copied in a plain loop. Uint8Array.from
 * with a mapping function called it for every byte: the user's trace of a
 * fast scroll, 88 tasks of 700-1200 ms on the tab's thread, nearly all of
 * them here (the strips' pixels), Overleaf frozen meanwhile.
 */
function unb64(s: string): Uint8Array {
  const t = atob(s);
  const b = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i);
  return b;
}

/** A chrome port to the offscreen document (which relays to the worker). Bytes come base64. */
class ChromeTransport implements CoreTransport {
  private port!: chrome.runtime.Port;
  private nextId = 1;
  private waiting = new Map<number, (r: CoreRes) => void>();
  private lost: (() => void)[] = [];
  async connect(): Promise<void> {
    await chrome.runtime.sendMessage({ type: "ensure-offscreen" });
    this.port = chrome.runtime.connect({ name: "phitex" });
    // (the project: the core keeps the document's records under it)
    this.port.postMessage({ id: 0, op: "hello", project: project() });
    this.port.onMessage.addListener(async (r: any) => {
      if (r.event) return this.events.forEach((f) => f(r));
      // (bytes base64: the PDF for a download, a page's strips' pixels)
      if (r.pdf) r.pdf = unb64(r.pdf);
      if (r.bytes) r.bytes = unb64(r.bytes);
      this.waiting.get(r.id)?.(r);
      this.waiting.delete(r.id);
    });
    this.port.onDisconnect.addListener(() => {
      // (the extension reloaded or updated under this tab: this script is
      // cut off from it for good; said once, nothing retried)
      const gone = contextGone();
      for (const w of this.waiting.values()) w({ ok: false, error: gone ? GONE : "core disconnected" });
      this.waiting.clear();
      if (gone) return this.gone.forEach((f) => f());
      setTimeout(() => this.connect().then(() => this.lost.forEach((f) => f()), (e) => console.warn("[phitex] reconnect", e)), 500);
    });
  }
  /** Let go of the port (a compare stopped): its core session goes with it. */
  close(): void {
    this.port?.disconnect();
  }
  /** Called once if the extension is reloaded or updated under this tab. */
  onGone(cb: () => void) {
    this.gone.push(cb);
  }
  private gone: (() => void)[] = [];
  request(req: CoreReq): Promise<CoreRes> {
    const id = this.nextId++;
    if (contextGone()) return Promise.resolve({ ok: false, error: GONE } as CoreRes);
    return new Promise((res) => {
      this.waiting.set(id, res);
      this.port.postMessage({ id, ...req });
    });
  }
  onLost(cb: () => void) {
    this.lost.push(cb);
  }
  private events: ((e: CoreEvent) => void)[] = [];
  onEvent(cb: (e: CoreEvent) => void) {
    this.events.push(cb);
  }
}

const ZOOMS: [string, string][] = [["fit", "Fit width"], ["0.75", "75%"], ["1", "100%"], ["1.5", "150%"], ["2", "200%"]];

/** The diff's runner (diffui.ts): the real one set once the session is up (the toolbar comes first). */
let diffImpl: DiffRunner | undefined;
const diffRunner: DiffRunner = {
  start: (v, say, count) => (diffImpl ? diffImpl.start(v, say, count) : Promise.reject(new Error("the preview is still starting"))),
  show: (w) => diffImpl?.show(w),
  goto: (k) => diffImpl?.goto(k),
  download: (w) => diffImpl?.download(w),
  look: () => (diffImpl ? diffImpl.look() : Promise.resolve(LATEXDIFF_LOOK)),
  restyle: (l) => diffImpl?.restyle(l),
  stop: () => diffImpl?.stop(),
};

/** Styles for what we add to Overleaf's own DOM (the switch, the toolbar controls, the tip). */
const DOCK_CSS = `
  /* Overleaf's viewer stays laid out, only unseen: pdf.js scrolls it (recompile, SyncTeX) and needs its offsetParent */
  .phitex-on .pdf-viewer { visibility: hidden !important; pointer-events: none !important; }
  /* Overleaf's logs (its compiler's) too, while Instant shows: back as they were on the PDF tab */
  .phitex-on .new-logs-pane, .phitex-on .logs-pane { visibility: hidden !important; pointer-events: none !important; }
  /* Overleaf's SyncTeX arrows, beside the .pdf (not in it), over the ⚡ panel (its z-index 12) */
  body:has(.phitex-on) .synctex-controls { z-index: 13 !important; }
  /* in PhiTeX mode, Overleaf's viewer controls go, all but its invert-colors button (which works on ours too) */
  .phitex-on #toolbar-pdf-controls *:not(:has(.theme-toggle-btn)):not(.theme-toggle-btn):not(.theme-toggle-btn *) { display: none !important; }
  .phitex-on .toolbar-pdf-right { display: flex; align-items: center; justify-content: flex-end; min-width: 0; }
  /* its controls' wrapper keeps only the invert button: no room held for the hidden rest */
  .phitex-on #toolbar-pdf-controls, .phitex-on #toolbar-pdf-controls > * { flex: 0 0 auto !important; width: auto !important; }
  .phitex-on .toolbar-pdf-left { flex-shrink: 0; }
  #phitex-controls:not(.compact) .phitex-compact-only { display: none; }
  #phitex-controls.compact .pdfjs-toolbar-buttons, #phitex-controls.compact .pdfjs-page-number-input { display: none; }
  #phitex-switch { margin-left: 8px; display: inline-flex; align-items: center; position: relative; }
  #phitex-switch .toggle-switch { margin: 0; }
  #phitex-controls, #phitex-left { display: none !important; }
  .phitex-on #phitex-controls { display: flex !important; flex: 0 0 auto !important; width: auto !important; }
  .phitex-on #phitex-left { display: inline-flex !important; align-items: center; }
  /* in PhiTeX mode, Overleaf's own logs and download (its compiler's) give way to ours, in the same place */
  .phitex-on .toolbar-pdf-left > :not(.compile-button-group):not(#phitex-switch):not(#phitex-left) { display: none !important; }
  .phitex-badge:empty { display: none; }
  #phitex-dlgroup { position: relative; align-items: center; }
  #phitex-dlgroup .phitex-caret { width: 16px; min-width: 16px; margin-left: -4px; padding: 0; }
  #phitex-dlgroup .phitex-caret .material-symbols { font-size: 16px; }
  #phitex-dlmenu .dropdown-item { display: flex; justify-content: space-between; gap: 12px; }
  .phitex-toast { animation: phitex-callout-in .35s cubic-bezier(.2,1.2,.4,1); cursor: pointer; }
  .phitex-badge { position: absolute; top: -2px; right: -4px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 9999px;
    font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; color: #fff; background: var(--bg-info-01, #366cbf); }
  .phitex-badge.warning { background: var(--bg-warning-01, #8f5514); } .phitex-badge.error { background: var(--bg-danger-01, #b83a33); }
  #phitex-zoom-menu { min-width: 120px; }
  /* the build's status, as the panel says it ("Built · 42 ms"): Overleaf's toolbar text, its timings on a click */
  #phitex-status { display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums;
    max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
  #phitex-status .phitex-st-text { font-weight: 600; }
  #phitex-status .phitex-st-more { opacity: .75; }
  #phitex-status.err .phitex-st-text { color: var(--content-danger-dark, #e36d66); }
  [data-theme="light"] #phitex-status.err .phitex-st-text { color: var(--content-danger, #b83a33); }
  #phitex-status:empty, #phitex-status .phitex-st-text:empty + .phitex-st-more { display: none; }
  #phitex-consent .modal { z-index: 1070; } #phitex-consent .modal-backdrop { z-index: 1065; }
  #phitex-consent .form-check { margin-top: 12px; }
  #phitex-news .popover-body { max-height: 50vh; overflow: auto; }
  #phitex-news .phitex-news-title { font-weight: 700; margin-bottom: 4px; }
  #phitex-news ul { padding-left: 18px; margin: 0 0 10px; }
  #phitex-news li { margin-bottom: 4px; }
  label.phitex-dot-new { position: relative; }
  label.phitex-dot-new::before { content: ""; position: absolute; top: 2px; right: 4px; width: 7px; height: 7px; border-radius: 50%;
    background: var(--green-40, #53b57f); box-shadow: 0 0 0 2px var(--bg-dark-primary, #1b222c); }
  #phitex-tour .phitex-hl-demo { margin: 10px 0; padding: 8px; border-radius: 8px; background: rgb(0 0 0 / 22%); display: grid; gap: 8px; font-size: 12px; }
  #phitex-tour .phitex-hl-ed { position: relative; font-family: "DM Mono", monospace; color: var(--green-30, #86caa5); }
  #phitex-tour .phitex-hl-caret { position: absolute; top: 1px; left: 7ch; width: 2px; height: 1.2em; background: currentColor;
    animation: phitex-caret 3.6s steps(1) infinite, phitex-blink .6s steps(1) infinite; }
  #phitex-tour .phitex-hl-page { font-family: "Noto Serif", serif; color: #1b222c; background: #fff; border-radius: 3px; padding: 4px 8px; box-shadow: 0 2px 6px rgb(0 0 0 / 30%); }
  #phitex-tour .phitex-hl-page span { border-radius: 2px; animation: phitex-hl 3.6s steps(1) infinite; }
  #phitex-tour .phitex-hl-page .w2 { animation-delay: -2.4s; }
  #phitex-tour .phitex-hl-page .w3 { animation-delay: -1.2s; }
  @keyframes phitex-caret { 0% { left: 7ch; } 33.3% { left: 14ch; } 66.6% { left: 19ch; } }
  @keyframes phitex-blink { 50% { opacity: .3; } }
  @keyframes phitex-hl { 0% { background: rgb(255 214 0 / 70%); } 33.3% { background: transparent; } }
  #phitex-tour .phitex-choice { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  #phitex-tour .phitex-choice small { opacity: .8; }
  .phitex-dots { display: flex; gap: 5px; justify-content: center; margin-top: 10px; }
  .phitex-dots span { width: 6px; height: 6px; border-radius: 50%; background: rgb(255 255 255 / 25%); transition: all .2s; }
  .phitex-dots span.on { width: 16px; border-radius: 3px; background: var(--green-40, #53b57f); }
  .phitex-ring { position: relative; outline: 2px solid var(--green-40, #53b57f) !important; outline-offset: 2px; border-radius: 6px;
    animation: phitex-ringo 1.3s ease-out infinite; }
  phitex-preview.phitex-ring { outline-offset: -4px; }
  @keyframes phitex-ringo { 50% { outline-color: rgb(83 181 127 / 30%); } }
  #phitex-tip .phitex-demo { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 8px; margin: 10px 0 4px; padding: 8px;
    border-radius: 8px; background: rgb(0 0 0 / 22%); font-size: 12px; }
  #phitex-tip .phitex-demo code { color: var(--green-30, #86caa5); white-space: nowrap; overflow: hidden; border-right: 2px solid currentColor;
    width: 0; animation: phitex-type 2.4s steps(9) 1s infinite; font-family: "DM Mono", monospace; }
  #phitex-tip .phitex-demo .phitex-arrow { color: var(--green-30, #86caa5); animation: phitex-zip 2.4s ease-in 1s infinite; }
  #phitex-tip .phitex-demo .phitex-mini { justify-self: end; font-family: "Noto Serif", serif; color: #1b222c; background: #fff; border-radius: 3px;
    padding: 2px 8px; box-shadow: 0 2px 6px rgb(0 0 0 / 30%); opacity: .25; animation: phitex-paint 2.4s steps(1) 1s infinite; }
  @keyframes phitex-type { 0% { width: 0; } 55%, 100% { width: 9ch; } }
  @keyframes phitex-zip { 0%, 55% { transform: translateX(-4px); opacity: .3; } 62% { transform: translateX(6px); opacity: 1; } 100% { opacity: .3; } }
  @keyframes phitex-paint { 0%, 60% { opacity: .25; } 61%, 100% { opacity: 1; } }
  /* (the switch's ⚡ label, ringed by the tip (callout.ts's .phitex-pulse): lit, round) */
  label.phitex-pulse { border-radius: 9999px; background: rgb(83 181 127 / 25%); color: #fff !important; }
  @media (prefers-reduced-motion: reduce) {
    .phitex-ring, #phitex-tip .phitex-demo *, #phitex-tour .phitex-hl-demo * { animation: none !important; }
    #phitex-tip .phitex-demo code { width: 9ch; } #phitex-tip .phitex-demo .phitex-mini { opacity: 1; }
    #phitex-tour .phitex-hl-page .w1 { background: rgb(255 214 0 / 70%); }
  }`;

/**
 * The preview docked in Overleaf's PDF pane: a PDF | PhiTeX switch in its
 * toolbar (Overleaf's own toggle-switch markup and CSS), our controls in
 * its toolbar's right (its own buttons), our page in place of its viewer
 * (hidden, not removed). Checked again and again: React may render the
 * toolbar anew, the pane may open or close. Without the pane or its
 * toolbar (layout changed upstream, PDF closed), the panel floats: the
 * fallback.
 */
type Dock = { toggle(): boolean; tour(): void; news(): void; stop(): void; resume(): void };

function dockInOverleaf(panel: Panel): Dock {
  const PANE = ".pdf.full-size, .ide-redesign-pdf-container .pdf, .pdf";
  /** Without Overleaf's PDF pane this long after load, the preview floats (the fallback). */
  const FALLBACK_AFTER_MS = 8000;
  /** The full controls' width (⌃ ⌄, page, − +, zoom), and some air. */
  const FULL_CONTROLS_PX = 260;
  const started = performance.now();
  const style = document.createElement("style");
  style.textContent = DOCK_CSS;
  document.head.append(style);
  // (the popovers' styles, their animations the toast's too)
  calloutStyle();
  let mode: "pdf" | "phitex" = "pdf";
  /** (read after an await: `set` may have changed it, or refused) */
  const viewNow = () => mode;
  /** The tip shows on every load (on Overleaf's PDF) until "Don't show again". */
  let tipOff = true;
  let newsPending = false;
  const loadedAt = performance.now();
  chrome.storage.local.get(["view", "tipOff", "accepted"]).then(async ({ view, tipOff: off, accepted: a }) => {
    if (view === "phitex" || view === "pdf") mode = view;
    if (mode === "phitex" && a !== TERMS) mode = "pdf";
    tipOff = !!off;
    tick();
    if (!tipOff) setTimeout(tip, 1500);
    // (news after the tip, never both; shown by tick() once the switch exists)
    const { newsSeen, newsOff } = await chrome.storage.local.get(["newsSeen", "newsOff"]);
    newsPending = !newsOff && unseen(newsSeen as string | undefined, chrome.runtime.getManifest().version).length > 0;
  });
  let accepted = false;
  chrome.storage.local.get("accepted").then(({ accepted: a }) => (accepted = a === TERMS));

  /** Before the first use: an unofficial, experimental extension, as is, at the user's own risk. Overleaf's modal markup. */
  function consent(): Promise<boolean> {
    if (accepted) return Promise.resolve(true);
    // (one thing at a time: the terms, alone)
    for (const id of ["phitex-consent", "phitex-news", "phitex-tip", "phitex-tour"]) document.getElementById(id)?.remove();
    return new Promise((done) => {
      const m = document.createElement("div");
      m.id = "phitex-consent";
      m.innerHTML = `<div class="modal-backdrop fade show"></div>
        <div class="modal fade show d-block" role="dialog" aria-modal="true" aria-labelledby="phitex-consent-title" tabindex="-1">
          <div class="modal-dialog modal-dialog-centered"><div class="modal-content">
            <div class="modal-header"><h4 class="modal-title" id="phitex-consent-title">⚡ Instant: an unofficial extension</h4></div>
            <div class="modal-body">
              <p><b>PhiTeX Instant is not part of Overleaf</b>, and is not made, endorsed or supported by Overleaf. It is an
              <b>unofficial, experimental</b> browser extension that typesets LaTeX in your browser.</p>
              <p>It runs locally: your documents are not sent anywhere (TeX packages it doesn't bundle are downloaded by name from TeX Live's files). Its preview and PDF can differ from, or be missing what,
              Overleaf's compiler makes. For anything that matters, use Overleaf's <b>PDF</b>.</p>
              <p class="small text-muted">${asIs(chrome.runtime.getURL("LICENSE.txt"))}</p>
              <div class="form-check"><input class="form-check-input" type="checkbox" id="phitex-consent-check">
                <label class="form-check-label" for="phitex-consent-check">${AGREE}</label></div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-c="no">Cancel</button>
              <button type="button" class="btn btn-primary" data-c="yes" disabled>Enable ⚡ Instant</button>
            </div>
          </div></div>
        </div>`;
      document.body.append(m);
      const check = m.querySelector<HTMLInputElement>("#phitex-consent-check")!;
      const yes = m.querySelector<HTMLButtonElement>('[data-c="yes"]')!;
      check.onchange = () => (yes.disabled = !check.checked);
      const finish = (ok: boolean) => {
        m.remove();
        if (ok) {
          accepted = true;
          void chrome.storage.local.set({ accepted: TERMS });
        }
        done(ok);
      };
      yes.onclick = () => finish(true);
      m.querySelector<HTMLElement>('[data-c="no"]')!.onclick = () => finish(false);
      m.addEventListener("keydown", (e) => e.key === "Escape" && finish(false));
      check.focus();
    });
  }

  const set = async (m: "pdf" | "phitex") => {
    if (m === "phitex" && !(await consent())) {
      // (not accepted: stay on Overleaf's PDF)
      mode = "pdf";
      tick();
      return;
    }
    mode = m;
    void chrome.storage.local.set({ view: m });
    if (m === "phitex") hideTip();
    tick();
  };

  function switchEl(left: Element): HTMLElement {
    let sw = document.getElementById("phitex-switch");
    if (sw && left.contains(sw)) return sw;
    sw?.remove();
    sw = document.createElement("div");
    sw.id = "phitex-switch";
    sw.className = "editor-toggle-switch";
    sw.setAttribute("aria-label", "Preview: Overleaf's PDF or PhiTeX's");
    sw.innerHTML = `<form><fieldset class="toggle-switch"><legend class="visually-hidden">Preview</legend>
      <input type="radio" name="phitex-view" id="phitex-v-pdf" class="toggle-switch-input" value="pdf">
      <label for="phitex-v-pdf" class="toggle-switch-label" title="Overleaf's compiled PDF"><span>PDF</span></label>
      <input type="radio" name="phitex-view" id="phitex-v-phitex" class="toggle-switch-input" value="phitex">
      <label for="phitex-v-phitex" class="toggle-switch-label" title="⚡ Instant: added by the unofficial PhiTeX extension, not part of Overleaf (experimental) · Alt+Shift+P"><span>⚡ Instant</span></label>
    </fieldset></form>`;
    sw.addEventListener("change", (e) => void set((e.target as HTMLInputElement).value as "pdf" | "phitex"));
    left.append(sw);
    return sw;
  }

  /** Overleaf's viewer controls, markup for markup (so they look and theme the same), driving ours. */
  function controlsEl(right: Element): HTMLElement {
    let c = document.getElementById("phitex-controls");
    if (c && right.contains(c)) return c;
    c?.remove();
    c = document.createElement("div");
    c.id = "phitex-controls";
    c.className = "pdfjs-viewer-controls phitex-keep";
    const gbtn = (id: string, icon: string, label: string) =>
      `<button type="button" id="${id}" aria-label="${label}" title="${label}" class="d-inline-grid pdf-toolbar-btn pdfjs-toolbar-button btn btn-ghost">` +
      `<span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">${icon}</span></span></button>`;
    c.innerHTML =
      `<div role="group" class="pdfjs-toolbar-buttons btn-group">${gbtn("phitex-prev", "keyboard_arrow_up", "Previous page")}${gbtn("phitex-next", "keyboard_arrow_down", "Next page")}</div>` +
      `<div class="pdfjs-page-number-input"><form id="phitex-pform"><input id="phitex-page" aria-label="Page" inputmode="numeric" value="1"></form><span id="phitex-pages">/ 1</span></div>` +
      `<div class="pdfjs-zoom-controls"><div role="group" class="pdfjs-toolbar-buttons btn-group">${gbtn("phitex-zout", "remove", "Zoom out")}${gbtn("phitex-zin", "add", "Zoom in")}</div>` +
      `<div class="dropdown"><button type="button" id="phitex-zoom" aria-expanded="false" aria-label="PhiTeX zoom level" class="pdf-toolbar-btn pdfjs-zoom-dropdown-button small dropdown-toggle btn btn-link">100%</button>` +
      `<ul class="dropdown-menu dropdown-menu-end" id="phitex-zoom-menu" role="menu">` +
      ZOOMS.map(([v, l]) => `<li><button type="button" class="dropdown-item" data-zoom="${v}">${l}</button></li>`).join("") +
      `<li><hr class="dropdown-divider"></li><li><button type="button" class="dropdown-item" data-act="clean" title="Read the project again and typeset it from the start (PhiTeX)">Clean rebuild</button></li>` +
      `<li><button type="button" class="dropdown-item" data-act="more">PhiTeX settings and timings…</button></li></ul></div></div>` +
      // (compact, as Overleaf's own narrow layout: page and zoom steps behind ⋯)
      `<div class="dropdown phitex-compact-only"><button type="button" id="phitex-more" aria-label="More" class="d-inline-grid pdf-toolbar-btn pdfjs-toolbar-popover-button btn btn-ghost">` +
      `<span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">more_horiz</span></span></button>` +
      `<ul class="dropdown-menu dropdown-menu-end" id="phitex-more-menu" role="menu">` +
`<li><button type="button" class="dropdown-item" data-act="clean" title="Read the project again and typeset it from the start (PhiTeX)">Clean rebuild</button></li><li><hr class="dropdown-divider"></li>` +
      `<li><button type="button" class="dropdown-item" data-act="prev">Previous page</button></li><li><button type="button" class="dropdown-item" data-act="next">Next page</button></li>` +
      `<li><hr class="dropdown-divider"></li><li><button type="button" class="dropdown-item" data-act="zin">Zoom in</button></li><li><button type="button" class="dropdown-item" data-act="zout">Zoom out</button></li>` +
      `<li><hr class="dropdown-divider"></li><li><button type="button" class="dropdown-item" data-act="more">PhiTeX settings and timings…</button></li></ul></div>`;
    const q = (id: string) => c!.querySelector<HTMLElement>(`#${id}`)!;
    q("phitex-prev").onclick = () => panel.prev();
    q("phitex-next").onclick = () => panel.next();
    q("phitex-zout").onclick = () => panel.zoomStep(-1);
    q("phitex-zin").onclick = () => panel.zoomStep(1);
    q("phitex-pform").onsubmit = (e) => {
      e.preventDefault();
      const k = Number((q("phitex-page") as HTMLInputElement).value);
      if (k >= 1) panel.goPage(k - 1);
    };
    const menus: HTMLElement[] = [];
    const dropdown = (button: HTMLElement, menu: HTMLElement) => {
      menus.push(menu);
      button.onclick = (e) => {
        e.stopPropagation();
        const open = !menu.classList.contains("show");
        for (const m of menus) m.classList.remove("show");
        menu.classList.toggle("show", open);
        button.setAttribute("aria-expanded", String(open));
        Object.assign(menu.style, open ? { position: "absolute", inset: "100% 0 auto auto" } : {});
      };
      menu.onclick = (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>("[data-zoom], [data-act]");
        const act = b?.dataset.act;
        if (b?.dataset.zoom) panel.zoomTo(b.dataset.zoom);
        if (act === "more") panel.sheet(true);
        if (act === "clean") panel.clean();
        if (act === "prev") panel.prev();
        if (act === "next") panel.next();
        if (act === "zin") panel.zoomStep(1);
        if (act === "zout") panel.zoomStep(-1);
        menu.classList.remove("show");
      };
    };
    dropdown(q("phitex-zoom"), q("phitex-zoom-menu"));
    dropdown(q("phitex-more"), q("phitex-more-menu"));
    document.addEventListener("click", () => menus.forEach((m) => m.classList.remove("show")));
    const native = right.querySelector("#toolbar-pdf-controls");
    if (native) native.after(c);
    else right.append(c);
    return c;
  }

  const compiledLink = () => document.querySelector<HTMLAnchorElement>('.toolbar-pdf-left a[aria-label="Download PDF"][href]');

  /** The first Instant download says what it is, once: Overleaf's popover, under the button. */
  function explainOnce(anchor: Element): void {
    chrome.storage.local.get("dlExplained").then(({ dlExplained }) => {
      if (dlExplained) return;
      void chrome.storage.local.set({ dlExplained: true });
      const b = anchor.querySelector("#phitex-dlgroup")!.getBoundingClientRect();
      const t = document.createElement("div");
      t.className = "popover bs-popover-bottom show phitex-toast";
      t.setAttribute("role", "status");
      t.innerHTML = `<div class="popover-body">This is the <b>⚡ Instant</b> preview's PDF (PhiTeX, experimental), named <code>…-instant.pdf</code>.
        Overleaf's compiled PDF is in the <b>▾</b> menu, or on the PDF tab.</div>`;
      Object.assign(t.style, { position: "fixed", left: `${Math.max(8, b.left - 20)}px`, top: `${b.bottom + 8}px`, maxWidth: "280px", zIndex: "1060" });
      document.body.append(t);
      setTimeout(() => t.remove(), 7000);
      t.onclick = () => t.remove();
    });
  }

  /**
   * The panel's status ("Built · 42 ms", "Built with 1 error"), from its
   * state (ViewState.status), shown in the toolbar's (the panel's own bar is
   * hidden here, Overleaf's toolbar being the bar).
   */
  let statusNow: ViewState["status"] | null = null;
  function mirrorStatus(st: ViewState["status"] | null = statusNow): void {
    statusNow = st;
    const b = document.getElementById("phitex-status");
    if (!b || !st) return;
    b.querySelector(".phitex-st-text")!.textContent = st.text;
    b.querySelector(".phitex-st-more")!.textContent = st.more ? `· ${st.more}` : "";
    b.classList.toggle("err", st.err);
  }

  /** In Overleaf's left toolbar, where its logs and download are: ours (PhiTeX's diagnostics and PDF). */
  function leftEl(left: Element): HTMLElement {
    let l = document.getElementById("phitex-left");
    if (l && left.contains(l)) return l;
    l?.remove();
    l = document.createElement("div");
    l.id = "phitex-left";
    l.innerHTML =
      // (a clean recompile of ⚡ Instant alone: the project read again, typeset from the start)
      `<button type="button" id="phitex-clean" aria-label="Clean rebuild (Instant)" title="⚡ Instant: clean rebuild, the project read again and typeset from the start (PhiTeX)" class="d-inline-grid pdf-toolbar-btn toolbar-item btn btn-link">` +
      `<span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">refresh</span></span></button>` +
      `<button type="button" id="phitex-logs" aria-label="PhiTeX diagnostics" title="PhiTeX diagnostics" class="d-inline-grid pdf-toolbar-btn toolbar-item log-btn btn btn-link" style="position: relative;">` +
      `<span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">description</span></span>` +
      `<span class="phitex-badge" id="phitex-badge"></span></button>` +
      // (the build's status, mirrored from the panel's own bar, hidden here: Overleaf's toolbar is the bar)
      `<button type="button" id="phitex-status" aria-label="The last build's times (PhiTeX)" title="The last build's times: click for the details (PhiTeX)" class="pdf-toolbar-btn toolbar-item btn btn-link">` +
      `<span class="phitex-st-text"></span><span class="phitex-st-more"></span></button>` +
      // (download what you see: this tab's PDF; the other one in the ▾ menu)
      `<div class="dropdown btn-group" id="phitex-dlgroup">` +
      `<button type="button" id="phitex-dl" aria-label="Download the Instant PDF" title="Download the ⚡ Instant PDF (PhiTeX, experimental)" class="d-inline-grid pdf-toolbar-btn toolbar-item btn btn-link">` +
      `<span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">download</span></span></button>` +
      `<button type="button" id="phitex-dlmore" aria-label="Which PDF to download" title="Which PDF to download" aria-expanded="false" class="d-inline-grid pdf-toolbar-btn toolbar-item btn btn-link phitex-caret">` +
      `<span class="material-symbols" aria-hidden="true" translate="no">expand_more</span></button>` +
      `<ul class="dropdown-menu" id="phitex-dlmenu" role="menu">` +
      `<li><button type="button" class="dropdown-item" data-dl="instant">⚡ Instant PDF <span class="text-muted small">PhiTeX, experimental</span></button></li>` +
      `<li><button type="button" class="dropdown-item" data-dl="compiled">Compiled PDF <span class="text-muted small">Overleaf</span></button></li></ul></div>`;
    l.querySelector<HTMLElement>("#phitex-clean")!.onclick = () => panel.clean();
    l.querySelector<HTMLElement>("#phitex-logs")!.onclick = () => panel.diagnostics();
    l.querySelector<HTMLElement>("#phitex-status")!.onclick = (e) => (e.stopPropagation(), panel.sheet());
    const menu = l.querySelector<HTMLElement>("#phitex-dlmenu")!,
      more = l.querySelector<HTMLElement>("#phitex-dlmore")!;
    const instant = () => {
      panel.pdf();
      explainOnce(l!);
    };
    l.querySelector<HTMLElement>("#phitex-dl")!.onclick = instant;
    more.onclick = (e) => {
      e.stopPropagation();
      // (Overleaf's compiled PDF: its own download link, there once it has compiled)
      const native = compiledLink();
      const item = menu.querySelector<HTMLButtonElement>('[data-dl="compiled"]')!;
      item.disabled = !native;
      item.title = native ? "The PDF of Overleaf's last compile" : "Recompile first: Overleaf has no PDF yet";
      const open = !menu.classList.contains("show");
      menu.classList.toggle("show", open);
      more.setAttribute("aria-expanded", String(open));
      Object.assign(menu.style, open ? { position: "absolute", inset: "100% auto auto 0" } : {});
    };
    menu.onclick = (e) => {
      const which = (e.target as HTMLElement).closest<HTMLElement>("[data-dl]")?.dataset.dl;
      menu.classList.remove("show");
      if (which === "instant") instant();
      if (which === "compiled") compiledLink()?.click();
    };
    document.addEventListener("click", () => menu.classList.remove("show"));
    // (compare with a past version: diffui.ts)
    compareButton(l, panel, project, pageFetch, diffRunner);
    const group = left.querySelector(".compile-button-group");
    if (group) group.after(l);
    else left.prepend(l);
    mirrorStatus();
    return l;
  }

  panel.onState((s) => {
    mirrorStatus(s.status);
    const c = document.getElementById("phitex-controls");
    if (c) {
      const input = c.querySelector<HTMLInputElement>("#phitex-page")!;
      if (document.activeElement !== input) input.value = s.pages ? String(s.page + 1) : "0";
      input.setAttribute("aria-label", `Page ${s.page + 1}, Current Page`);
      c.querySelector("#phitex-pages")!.textContent = `/ ${s.pages}`;
      (c.querySelector("#phitex-prev") as HTMLButtonElement).disabled = s.page <= 0;
      (c.querySelector("#phitex-next") as HTMLButtonElement).disabled = s.page >= s.pages - 1;
      c.querySelector("#phitex-zoom")!.textContent = `${s.percent}%`;
    }
    const b = document.getElementById("phitex-badge");
    if (b) {
      b.textContent = s.diagCount ? String(s.diagCount) : "";
      b.className = `phitex-badge ${s.diagWorst}`;
      document.getElementById("phitex-logs")!.title = `PhiTeX diagnostics${s.diagCount ? ` (${s.diagCount})` : ""} · ${s.chip}`;
    }
  });

  /** The first-run tip, pointing at the switch (callout.ts). */
  let tipBox: Callout | undefined;
  function tip(): void {
    const sw = document.getElementById("phitex-switch");
    if (tipOff || mode !== "pdf" || !sw || tipBox) return;
    const label = sw.querySelector('label[for="phitex-v-phitex"]') as HTMLElement;
    const never = h("button", { type: "button", class: "btn btn-link btn-sm phitex-callout-never" }, "Don't show again");
    const no = h("button", { type: "button", class: "btn btn-secondary btn-sm" }, "Not now");
    const yes = h("button", { type: "button", class: "btn btn-primary btn-sm" }, "⚡ Try it");
    tipBox = callout({
      id: "phitex-tip",
      label: "Try the PhiTeX preview",
      anchor: label,
      shiny: true,
      header: [h("span", { class: "phitex-callout-icon", "aria-hidden": "true" }, "⚡"), "New: the unofficial PhiTeX extension"],
      body: {
        html: `No more Recompile: PhiTeX repaints this page <b>as you type</b>, incrementally, in milliseconds, right in your browser. Nothing leaves it.
        <div class="phitex-demo" aria-hidden="true"><code>Hello TeX</code><span class="phitex-arrow">⚡→</span><span class="phitex-mini">Hello TeX</span></div>
        <div class="small text-muted" style="margin-top:6px">An unofficial browser extension, not an Overleaf feature. Experimental. Overleaf's PDF is one click away.</div>`,
      },
      actions: [never, no, yes],
      onHide: () => (tipBox = undefined),
    });
    yes.onclick = async () => {
      await set("phitex");
      if (viewNow() !== "phitex") return;
      const { toured } = await chrome.storage.local.get("toured");
      if (!toured) setTimeout(() => void tour(0), 700);
    };
    no.onclick = hideTip;
    never.onclick = () => {
      tipOff = true;
      void chrome.storage.local.set({ tipOff: true });
      hideTip();
    };
  }

  /** Until the next load. */
  function hideTip(): void {
    tipBox?.hide();
  }

  /** What's new: once after an update (or from settings), in the tip's style. */
  async function whatsNew(force = false): Promise<void> {
    const current = chrome.runtime.getManifest().version;
    const { newsSeen } = await chrome.storage.local.get("newsSeen");
    const items: News[] = force ? unseen(undefined, current).slice(0, 3) : unseen(newsSeen as string | undefined, current);
    const sw = document.getElementById("phitex-switch");
    if (!items.length || !sw || document.getElementById("phitex-news") || document.getElementById("phitex-tip")) return;
    const label = sw.querySelector('label[for="phitex-v-phitex"]') as HTMLElement;
    const links = [items[0].link, SUPPORT]
      .filter((l): l is { label: string; href: string } => !!l)
      .map((l) => h("a", { class: "btn btn-secondary btn-sm", target: "_blank", rel: "noopener", href: l.href }, l.label));
    const ok = h("button", { type: "button", class: "btn btn-primary btn-sm" }, "Got it");
    const c = callout({
      id: "phitex-news",
      label: "What's new in the PhiTeX extension",
      anchor: label,
      width: 340,
      header: [h("span", { "aria-hidden": "true" }, "✨"), `What's new in PhiTeX ${items[0].version}`],
      body: {
        html:
          items
            .map((n) => `<div class="phitex-news-entry"><div class="phitex-news-title">${n.title} <span class="text-muted small">${n.version} · ${n.date}</span></div><ul>${n.items.map((i) => `<li>${i}</li>`).join("")}</ul></div>`)
            .join("") + `<div class="small text-muted">From the unofficial PhiTeX extension, not Overleaf.</div>`,
      },
      actions: [...links, ok],
    });
    ok.onclick = () => {
      c.hide();
      label.classList.remove("phitex-dot-new");
      void chrome.storage.local.set({ newsSeen: current });
      // (then the controls the notes are about, pointed at: every one when asked for, else those not seen)
      if (mode === "phitex") setTimeout(() => void featureTips(force), 400);
    };
  }

  /**
   * Feature tips: Overleaf's popover pointing at one of our controls, saying
   * what it does, each once (tipsSeen); What's new shows them all again.
   */
  const TIPS: { id: string; at: () => Element | null; title: string; body: string; isNew?: boolean }[] = [
    { id: "compare", at: () => document.getElementById("phitex-cmp"), isNew: true, title: "Compare versions", body: "See what changed since any version in the project's history, marked on the page as <code>latexdiff</code> marks it: additions in blue, deletions struck out. It follows your edits." },
    { id: "timing", at: () => document.getElementById("phitex-status"), title: "How long it took", body: "The last build, and how long a keystroke takes to reach the page. Click it for the details." },
    { id: "clean", at: () => document.getElementById("phitex-clean"), title: "Clean rebuild", body: "Builds already run as you type. This one reads the project again and typesets it from the start." },
    { id: "dark", at: () => document.querySelector("#toolbar-pdf-controls .theme-toggle-btn"), title: "Dark PDF", body: "Overleaf's dark PDF switch darkens ⚡ Instant's pages too. Off by default: it inverts figures and photos as well." },
  ];
  async function featureTips(all = false, k = 0): Promise<void> {
    document.getElementById("phitex-feature")?.remove();
    document.querySelectorAll(".phitex-ring").forEach((e) => e.classList.remove("phitex-ring"));
    if (mode !== "phitex" || document.getElementById("phitex-tour") || document.getElementById("phitex-tip")) return;
    const { tipsSeen } = await chrome.storage.local.get("tipsSeen");
    const seen = new Set<string>(all ? [] : ((tipsSeen as string[] | undefined) ?? []));
    const left = TIPS.filter((t) => !seen.has(t.id) && t.at());
    const tip = left[k];
    if (!tip) return;
    const target = tip.at()!;
    target.classList.add("phitex-ring");
    const button = (t: string, cls: string, label: string) => h("button", { type: "button", class: `btn ${cls} btn-sm`, "data-t": t }, label);
    const { el } = callout({
      id: "phitex-feature",
      label: tip.title,
      anchor: target,
      header: [...(tip.isNew ? [h("span", { class: "badge bg-primary" }, "New")] : []), h("span", {}, tip.title), h("span", { class: "phitex-callout-step" }, `${k + 1} of ${left.length}`)],
      body: { html: tip.body },
      actions: [button("skip", "btn-link phitex-callout-never", "Skip"), button("next", "btn-primary", k === left.length - 1 ? "Got it" : "Next")],
    });
    // (seen once shown: a tip never comes back by itself)
    void chrome.storage.local.set({ tipsSeen: [...new Set([...((tipsSeen as string[] | undefined) ?? []), tip.id])] });
    el.onclick = async (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-t]")?.dataset.t;
      if (!a) return;
      document.getElementById("phitex-feature")?.remove();
      target.classList.remove("phitex-ring");
      if (a === "skip") return void chrome.storage.local.set({ tipsSeen: TIPS.map((t) => t.id) });
      if (all) return void featureTips(true, k + 1);
      void featureTips(false, 0);
    };
  }

  /** The walkthrough: Overleaf's popover, a step at a time, the thing it explains ringed. */
  /** The highlight step's choice: the "follow" setting's values, the first recommended. */
  const FOLLOW: [string, string][] = [["cursor", "Cursor"], ["select", "Selection"], ["dblclick", "Double-click only"]];
  // (a mini editor line, its caret going word to word, and a mini page whose same word turns yellow in step)
  const HIGHLIGHT_DEMO = `<div class="phitex-hl-demo" aria-hidden="true">
      <div class="phitex-hl-ed"><span>Instant typing here</span><i class="phitex-hl-caret"></i></div>
      <div class="phitex-hl-page"><span class="w1">Instant</span> <span class="w2">typing</span> <span class="w3">here</span></div></div>`;
  const STEPS: { at: () => Element | null; title: string; body: string; inside?: boolean; choice?: boolean }[] = [
    { at: () => document.getElementById("phitex-switch"), title: "Two previews, one click", body: "<b>PDF</b> is Overleaf's compiler, as always. <b>⚡ Instant</b> is added by the unofficial PhiTeX extension (not part of Overleaf), live. Switch any time, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>." },
    { at: () => document.querySelector("phitex-preview"), inside: true, title: "Type, and watch", body: "Edit anything in the editor: this page repaints as you type, usually in a few milliseconds. The status in the toolbar says how fast. No Recompile." },
    { at: () => document.querySelector("phitex-preview"), inside: true, choice: true, title: "The yellow highlight", body: `Where you are in the source is marked on the page in yellow.${HIGHLIGHT_DEMO}When should it move?` },
    { at: () => document.getElementById("phitex-logs"), title: "What PhiTeX couldn't read", body: "Diagnostics, with a count. Click one to jump to its line. Errors from the build, missing packages, and what LaTeX looked for and did not find." },
    { at: () => document.getElementById("phitex-dlgroup"), title: "Download what you see", body: "This downloads the <b>⚡ Instant</b> PDF (<code>…-instant.pdf</code>). The <b>▾</b> menu has Overleaf's compiled PDF too." },
    { at: () => document.getElementById("phitex-zoom"), title: "Zoom, and the details", body: "Zoom like Overleaf's viewer. At the bottom of this menu: settings and timings (main file, a debug check against a fresh build). Everything runs in your browser; nothing leaves it." },
  ];

  async function tour(k = 0): Promise<void> {
    endTour();
    if (mode !== "phitex") {
      await set("phitex");
      if (viewNow() !== "phitex") return;
    }
    const step = STEPS[k];
    const target = step?.at();
    if (!step || !target) return endTour(true);
    target.classList.add("phitex-ring");
    const button = (t: string, cls: string, label: string) => h("button", { type: "button", class: `btn ${cls} btn-sm`, "data-t": t }, label);
    const { el: t } = callout({
      id: "phitex-tour",
      label: `Tour, step ${k + 1} of ${STEPS.length}`,
      anchor: target,
      inside: step.inside,
      header: [h("span", {}, step.title), h("span", { class: "phitex-callout-step" }, `${k + 1} of ${STEPS.length}`)],
      body: {
        html: `${step.body}
        <div class="phitex-dots">${STEPS.map((_, i) => `<span class="${i === k ? "on" : ""}"></span>`).join("")}</div>
        ${step.choice ? `<div class="phitex-choice">${FOLLOW.map(([v, l], i) => `<button type="button" class="btn ${i ? "btn-secondary" : "btn-primary"} btn-sm" data-f="${v}">${l}${i ? "" : " <small>(recommended)</small>"}</button>`).join("")}</div>` : ""}`,
      },
      actions: [
        button("skip", "btn-link phitex-callout-never", "Skip"),
        ...(k ? [button("back", "btn-secondary", "Back")] : []),
        ...(step.choice ? [] : [button("next", "btn-primary", k === STEPS.length - 1 ? "Done" : "Next")]),
      ],
    });
    t.onclick = (e) => {
      // (the highlight step: the choice saved, then on)
      const f = (e.target as HTMLElement).closest<HTMLElement>("[data-f]")?.dataset.f;
      if (f) return void chrome.storage.local.set({ follow: f }).then(() => tour(k + 1));
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-t]")?.dataset.t;
      if (a === "next") void tour(k + 1);
      if (a === "back") void tour(k - 1);
      if (a === "skip") endTour(true);
    };
    t.querySelector<HTMLElement>('[data-t="next"], [data-f]')!.focus();
  }

  function endTour(done = false): void {
    document.getElementById("phitex-tour")?.remove();
    document.querySelectorAll(".phitex-ring").forEach((e) => e.classList.remove("phitex-ring"));
    if (done) void chrome.storage.local.set({ toured: true });
  }
  addEventListener("keydown", (e) => e.key === "Escape" && document.getElementById("phitex-tour") && endTour(true));
  // (Ctrl/⌘+S or Ctrl/⌘+Enter, a writer's habit, in ⚡ Instant: a note that there is
  // nothing to do; once in a while, not each press; Overleaf's own keys as they were)
  let habitSaid = -Infinity;
  addEventListener(
    "keydown",
    (e) => {
      if (mode !== "phitex" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !(e.key === "s" || e.key === "S" || e.key === "Enter")) return;
      if (performance.now() - habitSaid < 10_000) return;
      habitSaid = performance.now();
      panel.msg("No need to save or compile: ⚡ Instant typesets as you type, and Overleaf saves by itself.", false, true);
    },
    true,
  );

  function tick(): void {
    // (a hidden tab: nothing to place; the next visible tick does it)
    if (document.hidden) return;
    const pane = document.querySelector<HTMLElement>(PANE);
    const left = pane?.querySelector(".toolbar-pdf-left");
    let right = pane?.querySelector(".toolbar-pdf-right");
    // (a detached tab Overleaf thinks orphaned has no right side: ours, then)
    if (pane && left && !right) {
      right = document.createElement("div");
      right.className = "toolbar-pdf-right";
      left.parentElement!.append(right);
    }
    if (!pane || !left || !right) {
      // (Overleaf renders its layout late: wait for it before falling back to the window)
      if (performance.now() - started < FALLBACK_AFTER_MS) return;
      if (mirrored || DETACHED) return panel.shown(false);
      panel.dock(null);
      panel.shown(true);
      document.getElementById("phitex-tip")?.remove();
      return;
    }
    const sw = switchEl(left);
    leftEl(left);
    // (Overleaf's Recompile, in ⚡ Instant: our clean recompile too, the
    // button the writer already reaches for; Overleaf still compiles its own)
    const rc = left.querySelector<HTMLButtonElement>(".compile-button-group button");
    if (rc && !rc.dataset.phitex) {
      rc.dataset.phitex = "1";
      rc.addEventListener("click", () => mode === "phitex" && panel.clean(), true);
    }
    // (its menu's "Recompile from scratch": ⚡ Instant's from scratch too; told by
    // being the plain item right after a divider, the labels being translated)
    const scratch = [...left.querySelectorAll<HTMLElement>(".compile-button-group .dropdown-menu .dropdown-item")].find((b) => !b.querySelector("input, .material-symbols") && b.closest("li")?.previousElementSibling?.matches('[role="separator"]'));
    if (scratch && !scratch.dataset.phitex) {
      scratch.dataset.phitex = "1";
      scratch.addEventListener("click", () => mode === "phitex" && panel.clean(), true);
    }
    if (rc) rc.title = mode === "phitex" ? "Recompile: Overleaf's PDF, and ⚡ Instant from scratch (PhiTeX)" : (rc.title.startsWith("Recompile: Overleaf") ? "" : rc.title);
    // (compact when the full controls do not fit what the toolbar has left: measured here,
    // not taken from Overleaf's own choice, which counts our switch against its room)
    const ctl = controlsEl(right);
    if (mode === "phitex") {
      const bar = pane.querySelector<HTMLElement>(".toolbar-pdf") ?? pane;
      const used = left.getBoundingClientRect().width + (right.querySelector(".theme-toggle-btn")?.getBoundingClientRect().width ?? 0);
      ctl.classList.toggle("compact", bar.clientWidth - used < FULL_CONTROLS_PX);
    }
    (sw.querySelector(`input[value="${mode}"]`) as HTMLInputElement).checked = true;
    if (newsPending) {
      sw.querySelector('label[for="phitex-v-phitex"]')?.classList.add("phitex-dot-new");
      // (a moment after the switch appears, and not over the welcome tip)
      if (performance.now() - loadedAt > 2500 && !document.getElementById("phitex-tip")) {
        newsPending = false;
        void whatsNew();
      }
    }
    // (the feature tips not seen yet: once a load, in ⚡ Instant, after the news and any tour or tip)
    if (!tipsTried && !newsPending && mode === "phitex" && performance.now() - loadedAt > 4000) {
      tipsTried = true;
      void chrome.storage.local.get("toured").then(({ toured }) => toured && featureTips());
    }
    panel.dock(pane, pane.querySelector(".toolbar-pdf"));
    pane.classList.toggle("phitex-on", mode === "phitex");
    panel.shown(mode === "phitex");
  }
  let tipsTried = false;
  let timer = setInterval(tick, 700);
  /** The extension turned off: everything we added goes; Overleaf is as it was. */
  function stop(): void {
    clearInterval(timer);
    endTour();
    hideTip();
    for (const id of ["phitex-switch", "phitex-controls", "phitex-left", "phitex-news", "phitex-consent"]) document.getElementById(id)?.remove();
    document.querySelector(".phitex-on")?.classList.remove("phitex-on");
    panel.shown(false);
  }
  void chrome.storage.local.get("speedOff").then(({ speedOff }) => panel.speedChip(!speedOff));
  chrome.storage.onChanged.addListener((c) => {
    if (c.speedOff) panel.speedChip(!c.speedOff.newValue);
    // (a reset removes the keys: newValue undefined is the default)
    if (c.view && (c.view.newValue ?? "pdf") !== mode) void set(c.view.newValue === "phitex" ? "phitex" : "pdf");
    if (c.tipOff) {
      tipOff = !!c.tipOff.newValue;
      if (tipOff) hideTip();
    }
    if (c.accepted) {
      accepted = c.accepted.newValue === TERMS;
      if (!accepted && mode === "phitex") void set("pdf");
    }
  });
  return {
    stop,
    resume: () => {
      clearInterval(timer);
      timer = setInterval(tick, 700);
      tick();
    },
    news: () => void whatsNew(true),
    tour: () => void tour(0),
    toggle: () => {
      if (!document.getElementById("phitex-switch")) return false;
      void set(mode === "pdf" ? "phitex" : "pdf");
      return true;
    },
  };
}

/** Only Overleaf's editor (/project/<24 hex id>), not its other pages under /project/. */
const EDITOR = /^\/project\/[0-9a-f]{24}(\/detached)?\/?$/;

(async () => {
  if (!EDITOR.test(location.pathname) && !location.hostname.startsWith("localhost")) return;
  let session: PreviewSession;
  let dock: Dock | undefined;
  /** The compare (diffui.ts, compare.ts): its own session, the marked-up document's; set once the session is. */
  let compare: Compare<Version> | undefined;
  /** The session the panel shows: the compare's while its diff is in view. */
  const shown = () => compare?.shown() ?? session;
  const ch = channel(project());
  const ask = (a: Ask) => ch.postMessage(a);
  /** The pages as strips over the core's transport (set once the transport is). */
  let pages: StripPages | undefined;
  const panel = new Panel({
    onFind: (q) => pages?.find(q) ?? Promise.resolve([]),
    onPage: (p) => (DETACHED ? ask({ t: "page", k: p }) : shown()?.setPage(p)),
    onNeed: (k) => (DETACHED ? ask({ t: "need", k }) : shown()?.fetch(k)),
    onPdf: async () => {
      const pdf = await session?.pdf();
      // (a job that stopped, at a fatal error or a missing file, left pdfTeX's file
      // unfinished: no xref, no trailer, which no viewer opens; said, not saved)
      const tail = pdf && new TextDecoder("latin1").decode(pdf.subarray(Math.max(0, pdf.length - 64)));
      if (!pdf || !pdf.length || !tail!.includes("%%EOF")) {
        panel.msg("No complete PDF yet: the build stopped before the end of the document (see ⓘ diagnostics). Fix that, or download Overleaf's compiled PDF from the ▾ menu.", true);
        return;
      }
      // (a XeLaTeX project approximated: asked again, the file named so)
      if (panel.approx && !confirm("This PDF is an approximation: the project needs XeLaTeX, and ⚡ Instant made it with pdfLaTeX, its fonts substituted and its layout possibly different from Overleaf's.\n\nFor the real PDF, use Overleaf's (the PDF tab).\n\nDownload the approximation anyway?")) return;
      const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(session.main ?? "phitex").replace(/\.tex$/, "").replace(/.*\//, "")}${panel.approx ? "-approx" : ""}-instant.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
    onDebug: (on) => session && (session.debug = on),
    onMain: (m) => session?.setMain(m),
    // (the hook moves the editor's cursor there: the one thing it writes)
    onGoto: (file, line) => DETACHED ? ask({ t: "goto", file, line }) : window.postMessage({ src: "phitex-content", type: "goto", file, line }, location.origin),
    onSyncSource: (k, x, y) => (DETACHED ? ask({ t: "sync", k, x, y }) : void shown()?.toSource(k, x, y)),
    // (the editor tab's panel does it; a detached tab's, told the same, does not)
    // (the card's choice: this project's engine from now on, kept by project)
    onEngine: async (e) => {
      const { engines } = await chrome.storage.local.get("engines");
      await chrome.storage.local.set({ engines: { ...(engines ?? {}), [project()]: e } });
    },
    // (the anonymized debug report: report.ts, shown before it is sent)
    onReport: async () => {
      const m = chrome.runtime.getManifest();
      return session?.report({ version: m.version, engine: m.version_name?.match(/engine ([0-9a-f]+)/)?.[1] ?? "?", userAgent: navigator.userAgent }) ?? "No session yet: nothing to report.";
    },
    onGotoRange: (file, from, to, focus) => DETACHED || window.postMessage({ src: "phitex-content", type: "gotoRange", file, from, to, focus }, location.origin),
    onSelectPage: (sel) => (DETACHED ? undefined : void shown()?.selectPage(sel)),
    onReload: async () => session?.refresh(await fetchDocs(panel)),
    onClean: async () => session?.clean(await fetchDocs(panel)),
    onShortcut: () => dock?.toggle() ?? false,
    onTour: () => dock?.tour(),
    onNews: () => dock?.news(),
    // (the contents opened: the outline of the session shown, asked for now)
    onContents: () => void shown()?.outline(),
    // (the toolbar's compare: its versions' menu, diffui.ts)
    onCompare: () => document.getElementById("phitex-cmp")?.click(),
    // (the packs kept in this browser: the extension's store, emptied by the service worker)
    onClearCache: async () => {
      if (!confirm("Clear the LaTeX packages ⚡ Instant keeps in this browser? They are fetched again when a document needs them.")) return;
      const r = await chrome.runtime.sendMessage({ type: "clear-cache" }).catch((e: unknown) => ({ error: String(e) }));
      panel.msg(r?.error ? `Couldn't clear the cache: ${r.error}` : `Cleared ${Math.round((r?.freed ?? 0) / 1048576)} MB of packages.`, !!r?.error, true);
    },
    // (the last build's log: the core's transcript)
    onLog: () => shown()?.log() ?? Promise.resolve(null),
    onBoxes: (file, start, end) => shown()?.boxesOf(file, start, end) ?? Promise.resolve([]),
  }, prefs, { host: "overleaf", fileUrl: (p) => chrome.runtime.getURL(p) });
  // (off in the popup: nothing at all, not even the project fetched; on again, live)
  let { enabled } = await chrome.storage.local.get("enabled");
  let started = false;
  const start = async () => {
    started = true;
    dock = dockInOverleaf(panel);
    await go();
  };

  /**
   * A compare (diffui.ts's runner, compare.ts): the version's files from
   * Overleaf's history, the marked-up document's session on a port of its
   * own, its binary files the project's as last read.
   */
  function compareWith(host: OverleafHost, core: ChromeTransport, opts: ConstructorParameters<typeof PreviewSession>[3]): Compare<Version> {
    return new Compare<Version>({
      session: () => session,
      core,
      onChanges: (cb) => host.onChanges(cb),
      async files(v, say) {
        say(`Fetching version ${v.v}…`);
        return (await filesAt(project(), v.v, pageFetch)).files;
      },
      async connect() {
        const t = new ChromeTransport();
        await t.connect();
        for (const [p, b] of Object.entries(lastBinaries)) await t.request({ op: "binary", file: p, b64: b64of(b) } as never);
        // (the diff's pages as strips too, composed here)
        return new StripPages(t, panel);
      },
      sink: (on) => gate(tee(panel, ch, () => mirrored), on, ["goto"]),
      goto: (file, from, to) => window.postMessage({ src: "phitex-content", type: "gotoRange", file, from, to, focus: false }, location.origin),
      save(bytes, type, name) {
        const url = URL.createObjectURL(new Blob([bytes], { type }));
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      },
      msg: (t) => panel.msg(t, true),
      options: opts ?? {},
      // (the look: chrome.storage, every project's)
      loadLook: async () => ((await chrome.storage.local.get("diffLook")) as { diffLook?: Partial<DiffLook> }).diffLook,
      saveLook: (l) => void chrome.storage.local.set({ diffLook: l }),
    });
  }
  chrome.storage.onChanged.addListener((c) => {
    if (c.enabled) {
      enabled = c.enabled.newValue;
      if (enabled === false) {
        dock?.stop();
        session?.pause(true);
      } else if (!started) void start();
      else {
        dock?.resume();
        session?.pause(false);
      }
    }
    if (c.panel) {
      if (!c.panel.newValue) panel.zoomTo("fit");
    }
  });
  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type === "phitex-tour") dock?.tour();
    if (m?.type === "phitex-news") dock?.news();
  });
  /** The session: the core connected, the project loaded, closed docs followed. */
  async function go(): Promise<void> {
  if (DETACHED) return follow(ch, panel);
  // (the detached tab's asks; what the session tells the panel goes there too)
  ch.addEventListener("message", (e: MessageEvent<Ask>) => {
    const a = e.data;
    if (a.t === "hello") {
      mirrored = true;
      void session?.resync();
    }
    if (a.t === "bye") mirrored = false;
    if (a.t === "need") void session?.fetch(a.k);
    if (a.t === "page") void session?.setPage(a.k);
    if (a.t === "sync") void session?.toSource(a.k, a.x, a.y);
    if (a.t === "goto") window.postMessage({ src: "phitex-content", type: "goto", file: a.file, line: a.line }, location.origin);
  });
  // (when the page highlights the editor's place: "cursor" as it moves,
  // "select" what is selected, "dblclick" only on a double-click; the popup's)
  let highlightMode = "select";
  // (the default: the highlight follows where you type)
  void chrome.storage.local.get("follow").then(({ follow: f }) => (highlightMode = (f as string | undefined) ?? "cursor"));
  // (collaborators' cursors on the pages, each in their colour, never moving
  // the view: on unless the popup's switch turned them off)
  let othersOn = true;
  let others: { file: string; others: { label: string; hue: number; pos: number }[] } | null = null;
  void chrome.storage.local.get("othersOff").then(({ othersOff }) => (othersOn = !othersOff));
  chrome.storage.onChanged.addListener((c) => {
    if (c.follow) highlightMode = (c.follow.newValue as string | undefined) ?? "cursor";
    if (c.othersOff) {
      othersOn = !c.othersOff.newValue;
      if (others) session?.others(others.file, othersOn ? others.others : []);
    }
  });
  // (a double-click in the editor or on the file outline: that place on the page)
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.src !== "phitex-hook") return;
    if (e.data.type === "sync") void session?.toPage(e.data.file, e.data.pos);
    // (Overleaf's ← beside the PDF: the place on the ⚡ pages in the editor)
    if (e.data.type === "toCode") {
      const p = panel.spot();
      if (p) void session?.toSource(p.k, p.x, p.y);
    }
    // (the editor's cursor as it moves: the word it is in, on the page)
    // (while a compare's diff is shown, on its pages, through the diff's map)
    if (e.data.type === "cursor" && highlightMode === "cursor") (compare ?? session)?.follow(e.data.file, e.data.pos);
    // (collaborators' cursors in the open file: their words marked in their colours)
    if (e.data.type === "others") {
      others = { file: e.data.file, others: e.data.others };
      if (othersOn) session?.others(e.data.file, e.data.others);
    }
    // (the editor's selection: its text highlighted on the pages)
    if (e.data.type === "select" && (highlightMode !== "dblclick" || e.data.from === e.data.to)) void session?.selectSource(e.data.file, e.data.from, e.data.to);
  });
  const transport = new ChromeTransport();
  // (the pages as strips: the core draws them, this tab composes them; MuPDF
  // can't run here, overleaf.com's policy forbids the tab WebAssembly)
  pages = new StripPages(transport, panel);
  // (Shelf's release, release.ts: an extension older than it needs asks for
  // an update, and its notice shows; both once per page, and it keeps working)
  let releaseShown = false;
  transport.onEvent((e) => {
    if (e.event !== "release" || !e.release || releaseShown) return;
    const min = e.release.min_extension;
    const lines: string[] = [];
    if (min && older(chrome.runtime.getManifest().version, min))
      lines.push(`A newer PhiTeX Instant is out (${min}): this one keeps working, but update it for the latest packages and fixes. In Chrome: chrome://extensions → <b>Update</b>.`);
    if (e.release.notice) lines.push(escapeHtml(e.release.notice));
    if (!lines.length) return;
    releaseShown = true;
    if (lines.length && min && older(chrome.runtime.getManifest().version, min)) void chrome.runtime.sendMessage({ type: "update-check" }).catch(() => undefined);
    const t = document.createElement("div");
    t.className = "popover bs-popover-top show phitex-toast";
    t.setAttribute("role", "status");
    t.innerHTML = `<div class="popover-body">⚡ ${lines.join("<br>")}</div>`;
    Object.assign(t.style, { position: "fixed", right: "16px", bottom: "16px", maxWidth: "340px", zIndex: "1060" });
    document.body.append(t);
    t.onclick = () => t.remove();
  });
  transport.onGone(() => {
    const t = document.createElement("div");
    t.className = "popover bs-popover-top show phitex-toast";
    t.setAttribute("role", "status");
    t.innerHTML = `<div class="popover-body">⚡ ${GONE}. <button type="button" class="btn btn-primary btn-sm">Reload</button></div>`;
    Object.assign(t.style, { position: "fixed", right: "16px", bottom: "16px", maxWidth: "340px", zIndex: "1060" });
    document.body.append(t);
    t.querySelector("button")!.onclick = () => location.reload();
  });
  try {
    devMark("connect");
    if (contextGone()) return;
    await transport.connect();
    devMark("connected");
    giveBinary = (path, bytes) => transport.request({ op: "binary", file: path, b64: b64of(bytes) } as never);
    let engineSetting: EngineChoice = "auto", projectEngine: Engine | undefined;
    const readEngine = async () => {
      const { engine, engines } = await chrome.storage.local.get(["engine", "engines"]);
      engineSetting = (engine as EngineChoice | undefined) ?? "auto";
      projectEngine = (engines as Record<string, Engine> | undefined)?.[project()];
    };
    await readEngine();
    // (the engine, set for every project or for this one: typeset again with it)
    chrome.storage.onChanged.addListener(async (c) => {
      if (!c.engine && !c.engines) return;
      await readEngine();
      session.clean(await fetchDocs(panel));
    });
    const host = new OverleafHost(panel);
    const opts: ConstructorParameters<typeof PreviewSession>[3] = {
      engine: (main) => resolve(engineSetting, projectEngine, main),
      // (a XeLaTeX project: approximated with pdfLaTeX, unless chosen for it)
      shims: async (main) => (projectEngine || !approximable(main) ? null : shimTexts((p) => platform().asset(p))),
    };
    const sink = gate(tee(panel, ch, () => mirrored), () => compare?.showing !== "diff");
    session = new PreviewSession(host, pages, sink, {
      ...opts,
      // (a double-click's source: bytes of the file as the session has it,
      // the editor put there)
      remote: {
        source: (file, start, end) => {
          const t = session.text(file);
          if (t !== undefined) window.postMessage({ src: "phitex-content", type: "gotoRange", file, from: charOffset(t, start), to: charOffset(t, end), focus: true }, location.origin);
        },
      },
    });
    (globalThis as any).__phitexSession = session; // (tests, devtools)
    // (a build in: its fetch round closed, as a build request's answer closes
    // it; the session's remote mode has none, so the last pack fetched
    // would stay "loading")
    transport.onEvent((e) => {
      if (e.event === "settled") void (session as unknown as { core: CoreTransport }).core.request({ op: "status" });
    });
    // (a compare's session: the marked-up document opened as a project of its own)
    diffImpl = compare = compareWith(host, transport, opts);
    devMark("start");
    // (the project read, its figures given to the core as they come; then
    // opened: the core builds it and says when its pages are in)
    const files = await host.loadProject();
    session.refresh(files);
    const main = guessMain(files);
    sink.mains?.(Object.keys(files).filter((f) => f.endsWith(".tex")), main);
    if (!main) throw new Error("no main .tex file found");
    await session.setMain(main);
    // (the editor's open file announced again: its text, unsaved edits and all, wins over the ZIP's)
    host.ready();
    devMark("started");
    ch.postMessage({ t: "up" });
    // (closed docs: fetched again and diffed in, so collaborators' edits to
    // them arrive as edits; the open one is live through the editor)
    setInterval(async () => {
      if (document.hidden || enabled === false) return;
      try {
        session.refresh(await fetchDocs(panel, (p) => p !== session.open));
      } catch {
        /* (offline: next time) */
      }
    }, FOLLOW_MS);
  } catch (e) {
    panel.error(String(e));
  }
  }

  if (enabled === false) return;
  await start();
})();

/** Bytes as base64 (the port to the offscreen document carries JSON). */
function b64of(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
