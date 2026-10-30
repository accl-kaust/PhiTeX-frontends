// The preview in VS Code's webview: the viewer every host shows (the panel,
// common/src/viewer/panel.ts, on the session, session.ts), its pages strips
// (common/src/strippages.ts: the core draws them, this page composes them),
// as in Overleaf's tab. Its core is the extension host's (extension.ts's
// `relay`: the builtin engine's CoreSession, or `phitex watch`'s), each
// request and event relayed by postMessage, a strip's pixels as bytes.
//
// (Not the watch's own page in an iframe: VS Code shows a frame nested in
// its webview's only once, its later frames never on the screen.)

import { Panel, type PanelPrefs } from "../../common/src/viewer/panel.ts";
import { PreviewSession, type CoreEvent, type CoreRes, type CoreTransport, type EditorHost } from "../../common/src/viewer/session.ts";
import { StripPages } from "../../common/src/strippages.ts";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
/** The extension's root, as this webview addresses it (".../"). */
declare const PHITEX_ROOT: string;

/** What the webview says to the extension host. */
export type Up = { t: "hello" } | { t: "req"; id: number; op: { op: string; [k: string]: unknown } } | { t: "pdf" } | { t: "log"; s: string };
/** What the extension host says to the webview. */
export type Down =
  | { t: "res"; id: number; r: CoreRes & { render?: { page: number; key: string } } }
  | { t: "event"; e: CoreEvent }
  /** The engine lost (the watch exited, the core trapped): the pages dimmed under a banner saying why. */
  | { t: "connection"; up: boolean; why?: string };

const vscode = acquireVsCodeApi();
const up = (m: Up) => vscode.postMessage(m);

// (what the webview does, told to the extension host's PhiTeX output: with
// phitex.trace, every request, draw and event with its time; always, an
// error, and the thread blocked (a beat every 250 ms late by 500 ms or more))
const t0 = performance.now();
const trace = (s: string) => up({ t: "log", s: `${(performance.now() - t0).toFixed(0).padStart(7)} ms  ${s}` });
addEventListener("error", (e) => trace(`error: ${e.message} at ${e.filename}:${e.lineno}`));
addEventListener("unhandledrejection", (e) => trace(`rejected: ${String((e as PromiseRejectionEvent).reason?.stack ?? (e as PromiseRejectionEvent).reason).slice(0, 400)}`));
let beat = performance.now();
setInterval(() => {
  const late = performance.now() - beat - 250;
  if (late >= 500) trace(`blocked ${late.toFixed(0)} ms`);
  beat = performance.now();
}, 250);

/** The extension host's core: requests answered by id, events pushed. */
class Relay implements CoreTransport {
  private next = 1;
  private waiting = new Map<number, (r: Down & { t: "res" }) => void>();
  private events: ((e: CoreEvent) => void)[] = [];

  constructor() {
    addEventListener("message", (m: MessageEvent<Down>) => {
      const d = m.data;
      if (d.t === "event") return (trace(`event ${d.e.event}`), this.events.forEach((f) => f(d.e)));
      if (d.t === "res") (this.waiting.get(d.id)?.(d), this.waiting.delete(d.id));
    });
  }

  async request(op: object): Promise<CoreRes> {
    const o = op as { op: string; page?: number };
    const t = performance.now();
    const r = await this.ask(o);
    trace(`${o.op}${o.page !== undefined ? " " + o.page : ""}: ${r.ok ? "ok" : "failed " + r.error} ${(performance.now() - t).toFixed(0)} ms`);
    return r;
  }

  private async ask(o: { op: string; page?: number }): Promise<CoreRes> {
    const id = this.next++;
    const { r } = await new Promise<Down & { t: "res" }>((ok) => (this.waiting.set(id, ok), up({ t: "req", id, op: o })));
    return r;
  }

  onEvent(cb: (e: CoreEvent) => void): void {
    this.events.push(cb);
  }
}

/** Which engine builds (relay.ts's viewHtml says): the panel's words. */
const watch = (window as unknown as { PHITEX_ENGINE?: string }).PHITEX_ENGINE === "watch";
const relay = new Relay();
// (the last frame's numbers, in the corner, with phitex.trace's trace too)
const chip = document.createElement("div");
chip.style.cssText = "position:fixed;right:8px;bottom:28px;z-index:30;font:11px monospace;opacity:.6;pointer-events:none";
const pages = new StripPages(relay, { pixelsPerPoint: () => panel.pixelsPerPoint(), painted: (ms) => panel.painted(ms) }, chip);

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
    onFind: (q) => pages.find(q),
    // (the contents opened: the outline asked for now)
    onContents: () => void session.outline(),
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
      badge: watch ? "watch" : "builtin",
      badgeTitle: watch ? "phitex watch: the native engine, the document built as you type" : "The builtin engine: PhiTeX in WebAssembly inside VS Code, the document built as you type",
      byline: "⚡ PhiTeX",
      about: `<b>⚡ PhiTeX</b>: the document built ${watch ? "by <code>phitex watch</code>" : "inside VS Code"} as you type, its pages here. Nothing leaves this machine.
        <div class="about-foot">Free software (AGPL-3.0-only, <a id="license" target="_blank" rel="noopener">full license</a>),
        provided as is, without any warranty.</div>`,
      realPdf: "",
      stopped: "The build stopped: its problems are listed above.",
      notReady: "This engine does not run here yet.",
      openFailed: "Close the preview and open it again to retry.",
      reading: watch ? "Reading the document from phitex watch." : "Reading the project.",
      keptIn: "this machine",
      preparing: "",
      steps: ["Starting", "Packages", "Typesetting"],
    },
  },
);
// (the engine lost, as the extension host says: the last pages dimmed, a banner saying why)
addEventListener("message", (m: MessageEvent<Down>) => m.data.t === "connection" && panel.connection(m.data.up, m.data.why));
// (docked in a pane that fills the webview)
const pane = document.createElement("div");
pane.style.cssText = "position:fixed;inset:0";
document.body.append(pane);
panel.dock(pane);
panel.shown(true);
document.body.append(chip);

const host: EditorHost = { loadProject: async () => ({}), onOpen() {}, onChanges() {} };
// (a double-click: the engine opens the source in the editor, window/showDocument;
// text selected on the pages: its source selected there, the focus left here)
const session = new PreviewSession(host, pages, panel, {
  checkEveryMs: 0,
  remote: {
    source: (file, start, end) => void relay.request({ op: "source", file, start, end }),
    select: (file, start, end) => void relay.request({ op: "select", file, start, end }),
  },
});

up({ t: "hello" });
void session.start();
