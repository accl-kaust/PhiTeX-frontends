// The preview in VS Code's webview: the viewer every host shows (the panel,
// common/src/viewer/panel.ts, on the session, session.ts), its pages drawn
// here by MuPDF (common/src/tabrender.ts), as in Overleaf's tab. Its core is
// the extension host's (extension.ts's `relay`: `phitex watch`'s, over its
// WebSocket), each request and event relayed by postMessage; a `png` is
// answered with the PDF's key (and the PDF, when new), drawn here.
//
// (Not the watch's own page in an iframe: VS Code shows a frame nested in
// its webview's only once, its later frames never on the screen.)

import { Panel, type PanelPrefs } from "../../common/src/viewer/panel.ts";
import { PreviewSession, type CoreEvent, type CoreRes, type CoreTransport, type EditorHost } from "../../common/src/viewer/session.ts";
import type { Hit } from "../../common/src/viewer/mupdf.ts";
import { drawPage, findIn, outlineOf } from "../../common/src/tabrender.ts";
import { setPlatform } from "../../common/src/platform.ts";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
/** The extension's root, as this webview addresses it (".../"). */
declare const PHITEX_ROOT: string;

/** What the webview says to the extension host. */
export type Up = { t: "hello" } | { t: "req"; id: number; op: { op: string; [k: string]: unknown } } | { t: "pdf" };
/** What the extension host says to the webview. */
export type Down = { t: "res"; id: number; r: CoreRes & { render?: { page: number; key: string } } } | { t: "event"; e: CoreEvent };

const vscode = acquireVsCodeApi();
const up = (m: Up) => vscode.postMessage(m);

// (tabrender's MuPDF, from the extension's dist/mupdf/; nothing else of the platform is asked here)
setPlatform({
  asset: (p) => fetch(PHITEX_ROOT + p),
  assetUrl: (p) => PHITEX_ROOT + p,
  fetch: (u) => fetch(u),
  kv: {
    get: async () => undefined,
    all: async () => new Map(),
    write: async () => {},
    clear: async () => {},
  },
});

/** The extension host's core: requests answered by id, events pushed; a page drawn here from the PDF. */
class Relay implements CoreTransport {
  private next = 1;
  private waiting = new Map<number, (r: Down & { t: "res" }) => void>();
  private events: ((e: CoreEvent) => void)[] = [];
  /** The PDF the last page was drawn from. */
  key: string | null = null;

  constructor() {
    addEventListener("message", (m: MessageEvent<Down>) => {
      const d = m.data;
      if (d.t === "event") return this.events.forEach((f) => f(d.e));
      if (d.t === "res") (this.waiting.get(d.id)?.(d), this.waiting.delete(d.id));
    });
  }

  async request(op: object): Promise<CoreRes> {
    const o = op as { op: string; page?: number };
    // (the outline: MuPDF's, from the PDF last drawn)
    if (o.op === "outline") return { ok: true, json: { items: this.key ? outlineOf(this.key) : [] } };
    const id = this.next++;
    const { r } = await new Promise<Down & { t: "res" }>((ok) => (this.waiting.set(id, ok), up({ t: "req", id, op: o })));
    if (!r.render) return r;
    const img = await drawPage(r.render.key, r.render.page, panel.pixelsPerPoint(), r.pdf).catch((e) => (console.warn("[phitex] draw", e), null));
    if (!img) return { ok: false, error: "no such page" };
    this.key = r.render.key;
    return { ok: true, canvas: img.canvas, size: [img.w, img.h], links: img.links };
  }

  onEvent(cb: (e: CoreEvent) => void): void {
    this.events.push(cb);
  }
}

const relay = new Relay();

const panel = new Panel(
  {
    onPage: () => {},
    onNeed: (k) => void session.fetch(k),
    onPdf: () => up({ t: "pdf" }),
    onMain: () => {},
    onReload: () => void session.resync(),
    onClean: () => void session.resync(),
    onGoto: (file, line) => void relay.request({ op: "source", file, line, col: 1 }),
    onSyncSource: (k, x, y) => void session.toSource(k, x, y),
    onFind: async (q) => (relay.key ? findIn(relay.key, q) : []),
  },
  // (the panel's settings: kept in the webview's own state)
  {
    load: async () => ((vscode.getState() as { prefs?: Partial<PanelPrefs> } | undefined)?.prefs ?? {}),
    save: (prefs) => vscode.setState({ prefs }),
  },
  {
    outline: true,
    header: true,
    words: {
      badge: "watch",
      badgeTitle: "phitex watch: the document built as you type",
      byline: "⚡ PhiTeX",
      about: `<b>⚡ PhiTeX</b>: the document built by <code>phitex watch</code> as you type, its pages here. Nothing leaves this machine.
        <div class="about-foot">Free software (AGPL-3.0-only, <a id="license" target="_blank" rel="noopener">full license</a>),
        provided as is, without any warranty.</div>`,
      realPdf: "",
      stopped: "The build stopped: its problems are listed above.",
      notReady: "This engine does not run here yet.",
      openFailed: "Close the preview and open it again to retry.",
      reading: "Reading the document from phitex watch.",
      keptIn: "this machine",
      preparing: "",
      steps: ["Connected", "Format", "Building"],
    },
  },
);
// (docked in a pane that fills the webview)
const pane = document.createElement("div");
pane.style.cssText = "position:fixed;inset:0";
document.body.append(pane);
panel.dock(pane);
panel.shown(true);

const host: EditorHost = { loadProject: async () => ({}), onOpen() {}, onChanges() {} };
// (a double-click: the watch opens the source in the editor, window/showDocument)
const session = new PreviewSession(host, relay, panel, {
  checkEveryMs: 0,
  remote: { source: (file, start, end) => void relay.request({ op: "source", file, start, end }) },
});

// (the editor's cursor as the watch placed it (phitex/cursor): the words
// around it (`texts`, longest first) found on its page (from 1) and marked;
// with no page, the first found nearest the place last revealed; else the
// page brought into view; as the watch's own page does)
let revealed = 0;
relay.onEvent((e: any) => {
  if (e.event !== "reveal" || !relay.key) return;
  const k = typeof e.page === "number" ? e.page - 1 : -1;
  for (const q of (e.texts ?? [e.text]) as string[]) {
    const hits = q ? findIn(relay.key, q) : [];
    const near = (a: Hit, h: Hit) => (Math.abs(h.k - revealed) < Math.abs(a.k - revealed) ? h : a);
    const hit = k >= 0 ? hits.find((h) => h.k === k) : hits.length ? hits.reduce(near) : undefined;
    if (!hit) continue;
    revealed = hit.k;
    return panel.reveal([hit]);
  }
  if (k < 0) return;
  revealed = k;
  panel.reveal([{ k, boxes: [[0, 0, 0, 0]] }]);
});

up({ t: "hello" });
void session.start();
