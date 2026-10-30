// The demo on phitex.org (/try): PhiTeX in the visitor's browser, nothing
// installed. An editor (the mock's CodeMirror 6, Overleaf's LaTeX grammar)
// beside the viewer every host shows (the panel on a PreviewSession, its
// pages strips), on the wasm core in a module worker: the Overleaf
// extension's own (overleaf/src/worker.ts, its threads thread.ts), so the
// demo runs what the extension runs. Its files are served from /try/ as the
// extension's are from its root (dist/core.wasm, formats/, texmf/, the
// Shelf index); Shelf's packs come from Shelf, kept in this browser's
// IndexedDB.
//
// Nothing is fetched until `mount`: the page imports this module when the
// visitor gets to the demo.

import "../../overleaf/src/platform.ts";
import { Panel } from "../../common/src/viewer/panel.ts";
import { PreviewSession, type CoreEvent, type CoreRes, type CoreTransport, type EditorHost } from "../../common/src/viewer/session.ts";
import type { Edit } from "../../common/src/viewer/edits.ts";
import { StripPages } from "../../common/src/strippages.ts";
import { EditorState, EditorView, extensions } from "../../mock/editor/editor.mjs";
import article from "../samples/article.tex";
import beamer from "../samples/beamer.tex";
import tikz from "../samples/tikz.tex";

export interface Doc {
  name: string;
  /** The project's files by path; the main one is main.tex (else the first .tex). */
  files: Record<string, string | Uint8Array>;
}

export interface MountOptions {
  /** The documents to offer (none: the demo's own three). */
  docs?: Doc[];
  /** A repaint reached the screen, `ms` after its keystroke. */
  onBuild?(ms: number): void;
}

export interface Demo {
  /** Shows document `i` of the docs. */
  setDoc(i: number): void;
  /** The demo gone: its worker ended, its elements removed. */
  destroy(): void;
}

export const SAMPLES: Doc[] = [
  { name: "Article", files: { "main.tex": article } },
  { name: "Beamer", files: { "main.tex": beamer } },
  { name: "TikZ", files: { "main.tex": tikz } },
];

/** Why the demo can't run here: `code` says which (the page shows its own words). */
export class Unsupported extends Error {
  code: "no-isolation" | "no-threads";
  constructor(code: "no-isolation" | "no-threads", message: string) {
    super(message);
    this.code = code;
  }
}

/** The core's threads share one memory: the page must be cross-origin isolated, and wasm must have threads. */
function check(): void {
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === "undefined")
    throw new Unsupported("no-isolation", "This page is not cross-origin isolated (COOP/COEP), so the engine's threads can't share memory.");
  try {
    new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  } catch {
    throw new Unsupported("no-threads", "This browser's WebAssembly has no threads.");
  }
}

/** The worker's core: requests answered by id, events pushed (overleaf/src/worker.ts's protocol). */
class WorkerCore implements CoreTransport {
  private next = 1;
  private waiting = new Map<number, (r: CoreRes) => void>();
  private events: ((e: CoreEvent) => void)[] = [];
  private w: Worker;

  constructor(w: Worker) {
    this.w = w;
    w.onmessage = (m: MessageEvent<{ id?: number; event?: string } & CoreRes>) => {
      const d = m.data;
      if (typeof d.id === "number") (this.waiting.get(d.id)?.(d), this.waiting.delete(d.id));
      else if (typeof d.event === "string") for (const f of this.events) f(d as unknown as CoreEvent);
    };
  }

  request(op: object, transfer: Transferable[] = []): Promise<CoreRes> {
    const id = this.next++;
    return new Promise((ok) => (this.waiting.set(id, ok), this.w.postMessage({ ...op, id }, transfer)));
  }

  onEvent(cb: (e: CoreEvent) => void): () => void {
    this.events.push(cb);
    return () => void this.events.splice(this.events.indexOf(cb) >>> 0, 1);
  }
}

const CSS = `
.phx-try { display: flex; width: 100%; height: 100%; min-height: 0; background: #fff; }
.phx-try-ed { flex: 1 1 45%; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid #e7e9ee; }
.phx-try-docs { flex: none; display: flex; align-items: center; gap: 4px; height: 34px; padding: 0 8px; border-bottom: 1px solid #e7e9ee;
  font: 13px/1 "Noto Sans", system-ui, sans-serif; color: #495365; }
.phx-try-docs button { font: inherit; padding: 4px 10px; border: 0; border-radius: 4px; background: none; color: inherit; cursor: pointer; }
.phx-try-docs button:hover { background: #f4f5f6; }
.phx-try-docs button[aria-pressed="true"] { background: #e7e9ee; color: #1b222c; font-weight: 600; }
.phx-try-docs button:focus-visible { outline: 2px solid #366cbf; }
.phx-try-ed .cm-editor { flex: 1; min-width: 0; min-height: 0; }
.phx-try-pages { flex: 1 1 55%; min-width: 0; position: relative; }
@media (max-width: 700px) {
  .phx-try { flex-direction: column; }
  .phx-try-ed { flex: 0 0 40%; border-right: 0; border-bottom: 1px solid #e7e9ee; }
  .phx-try-pages { flex: 1 1 60%; }
}`;

const mainOf = (files: Record<string, unknown>) => ("main.tex" in files ? "main.tex" : Object.keys(files).find((f) => f.endsWith(".tex")) ?? "main.tex");

