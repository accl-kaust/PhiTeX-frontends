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
import { Compare, DiffControls, gate } from "../../common/src/viewer/compare.ts";
import type { DiffLook } from "../../common/src/viewer/panel.ts";
import { PreviewSession, type CoreEvent, type CoreRes, type CoreTransport, type EditorHost } from "../../common/src/viewer/session.ts";
import { StripPages } from "../../common/src/strippages.ts";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
/** The extension's root, as this webview addresses it (".../"). */
declare const PHITEX_ROOT: string;

/** What the webview says to the extension host (`ch` 2: a compare's own document's core, compare.ts). */
export type Up =
  | { t: "hello" }
  | { t: "req"; id: number; op: { op: string; [k: string]: unknown }; ch?: 2 }
  | { t: "pdf" }
  | { t: "log"; s: string }
  /** Compare: the version picked there (cmp-start back); its core opened (cmp-ready back) and closed. */
  | { t: "compare" }
  | { t: "cmp-open" }
  | { t: "cmp-close" }
  /** The last build's log, in an editor tab. */
  | { t: "showlog"; text: string }
  /** One of the extension's commands (phitex.caches). */
  | { t: "cmd"; cmd: string }
  /** A compare's file saved (its .tex, or its PDF as base64). */
  | { t: "save"; name: string; text?: string; b64?: string };
/** What the extension host says to the webview. */
export type Down =
  | { t: "res"; id: number; r: CoreRes & { render?: { page: number; key: string } }; ch?: 2 }
  | { t: "event"; e: CoreEvent; ch?: 2 }
  /** A version to compare with: its text files (`old`), and the project's as they are now. */
  | { t: "cmp-start"; v: string; title: string; when: string; old: Record<string, string>; main: string; files: Record<string, string> }
  /** The project's text files as they are now (an edit while comparing). */
  | { t: "texts"; main: string; files: Record<string, string> }
  | { t: "cmp-ready"; error?: string }
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

  /** Its channel: the preview's document's core (none), or a compare's (2). */
  private ch: 2 | undefined;

  constructor(ch?: 2) {
    this.ch = ch;
    addEventListener("message", (m: MessageEvent<Down>) => {
      const d = m.data;
      if ((d.t === "event" || d.t === "res") && d.ch !== this.ch) return;
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
    const { r } = await new Promise<Down & { t: "res" }>((ok) => (this.waiting.set(id, ok), up({ t: "req", id, op: o, ch: this.ch })));
    return r;
  }

  onEvent(cb: (e: CoreEvent) => void): void {
    this.events.push(cb);
  }

  /** A compare's: its core closed (the extension host's second core). */
  close(): void {
    if (this.ch) up({ t: "cmp-close" });
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
    onNeed: (k) => void shown().fetch(k),
    onPdf: () => up({ t: "pdf" }),
    onMain: () => {},
    onReload: () => void session.resync(),
    onClean: () => void session.resync(),
    onGoto: (file, line) => void relay.request({ op: "source", file, line, col: 1 }),
    onSyncSource: (k, x, y) => void shown().toSource(k, x, y),
    onFind: (q) => pages.find(q),
    // (the contents opened: the outline asked for now)
    onContents: () => void shown().outline(),
    onBoxes: (file, start, end) => shown().boxesOf(file, start, end),
    // (the version from the folder's git history, picked in the extension host: compare.ts there)
    onCompare: watch ? undefined : () => up({ t: "compare" }),
    // (the caches: the extension's command, which lists them and clears one)
    onClearCache: () => up({ t: "cmd", cmd: "phitex.caches" }),
    // (the last build's log: in the panel, and in an editor tab beside)
    onLog: async () => {
      const text = await shown().log();
      if (text) up({ t: "showlog", text });
      return text;
    },
  },
  // (the panel's settings: kept in the webview's own state)
  {
    load: async () => ((vscode.getState() as { prefs?: Partial<PanelPrefs> } | undefined)?.prefs ?? {}),
    save: (prefs) => vscode.setState({ prefs }),
  },
  {
    host: "vscode",
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
const session = new PreviewSession(host, pages, watch ? panel : gate(panel, () => compare.editorShown()), {
  checkEveryMs: 0,
  remote: {
    source: (file, start, end) => void relay.request({ op: "source", file, start, end }),
    select: (file, start, end) => void relay.request({ op: "select", file, start, end }),
  },
});

/**
 * Compare (viewer/src/compare.ts), with the builtin engine: the version's
 * files and the project's as they are now from the extension host (its
 * session holds no texts: the editor's buffers go to the core through the
 * language server), the marked-up document on a second core of its own
 * (channel 2), latexdiff in the extension host.
 */
let now: { main: string; files: Record<string, string> } = { main: "main.tex", files: {} };
const changed: (() => void)[] = [];
const old = new Map<string, Record<string, string>>();
let ready: ((error?: string) => void) | undefined;
// (the editor's session, as a compare reads it: its texts the extension host's)
const editorSession = new Proxy(session, {
  get(t, k, r) {
    if (k === "texts") return () => now.files;
    if (k === "text") return (f: string) => now.files[f];
    if (k === "main") return now.main;
    const v = Reflect.get(t, k, r);
    return typeof v === "function" ? v.bind(t) : v;
  },
});
const compare = new Compare<string>({
  session: () => editorSession,
  core: relay,
  onChanges: (cb) => void changed.push(cb),
  files: async (v) => old.get(v) ?? {},
  async connect() {
    const opened = new Promise<string | undefined>((ok) => (ready = ok));
    up({ t: "cmp-open" });
    const error = await opened;
    if (error) throw new Error(error);
    return new StripPages(new Relay(2), { pixelsPerPoint: () => panel.pixelsPerPoint(), painted: (ms) => panel.painted(ms) });
  },
  sink: (on) => gate(panel, on, ["goto"]),
  goto: (file, start, end) => void relay.request({ op: "select", file, start, end }),
  save(bytes, _type, name) {
    if (typeof bytes === "string") return up({ t: "save", name, text: bytes });
    const b = new Uint8Array(bytes as ArrayBuffer);
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    up({ t: "save", name, b64: btoa(s) });
  },
  msg: (t) => panel.msg(t, true),
  options: { checkEveryMs: 0 },
  // (the look: the webview's state, beside the panel's settings)
  loadLook: async () => (vscode.getState() as { look?: Partial<DiffLook> } | undefined)?.look,
  saveLook: (look) => vscode.setState({ ...(vscode.getState() as object | undefined), look }),
});
const controls = new DiffControls(panel, compare);
/** The session the panel shows: the compare's while its diff is in view. */
const shown = () => compare.shown();
addEventListener("message", (m: MessageEvent<Down>) => {
  const d = m.data;
  if (d.t === "cmp-start") {
    now = { main: d.main, files: d.files };
    old.set(d.v, d.old);
    void controls.start(d.v, d.title, d.when);
  }
  if (d.t === "texts") (now = { main: d.main, files: d.files }), changed.forEach((f) => f());
  if (d.t === "cmp-ready") (ready?.(d.error), (ready = undefined));
});
addEventListener("keydown", (e) => controls.key(e));

up({ t: "hello" });
void session.start();