/**
 * The demo in `el` (it fills it: give it a height): the editor and the
 * pages, the first document open. Throws Unsupported before fetching
 * anything when the page can't run the engine.
 */
export async function mount(el: HTMLElement, o: MountOptions = {}): Promise<Demo> {
  check();
  const docs = o.docs?.length ? o.docs : SAMPLES;
  const style = document.createElement("style");
  style.textContent = CSS;
  const root = document.createElement("div");
  root.className = "phx-try";
  root.innerHTML = `<div class="phx-try-ed"><div class="phx-try-docs" role="group" aria-label="Sample documents"></div></div><div class="phx-try-pages"></div>`;
  const picker = root.querySelector<HTMLElement>(".phx-try-docs")!;
  picker.hidden = docs.length < 2;
  for (const [i, d] of docs.entries()) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = d.name;
    b.onclick = () => setDoc(i);
    picker.append(b);
  }
  el.append(style, root);
  const pane = root.querySelector<HTMLElement>(".phx-try-pages")!;

  const worker = new Worker(new URL("worker.js", import.meta.url), { type: "module", name: "phitex-core" });
  const core = new WorkerCore(worker);

  // (the current document's session and pages: a new pair for each document)
  let session: PreviewSession;
  let pages: StripPages;
  const panel = new Panel(
    {
      onPage: () => {},
      onNeed: (k) => void session.fetch(k),
      onPdf: () => void download(),
      onMain: () => {},
      onReload: () => void session.resync(),
      onClean: () => setDoc(at, true),
      onGoto: () => {},
      onSyncSource: (k, x, y) => void session.toSource(k, x, y),
      onFind: (q) => pages.find(q),
    },
    undefined,
    {
      header: true,
      words: {
        badge: "in your browser",
        badgeTitle: "PhiTeX in WebAssembly, in this tab: nothing installed, nothing uploaded",
        byline: "⚡ PhiTeX",
        about: `<b>⚡ PhiTeX</b>: an incremental TeX engine, here compiled to WebAssembly and running in this tab.
          Your text never leaves your browser; TeX Live's packages are fetched from Shelf and kept in this browser.
          <div class="about-foot">Free software (AGPL-3.0-only), provided as is, without any warranty.</div>`,
        realPdf: "",
        stopped: "The build stopped: its problems are listed above.",
        notReady: "This engine does not run in the demo yet.",
        openFailed: "Reload the page to try again.",
        reading: "Your text stays in this browser.",
        keptIn: "this browser",
        preparing: "",
        steps: ["Starting", "Packages", "Typesetting"],
      },
    },
  );
  panel.dock(pane);
  panel.shown(true);

  // (the editor: its changes, as the session takes them, in the order applied)
  let changed: ((file: string, edits: Edit[], len?: number) => void) | undefined;
  let file = "main.tex";
  const view = new EditorView({ parent: root.querySelector<HTMLElement>(".phx-try-ed")! });
  const editing = extensions((u: any) => {
    if (!u.docChanged || !changed) return;
    for (const tr of u.transactions) {
      if (tr.changes.empty) continue;
      const edits: Edit[] = [];
      // (fromB: where the change is once those before it are applied, as overleaf/src/hook.ts)
      tr.changes.iterChanges((fromA: number, toA: number, fromB: number, _toB: number, ins: any) => edits.push({ from: fromB, to: fromB + (toA - fromA), text: ins.toString() }));
      changed(file, edits, tr.newDoc.length);
    }
  });

  async function download(): Promise<void> {
    const r = (await core.request({ op: "pdf" })) as CoreRes & { pdf?: Uint8Array };
    if (!r.ok || !r.pdf) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([r.pdf as BlobPart], { type: "application/pdf" }));
    a.download = "main.pdf";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  let at = 0;
  /** Document `i` opened anew (`keep`: with the editor's text, a clean rebuild). */
  function setDoc(i: number, keep = false): void {
    at = Math.max(0, Math.min(i, docs.length - 1));
    picker.querySelectorAll("button").forEach((b, k) => b.setAttribute("aria-pressed", String(k === at)));
    session?.stop();
    const doc = docs[at];
    const texts: Record<string, string> = {};
    for (const [f, v] of Object.entries(doc.files)) {
      if (typeof v === "string") texts[f] = v;
      else void core.request({ op: "binary", file: f, bytes: v });
    }
    file = mainOf(texts);
    changed = undefined;
    if (keep) texts[file] = view.state.doc.toString();
    view.setState(EditorState.create({ doc: texts[file] ?? "", extensions: editing }));
    void core.request({ op: "hello", project: `try/${doc.name}` });
    pages = new StripPages(core, {
      pixelsPerPoint: () => panel.pixelsPerPoint(),
      painted: (ms) => (panel.painted(ms), o.onBuild?.(ms)),
    });
    const host: EditorHost = {
      loadProject: async () => ({ ...texts, [file]: view.state.doc.toString() }),
      mainFile: () => file,
      onOpen() {},
      onChanges: (cb) => void (changed = cb),
    };
    session = new PreviewSession(host, pages, panel, { checkEveryMs: 0 });
    void session.start();
  }
  setDoc(0);

  return {
    setDoc: (i) => setDoc(i),
    destroy() {
      session?.stop();
      worker.terminate();
      view.destroy();
      root.remove();
      style.remove();
    },
  };
}
