// The web frontend: PhiTeX in a browser tab, nothing installed (the demo
// phitex.org serves at /try). A project's files (a tree; uploads; a ZIP in
// and out), the editor (CodeMirror 6, Overleaf's LaTeX grammar), and the
// viewer every host shows (the panel on a PreviewSession, its pages
// strips), on the wasm core in a module worker: the Overleaf extension's
// own (overleaf/src/worker.ts, core.ts here), so the page runs what the
// extension runs. Projects and their versions are kept in this browser
// (store.ts); Compare diffs the project against one of them (PhiTeX's
// latexdiff, compare.ts), as Overleaf's diff does against its history.
// Its files are served beside it as the extension's are from its root
// (dist/core.wasm, formats/, texmf/, Shelf's index); Shelf's packs come
// from Shelf, kept in IndexedDB; minted's Pyodide only when a document
// runs minted.
//
// Nothing is fetched until `mount`.

import "../../overleaf/src/platform.ts";
import { platform } from "../../../common/src/platform.ts";
import { Panel, type DiffLook, type PanelPrefs, type Prefs, type ViewPrefs } from "../../../common/src/viewer/panel.ts";
import { PreviewSession, guessMain, type EditorHost, type Options } from "../../../common/src/viewer/session.ts";
import { charOffset, type Edit } from "../../../common/src/viewer/edits.ts";
import { Compare, DiffControls, gate, type CompareHost } from "../../../common/src/viewer/compare.ts";
import { ENGINES, approximable, resolve, shimTexts, type Engine, type EngineChoice } from "../../../common/src/viewer/engines.ts";
import { ago } from "../../../common/src/viewer/commits.ts";
import { StripPages } from "../../../common/src/strippages.ts";
import { TEXT, readZip } from "../../../common/src/zip.ts";
import { cacheStats, clearCache } from "../../../common/src/wasm/host.ts";
import { WorkerCore } from "./core.ts";
import { Editor } from "./editor.ts";
import { Tree, validPath } from "./tree.ts";
import { writeZip } from "./zipwrite.ts";
import { autoVersion, deleteProject, newId, project as loadProjectById, projects, saveProject, saveVersion, versions, type Project, type Version } from "./store.ts";
import { CSS } from "./style.ts";
// (the examples, web/samples/<name>/: text files as text, figures as their bytes)
import article_main from "../samples/article/main.tex";
import article_phitex_logo from "../samples/article/phitex-logo.pdf";
import paper_main from "../samples/paper/main.tex";
import paper_refs from "../samples/paper/refs.bib";
import slides_main from "../samples/slides/main.tex";
import maths_main from "../samples/maths/main.tex";
import plots_main from "../samples/plots/main.tex";
import tikz_main from "../samples/tikz/main.tex";
import chemistry_main from "../samples/chemistry/main.tex";
import book_main from "../samples/book/main.tex";
import exam_main from "../samples/exam/main.tex";
import cv_main from "../samples/cv/main.tex";
import code_main from "../samples/code/main.tex";
import languages_main from "../samples/languages/main.tex";

export interface Doc {
  name: string;
  /** The project's files by path; the main one is main.tex (else the one with \documentclass). */
  files: Record<string, string | Uint8Array>;
}

export interface MountOptions {
  /** The sample documents offered (none: the three of the demo). */
  docs?: Doc[];
  /**
   * A repaint reached the screen, `ms` after its keystroke; `first`: the
   * project's first build since it was opened (downloads, the format, the
   * whole document: seconds), not a keystroke's.
   */
  onBuild?(ms: number, first: boolean): void;
  /** The app bar's "PhiTeX" (default true); false where the page around it already names PhiTeX. */
  brand?: boolean;
}

export interface Web {
  /** Opens sample `i` (the visitor's copy of it, kept). */
  setDoc(i: number): void;
  /** The panel's tour, every tip from the first (a page's own "Take the tour", a film's). */
  tour(): void;
  /** Everything gone: the engine's worker ended, the elements removed. */
  destroy(): void;
}

export const SAMPLES: Doc[] = [
  { name: "Article", files: { "main.tex": article_main, "phitex-logo.pdf": article_phitex_logo } },
  { name: "Paper", files: { "main.tex": paper_main, "refs.bib": paper_refs } },
  { name: "Slides", files: { "main.tex": slides_main } },
  { name: "Maths", files: { "main.tex": maths_main } },
  { name: "Plots", files: { "main.tex": plots_main } },
  { name: "TikZ", files: { "main.tex": tikz_main } },
  { name: "Chemistry", files: { "main.tex": chemistry_main } },
  { name: "Book", files: { "main.tex": book_main } },
  { name: "Exam", files: { "main.tex": exam_main } },
  { name: "CV", files: { "main.tex": cv_main } },
  { name: "Code", files: { "main.tex": code_main } },
  { name: "Languages", files: { "main.tex": languages_main } },
];

/** Why PhiTeX can't run here: `code` says which (the page shows its own words). */
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

/** Kept in this browser (localStorage: small things), never failing. */
const local = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(`phitex.web.${k}`);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(`phitex.web.${k}`, v);
    } catch {
      /* (not kept) */
    }
  },
};

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const mainOf = (files: Record<string, string>) => ("main.tex" in files ? "main.tex" : (guessMain(files) ?? Object.keys(files).find((f) => f.endsWith(".tex")) ?? "main.tex"));

function save(bytes: BlobPart, type: string, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A sample's project: its texts and binaries apart. */
function fromDoc(d: Doc, id: string): Project {
  const files: Record<string, string> = {};
  const binaries: Record<string, Uint8Array> = {};
  for (const [p, v] of Object.entries(d.files)) {
    if (typeof v === "string") files[p] = v;
    else binaries[p] = v;
  }
  return { id, name: d.name, files, binaries, main: mainOf(files), engine: "auto", updated: Date.now() };
}

/** An example's files in a word: its copies made from another example's text are told apart (djb2 over its paths, texts and binaries' sizes). */
function fingerprint(d: Doc): string {
  let h = 5381;
  for (const [p, v] of Object.entries(d.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const t = `${p}\0${typeof v === "string" ? v : `#${v.length}`}\0`;
    for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** A version's title in the menu and the diff bar. */
const titleOf = (v: Version) => v.label || "Autosaved";

const BAR = `
<div class="phx-bar">
  <span class="phx-logo">PhiTeX</span>
  <label class="phx-proj" title="Your projects, kept in this browser: pick one to open it"><span class="cap">Project</span><select id="phx-proj"></select></label>
  <div class="phx-menu"><button type="button" data-menu="new" aria-haspopup="menu" aria-expanded="false">New ▾</button><div class="phx-pop" data-pop="new" role="menu" hidden></div></div>
  <div class="phx-menu"><button type="button" data-menu="project" aria-haspopup="menu" aria-expanded="false" title="This project: its ZIP, name, versions, cache; delete">Manage ▾</button><div class="phx-pop" data-pop="project" role="menu" hidden></div></div>
  <span class="grow"></span>
  <label class="phx-engine" title="This project's TeX engine">Engine <select id="phx-engine"></select></label>
  <button type="button" id="phx-files" class="phx-narrow" aria-pressed="false">Files</button>
</div>
<div class="phx-body">
  <nav class="phx-tree" aria-label="Files"></nav>
  <div class="phx-ed"></div>
  <div class="phx-pages"></div>
</div>
<div class="phx-modal" hidden role="dialog" aria-modal="true"><div class="phx-card"><header><b></b><span class="grow"></span><button type="button" data-close="1" aria-label="Close">✕</button></header><div class="phx-modal-body"></div></div></div>`;

/**
 * PhiTeX in `el` (it fills it: give it a height): the projects, the
 * editor and the pages, the last project open (or the first sample). Throws
 * Unsupported before fetching anything when the page can't run the engine.
 */
export async function mount(el: HTMLElement, o: MountOptions = {}): Promise<Web> {
  check();
  const samples = o.docs?.length ? o.docs : SAMPLES;
  const style = document.createElement("style");
  style.textContent = CSS;
  const root = document.createElement("div");
  root.className = "phx-web";
  root.innerHTML = BAR;
  if (o.brand === false) root.querySelector(".phx-logo")?.remove();
  el.append(style, root);
  const $ = <T extends HTMLElement = HTMLElement>(s: string): T => root.querySelector<T>(s)!;
  const pane = $(".phx-pages");

  const core = new WorkerCore("web");
  /** The project open, its session, its pages. */
  let proj: Project | undefined;
  let session: PreviewSession | undefined;
  let pages: StripPages | undefined;
  /** What the session listens to (its EditorHost's callbacks). */
  let changedCb: ((file: string, edits: Edit[], len?: number) => void) | undefined;
  let openCb: ((file: string, text: string) => void) | undefined;
  const editListeners: (() => void)[] = [];
  /** The project open (mount opens one before anything asks). */
  const P = (): Project => {
    if (!proj) throw new Error("no project open");
    return proj;
  };

  /** Repaints since the project was opened: the first is its first build's. */
  let paints = 0;
  const stripPanel = {
    pixelsPerPoint: () => panel.pixelsPerPoint(),
    pageView: (k: number) => panel.pageView(k),
    painted: (ms: number) => {
      panel.painted(ms);
      const first = paints++ === 0;
      o.onBuild?.(ms, first);
      // (a first visit, once the page is in: the projects' tip, then the panel's own)
      if (first) setTimeout(projectsTip, 900);
    },
  };
  const prefs: Prefs = {
    load: async () => JSON.parse(local.get("panel") ?? "{}") as Partial<PanelPrefs>,
    save: (p) => local.set("panel", JSON.stringify(p)),
  };
  /** The session the panel shows: the compare's while its diff is in view. */
  const shown = (): PreviewSession | undefined => (session ? compare.shown() : undefined);

  /** The panel's own choices as this page keeps them. */
  const viewPrefs = (): Partial<ViewPrefs> => {
    try {
      return JSON.parse(localStorage.getItem("phitex.view") ?? "{}") as Partial<ViewPrefs>;
    } catch {
      return {};
    }
  };
  const panel = new Panel(
    {
      onPage: (p) => void shown()?.setPage(p),
      onNeed: (k) => void shown()?.fetch(k),
      onPdf: () => void downloadPdf(),
      onMain: (m) => setMain(m),
      // (a file's text as the session has it, for Copy for an AI assistant)
      onSource: async (file) => shown()?.text(file) ?? null,
      // (the panel's own choices: this page's storage, its one place)
      onPref: (key, value) => {
        try {
          localStorage.setItem("phitex.view", JSON.stringify({ ...viewPrefs(), [key]: value }));
        } catch {
          return "This browser keeps nothing for this page";
        }
      },
      onReload: () => session?.refresh({ ...P().files }),
      // (builds run by themselves on each edit: Rebuild typesets the files as they are once more, Clean rebuild from a fresh session)
      onRebuild: () => void session?.reopen(),
      onClean: () => void session?.clean({ ...P().files }),
      onCompare: () => void versionsDialog(),
      onClearCache: () => void cacheDialog(),
      onLog: () => shown()?.log() ?? Promise.resolve(null),
      // (a problem's culprit, underlined on the pages)
      onBoxes: (file, start, end) => shown()?.boxesOf(file, start, end) ?? Promise.resolve([]),
      onGoto: (file, line) => {
        if (!openFile(file)) return;
        const at = editor.lineStart(line);
        editor.select(at, at);
      },
      onGotoRange: (file, from, to, focus) => void (openFile(file) && editor.select(from, to, focus !== false)),
      onSyncSource: (k, x, y) => void shown()?.toSource(k, x, y),
      onSelectPage: (sel) => void shown()?.selectPage(sel),
      onEngine: (e) => setEngine(e),
      onFind: (q) => pages?.find(q) ?? Promise.resolve([]),
      onContents: () => void shown()?.outline(),
    },
    prefs,
    {
      // (a page of its own: the panel's own bar, in the watch's palette)
      host: "watch",
      // (the panel's tips after this app's own: projectsTip, then panel.tour())
      tips: false,
      outline: true,
      keys: true,
      header: true,
      words: {
        badge: "in your browser",
        badgeTitle: "PhiTeX in WebAssembly, in this tab: nothing installed, nothing uploaded",
        byline: "⚡ PhiTeX",
        about: `<b>⚡ PhiTeX</b>: an incremental TeX engine, here compiled to WebAssembly and running in this tab.
          Your projects never leave your browser; TeX Live's packages are fetched from Shelf and kept in this browser.
          <div class="about-foot">Free software (AGPL-3.0-only), provided as is, without any warranty.</div>`,
        realPdf: "",
        stopped: "The build stopped: its problems are listed above.",
        notReady: "This engine does not run here yet.",
        openFailed: "Reload the page to try again.",
        reading: "Your files stay in this browser.",
        keptIn: "this browser",
        preparing: "",
        steps: ["Loading the PhiTeX compiler", "Fetching packages", "Typesetting"],
      },
    },
  );
  panel.viewPrefs(viewPrefs());
  panel.dock(pane);
  panel.shown(true);
  // (the contents closed until the visitor opens them: most samples have no outline, and narrow pages no room)
  let sideKept = false;
  try {
    sideKept = localStorage.getItem("phitex.side") !== null;
  } catch {
    /* (not kept) */
  }
  if (!sideKept) panel.side(false);

  const editor = new Editor($(".phx-ed"), {
    changed(file, edits, len) {
      P().files[file] = editor.text();
      changedCb?.(file, edits, len);
      for (const f of editListeners) f();
      dirty();
    },
    cursor: (file, pos) => compare.follow(file, pos),
    selected: (file, from, to) => void session?.selectSource(file, from, to),
    dblclick: (file, pos) => void session?.toPage(file, pos),
  });

  /** The answer to something the user did: a note in the panel's corner (and its status popover). */
  const say = (t: string, err = false) => panel.msg(t, err, true);

  // (light or dark as the page is: its own toggle, data-theme on the root, else the system's; followed live)
  const system = matchMedia("(prefers-color-scheme: dark)");
  const pageTheme = (): "dark" | "light" | null => {
    const t = document.documentElement.dataset.theme;
    return t === "dark" || t === "light" ? t : null;
  };
  const followTheme = () => {
    const t = pageTheme();
    editor.dark(t ? t === "dark" : system.matches);
    panel.theme(t);
  };
  const themeWatch = new MutationObserver(followTheme);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  system.addEventListener("change", followTheme);
  followTheme();

  /**
   * A first visit's first tip, the project picker's (the user: picking
   * projects taught by a popup): a small looping demo of its list, the
   * examples then the visitor's own; "Got it" (or Skip) hands over to the
   * panel's tips. Shown once (local "tip.projects").
   */
  let tipShown = false;
  function projectsTip(): void {
    if (tipShown) return;
    tipShown = true;
    // (skipped: the tour skipped with it, now and on later visits; "Got it": the panel's tips next)
    const was = local.get("tip.projects");
    if (was === "skip") return;
    if (was) return panel.tour();
    const at = $("#phx-proj").getBoundingClientRect();
    const tip = document.createElement("div");
    tip.className = "phx-tip";
    tip.setAttribute("role", "dialog");
    tip.setAttribute("aria-label", "Examples and your projects");
    const ex = samples.slice(0, 4).map((d) => `<span>${esc(d.name)}</span>`).join("");
    tip.innerHTML =
      `<h4>Examples and your projects</h4>` +
      `<div class="demo" aria-hidden="true"><div class="pick"><b>${esc(samples[0]?.name ?? "Article")}</b><span class="chev">▾</span></div>` +
      `<div class="list"><small>Examples</small>${ex}<small>Your projects</small><span class="own">My thesis</span><i class="hi"></i></div></div>` +
      `<p>Open an example here: ${samples.length} of them, from slides to plots. Edit any; your copy is kept in this browser. Projects you start with New or a ZIP are listed under them.</p>` +
      `<div class="acts"><button type="button" data-t="skip">Skip</button><button type="button" class="primary" data-t="ok">Got it</button></div>`;
    root.append(tip);
    const box = root.getBoundingClientRect();
    Object.assign(tip.style, { left: `${Math.max(8, at.left - box.left)}px`, top: `${at.bottom - box.top + 10}px` });
    tip.style.setProperty("--ax", `${Math.min(at.width / 2, 60)}px`);
    $("#phx-proj").classList.add("ringed");
    tip.onclick = (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-t]")?.dataset.t;
      if (!a) return;
      local.set("tip.projects", a === "skip" ? "skip" : "1");
      tip.remove();
      $("#phx-proj").classList.remove("ringed");
      if (a !== "skip") panel.tour();
    };
  }

  const tree = new Tree($(".phx-tree"), {
    open: (p) => void openFile(p),
    add(p) {
      const pr = P();
      if (p in pr.files || p in pr.binaries) return say(`${p} is already in the project.`);
      pr.files[p] = "";
      // (a new file: the core is given it with the others, in a fresh open; edits then go to it)
      void session?.clean({ ...pr.files });
      openFile(p);
      dirty();
    },
    rename(from, to) {
      const pr = P();
      if (to in pr.files || to in pr.binaries) return say(`${to} is already in the project.`);
      if (from in pr.binaries) {
        pr.binaries[to] = pr.binaries[from];
        delete pr.binaries[from];
        void core.binary(to, pr.binaries[to]);
      } else {
        pr.files[to] = pr.files[from];
        delete pr.files[from];
        if (pr.main === from) pr.main = to;
        if (editor.file === from) editor.show(to, pr.files[to]);
      }
      void session?.clean({ ...pr.files });
      showTree();
      dirty();
    },
    remove(p) {
      const pr = P();
      if (p in pr.binaries) delete pr.binaries[p];
      else {
        if (Object.keys(pr.files).length <= 1) return say("A project keeps at least one file.");
        delete pr.files[p];
        if (pr.main === p) pr.main = mainOf(pr.files);
        if (editor.file === p) openFile(pr.main);
      }
      void session?.clean({ ...pr.files });
      showTree();
      dirty();
    },
    main: (p) => setMain(p),
    upload: (fs) => void upload(fs),
  });

  // (the compare: the project against one of its versions, the diff typeset by a core of its own)
  let diffCore: WorkerCore | undefined;
  const compareHost: CompareHost<Version> = {
    session: () => {
      if (!session) throw new Error("no session");
      return session;
    },
    core,
    onChanges: (cb) => void editListeners.push(cb),
    files: async (v) => v.files,
    async connect() {
      diffCore?.close();
      const t = (diffCore = new WorkerCore(`web-diff/${P().id}`));
      for (const [p, b] of Object.entries(P().binaries)) await t.binary(p, b);
      // (its pages as strips too; closing them ends its core)
      return new StripPages(t, stripPanel, panel.stripsChip());
    },
    sink: (on) => gate(panel, on, ["goto"]),
    goto: (file, from, to) => void (openFile(file) && editor.select(from, to, false)),
    save,
    msg: (t) => say(t, true),
    options: sessionOptions(),
    loadLook: async () => JSON.parse(local.get("diffLook") ?? "{}") as Partial<DiffLook>,
    saveLook: (l) => local.set("diffLook", JSON.stringify(l)),
  };
  const compare = new Compare<Version>(compareHost);
  const controls = new DiffControls<Version>(panel, compare);
  const onKey = (e: KeyboardEvent) => void controls.key(e);
  addEventListener("keydown", onKey);

  function sessionOptions(): Partial<Options> {
    return {
      checkEveryMs: 0,
      engine: (main) => {
        const e = resolve(proj?.engine ?? "auto", undefined, main);
        // (Auto says what it chose: "Auto (XeLaTeX)", from this main file's preamble)
        const auto = root.querySelector<HTMLOptionElement>("#phx-engine option[value=auto]");
        if (auto) auto.textContent = `Auto (${ENGINES[e].label})`;
        return e;
      },
      // (a XeLaTeX project the core can't run: approximated with pdfLaTeX's stand-ins)
      shims: async (main) => (proj?.engine !== "auto" || !approximable(main) || ENGINES.xelatex.ready ? null : shimTexts((p) => platform().asset(p))),
    };
  }

  // ---- the project ----

  /** The open session's "settled" listener, ended with it. */
  let stopSettled: (() => void) | undefined;

  async function openProject(p: Project): Promise<void> {
    if (controls.active) controls.stop();
    // (another project in the panel: a cold build's opening over the last one's pages, not its "last complete render")
    if (session) panel.opening();
    // (the session before stopped; its pages' transport is the core, shared: not closed)
    session?.stop();
    proj = p;
    paints = 0;
    local.set("open", p.id);
    await core.request({ op: "hello", project: p.id });
    for (const [f, b] of Object.entries(p.binaries)) await core.binary(f, b);
    pages = new StripPages(core, stripPanel, panel.stripsChip());
    const host: EditorHost = {
      loadProject: async () => ({ ...P().files }),
      mainFile: () => P().main,
      onOpen: (cb) => void (openCb = cb),
      onChanges: (cb) => void (changedCb = cb),
    };
    // (only while it is the project's: a stopped session's late answers never reach the panel)
    const s: PreviewSession = new PreviewSession(host, pages, gate(panel, () => session === s && compare.showing !== "diff"), {
      ...sessionOptions(),
      // (the core runs a live document, as the extension's: the session in its
      // remote mode, the document's events its own, its problems among them;
      // a double-click's or a selection's source (bytes of the file as the
      // session has it) put in the editor)
      remote: {
        source: (file, start, end) => sourceAt(file, start, end, true),
        select: (file, start, end) => sourceAt(file, start, end, false),
      },
    });
    const sourceAt = (file: string, start: number, end: number, focus: boolean) => {
      const t = s.text(file);
      if (t !== undefined && openFile(file)) editor.select(charOffset(t, start), charOffset(t, end), focus);
    };
    session = s;
    // (a build in: its fetch round closed, as a build request's answer closes
    // it; the remote mode has none, so the last pack fetched would stay "loading")
    stopSettled?.();
    stopSettled = core.onEvent((e) => void (e.event === "settled" && session === s && pages?.request({ op: "status" })));
    // (the session shown, for tests to read its trace: web/test's, as the extension's content script keeps it)
    (globalThis as unknown as { __phitexSession?: PreviewSession }).__phitexSession = session;
    editor.file = "";
    openFile(p.main in p.files ? p.main : Object.keys(p.files)[0]);
    $<HTMLSelectElement>("#phx-engine").value = p.engine;
    // (opened as the extension opens it: the files given, then the main file opened;
    // the remote mode's start() only joins a document the core already has)
    const main = p.main in p.files ? p.main : guessMain(p.files);
    s.refresh({ ...p.files });
    panel.mains(Object.keys(p.files).filter((f) => f.endsWith(".tex")), main);
    if (main) void s.setMain(main);
    else panel.error("no main .tex file found");
    await listProjects();
  }

  /** `file` in the editor (a text file of the project); false if there is none. */
  function openFile(file: string): boolean {
    const pr = P();
    if (!(file in pr.files)) return false;
    if (editor.file !== file || editor.text() !== pr.files[file]) {
      editor.show(file, pr.files[file]);
      openCb?.(file, pr.files[file]);
    }
    showTree();
    return true;
  }

  function showTree(): void {
    const pr = P();
    tree.show(Object.keys(pr.files), Object.keys(pr.binaries), editor.file, pr.main);
  }

  function setMain(m: string): void {
    const pr = P();
    if (!(m in pr.files)) return;
    pr.main = m;
    void session?.setMain(m);
    showTree();
    dirty();
  }

  function setEngine(e: EngineChoice): void {
    const pr = P();
    pr.engine = e;
    $<HTMLSelectElement>("#phx-engine").value = e;
    void session?.clean({ ...pr.files });
    dirty();
  }

  // (kept: the project saved after a pause in typing, a version every few minutes of editing)
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let changedSinceVersion = false;
  function dirty(): void {
    changedSinceVersion = true;
    P().edited = true;
    clearTimeout(saveTimer);
    const p = P();
    saveTimer = setTimeout(() => void saveProject(p).catch((e: unknown) => say(`Not saved in this browser: ${e}`, true)), 800);
  }
  const versionTimer = setInterval(() => {
    if (!changedSinceVersion || !proj) return;
    changedSinceVersion = false;
    void autoVersion(proj).catch(() => undefined);
  }, 5 * 60_000);

  async function listProjects(): Promise<void> {
    const cur = P();
    const ps = await projects().catch((): Project[] => []);
    if (!ps.some((p) => p.id === cur.id)) ps.unshift(cur);
    // (the examples first, each the visitor's copy once opened; then the projects they made)
    const opt = (v: string, name: string, on: boolean) => `<option value="${esc(v)}"${on ? " selected" : ""}>${esc(name)}</option>`;
    const own = ps.filter((p) => !p.id.startsWith("sample-"));
    $<HTMLSelectElement>("#phx-proj").innerHTML =
      `<optgroup label="Examples">${samples.map((d, i) => opt(`sample:${i}`, d.name, cur.id === `sample-${d.name}`)).join("")}</optgroup>` +
      (own.length ? `<optgroup label="Your projects">${own.map((p) => opt(p.id, p.name, p.id === cur.id)).join("")}</optgroup>` : "");
  }

  /** Sample `i`: the visitor's copy, as they left it, else a new one. */
  async function openSample(i: number): Promise<void> {
    const d = samples[Math.max(0, Math.min(i, samples.length - 1))];
    const id = `sample-${d.name}`;
    let kept = await loadProjectById(id).catch(() => undefined);
    // (the example changed since this copy was made: an unedited copy is the new example;
    // an edited one, or one from before copies were marked, kept as the visitor's own project beside it)
    if (kept && kept.sample !== fingerprint(d)) {
      if (kept.edited !== false) await saveProject({ ...kept, id: newId(), name: `${kept.name} (your edits)`, sample: undefined }).catch(() => undefined);
      kept = undefined;
    }
    const p = kept ?? { ...fromDoc(d, id), sample: fingerprint(d), edited: false };
    // (a new copy saved with a version of it as it came, "As opened": an edit can be compared at once, no version to save first)
    if (!kept) await saveProject(p).then(() => saveVersion(p, "As opened")).catch(() => undefined);
    await openProject(p);
  }

  async function newProject(p: Project): Promise<void> {
    await saveProject(p).catch((e: unknown) => say(`Not saved in this browser: ${e}`, true));
    await openProject(p);
  }

  async function upload(fs: File[]): Promise<void> {
    const pr = P();
    let fresh = false;
    for (const f of fs) {
      const name = f.name;
      if (/\.zip$/i.test(name)) {
        await importZip(f);
        return;
      }
      if (!validPath(name)) continue;
      if (TEXT.test(name)) {
        fresh ||= !(name in pr.files);
        pr.files[name] = await f.text();
      } else {
        pr.binaries[name] = new Uint8Array(await f.arrayBuffer());
        await core.binary(name, pr.binaries[name]);
        fresh = true;
      }
    }
    // (a new file or figure: the document opened again with it, so it is found)
    if (fresh) void session?.clean({ ...pr.files });
    else session?.refresh({ ...pr.files });
    showTree();
    dirty();
  }

  async function importZip(f: File): Promise<void> {
    say(`Reading ${f.name}…`);
    try {
      const z = await readZip(await f.arrayBuffer());
      const files = z.files;
      if (!Object.keys(files).some((p) => p.endsWith(".tex"))) return say(`${f.name} has no .tex file.`, true);
      const name = f.name.replace(/\.zip$/i, "");
      await newProject({ id: newId(), name, files, binaries: z.binaries, main: mainOf(files), engine: "auto", updated: Date.now() });
      say(`${name}: ${Object.keys(files).length} text files, ${Object.keys(z.binaries).length} others`);
    } catch (e) {
      say(`Couldn't read ${f.name}: ${e}`, true);
    }
  }

  async function downloadZip(): Promise<void> {
    const pr = P();
    const enc = new TextEncoder();
    const all: Record<string, Uint8Array> = { ...pr.binaries };
    for (const [p, t] of Object.entries(pr.files)) all[p] = enc.encode(t);
    save((await writeZip(all)) as BlobPart, "application/zip", `${pr.name.replace(/[^\w.-]+/g, "-")}.zip`);
  }

  async function downloadPdf(): Promise<void> {
    const pdf = await shown()?.pdf();
    // (a job that stopped early left its file unfinished, which no viewer opens)
    const tail = pdf ? new TextDecoder("latin1").decode(pdf.subarray(Math.max(0, pdf.length - 64))) : "";
    if (!pdf?.length || !tail.includes("%%EOF")) return say("No complete PDF yet: the build stopped before the end of the document.", true);
    save(pdf as BlobPart, "application/pdf", `${P().main.replace(/\.tex$/, "").replace(/.*\//, "")}.pdf`);
  }

  // ---- the bar ----

  const modal = $(".phx-modal");
  function showModal(title: string, body: HTMLElement | string): HTMLElement {
    modal.querySelector("header b")!.textContent = title;
    const b = modal.querySelector<HTMLElement>(".phx-modal-body")!;
    if (typeof body === "string") b.innerHTML = body;
    else b.replaceChildren(body);
    modal.hidden = false;
    return b;
  }
  modal.onclick = (e) => {
    const t = e.target as HTMLElement;
    if (t === modal || t.closest("[data-close]")) modal.hidden = true;
  };

  const engineSel = $<HTMLSelectElement>("#phx-engine");
  engineSel.innerHTML =
    `<option value="auto">Auto</option>` +
    (Object.entries(ENGINES) as [Engine, { label: string; ready: boolean }][]).map(([k, e]) => `<option value="${k}"${e.ready ? "" : " disabled"}>${e.label}${e.ready ? "" : " (soon)"}</option>`).join("");
  engineSel.onchange = () => setEngine(engineSel.value as EngineChoice);

  $<HTMLSelectElement>("#phx-proj").onchange = async (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v.startsWith("sample:")) return openSample(Number(v.slice(7)));
    const p = await loadProjectById(v);
    if (p) await openProject(p);
  };

  const filesBtn = $("#phx-files");
  filesBtn.onclick = () => {
    const on = !root.classList.contains("files-on");
    root.classList.toggle("files-on", on);
    filesBtn.setAttribute("aria-pressed", String(on));
  };

  /** The menus: one open at a time, each built when opened. */
  const menus: Record<string, (pop: HTMLElement) => void | Promise<void>> = {
    new(pop) {
      pop.innerHTML =
        `<button type="button" role="menuitem" data-new="blank">Blank project</button>` +
        `<hr><label class="phx-item" role="menuitem">Upload a project ZIP…<input type="file" accept=".zip,application/zip" hidden></label>`;
      const zip = pop.querySelector<HTMLInputElement>("input[type=file]")!;
      zip.onchange = () => {
        close();
        if (zip.files?.[0]) void importZip(zip.files[0]);
      };
      pop.onclick = (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
        if (!b) return;
        close();
        if (b.dataset.new)
          void newProject({ id: newId(), name: "Untitled", files: { "main.tex": "\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n" }, binaries: {}, main: "main.tex", engine: "auto", updated: Date.now() });
      };
    },
    project(pop) {
      pop.innerHTML =
        `<button type="button" role="menuitem" data-act="zip">Download as ZIP</button>` +
        `<button type="button" role="menuitem" data-act="rename">Rename…</button>` +
        `<button type="button" role="menuitem" data-act="versions">Versions and Compare…</button>` +
        `<hr><button type="button" role="menuitem" data-act="cache">Clear cache…</button>` +
        `<hr><button type="button" role="menuitem" data-act="delete" class="danger">Delete this project…</button>`;
      pop.onclick = (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
        if (!act) return;
        close();
        if (act === "zip") void downloadZip();
        if (act === "rename") renameProject();
        if (act === "cache") void cacheDialog();
        if (act === "versions") void versionsDialog();
        if (act === "delete") deleteDialog();
      };
    },
  };
  let openMenu = "";
  const close = () => {
    root.querySelectorAll<HTMLElement>(".phx-pop").forEach((p) => (p.hidden = true));
    root.querySelectorAll("[data-menu]").forEach((b) => b.setAttribute("aria-expanded", "false"));
    openMenu = "";
  };
  root.querySelectorAll<HTMLButtonElement>("[data-menu]").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const k = b.dataset.menu ?? "";
      const was = openMenu === k;
      close();
      if (was) return;
      const pop = $(`[data-pop="${k}"]`);
      // (fixed under its button: the bar scrolls sideways on a narrow page, and clips what it holds)
      const r = b.getBoundingClientRect();
      Object.assign(pop.style, { top: `${r.bottom + 4}px`, left: `${Math.max(4, Math.min(r.left, innerWidth - 260))}px` });
      openMenu = k;
      b.setAttribute("aria-expanded", "true");
      pop.hidden = false;
      await menus[k](pop);
    };
  });
  root.addEventListener("click", (e) => void (!(e.target as HTMLElement).closest(".phx-pop") && close()));

  /** The project's versions: one saved by name, or one picked to compare with (the panel's Compare, and the Project menu). */
  async function versionsDialog(): Promise<void> {
    const vs = await versions(P().id).catch((): Version[] => []);
    const b = showModal(
      "Versions",
      (controls.active ? `<p><button type="button" data-stop="1">Stop comparing</button></p>` : "") +
        `<form class="phx-form phx-save"><input type="text" placeholder="Name this version" aria-label="Version name" spellcheck="false"><button type="submit">Save version</button></form>` +
        `<p class="phx-head">Compare the current version with…</p>` +
        (vs.length
          ? `<div class="phx-versions">${vs.map((v) => `<button type="button" data-v="${esc(v.id)}"><span>${v.label ? "🏷 " : ""}${esc(titleOf(v))}</span><small>${ago(v.at / 1000)}</small></button>`).join("")}</div>`
          : `<p class="phx-none">No versions yet: save one, change the document, then compare. Versions are also saved every five minutes of editing.</p>`),
    );
    const form = b.querySelector<HTMLFormElement>("form")!;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const label = form.querySelector("input")!.value.trim() || new Date().toLocaleString();
      await saveProject(P());
      await saveVersion(P(), label);
      modal.hidden = true;
      say(`Saved "${label}"`);
    };
    b.onclick = (e) => {
      const t = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-v], button[data-stop]");
      if (!t) return;
      modal.hidden = true;
      if (t.dataset.stop) return controls.stop();
      const v = vs.find((x) => x.id === t.dataset.v);
      if (v) void controls.start(v, titleOf(v), ago(v.at / 1000));
    };
    form.querySelector("input")!.focus();
  }

  function renameProject(): void {
    const f = document.createElement("form");
    f.className = "phx-form";
    f.innerHTML = `<input type="text" spellcheck="false" aria-label="Project name"><button type="submit">Rename</button>`;
    const input = f.querySelector("input")!;
    input.value = P().name;
    f.onsubmit = (e) => {
      e.preventDefault();
      const pr = P();
      pr.name = input.value.trim() || pr.name;
      modal.hidden = true;
      void saveProject(pr).then(listProjects);
    };
    showModal("Rename the project", f);
    input.select();
  }

  function deleteDialog(): void {
    const b = showModal(
      "Delete this project?",
      `<p><b>${esc(P().name)}</b> and its saved versions are deleted from this browser. Download it as a ZIP first to keep it.</p>` +
        `<div class="phx-acts"><button type="button" data-close="1">Cancel</button><button type="button" class="danger" data-yes="1">Delete</button></div>`,
    );
    b.querySelector<HTMLButtonElement>("[data-yes]")!.onclick = async () => {
      modal.hidden = true;
      await deleteProject(P().id);
      const rest = await projects().catch((): Project[] => []);
      if (rest[0]) await openProject(rest[0]);
      else await openSample(0);
    };
  }

  async function cacheDialog(): Promise<void> {
    const b = showModal("Clear cache", `<p>Reading the cache…</p>`);
    const { caches } = await cacheStats("this browser");
    const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
    const total = caches.reduce((n, c) => n + c.bytes, 0);
    b.innerHTML =
      `<p>PhiTeX keeps TeX Live's packages and the engine's formats in this browser, so later builds start fast. Your projects are not affected.</p>` +
      `<ul>${caches.map((c) => `<li>${c.scope === "packages" ? "Packages" : "Build state"}: ${mb(c.bytes)} (${c.entries} entries)</li>`).join("")}</ul>` +
      `<div class="phx-acts"><button type="button" data-close="1">Cancel</button><button type="button" class="danger" data-yes="1">Clear ${mb(total)}</button></div>`;
    b.querySelector<HTMLButtonElement>("[data-yes]")!.onclick = async () => {
      const r = await clearCache("all", "this browser");
      modal.hidden = true;
      say(`Cleared ${mb(r.freed_bytes)}: packages are fetched again when needed.`);
    };
  }

  // ---- start ----
  const lastId = local.get("open");
  const last = lastId ? await loadProjectById(lastId).catch(() => undefined) : undefined;
  if (last) await openProject(last);
  else await openSample(0);

  return {
    setDoc: (i) => void openSample(i),
    tour: () => panel.tour(true),
    destroy() {
      if (controls.active) controls.stop();
      session?.stop();
      core.close();
      diffCore?.close();
      clearInterval(versionTimer);
      themeWatch.disconnect();
      system.removeEventListener("change", followTheme);
      removeEventListener("keydown", onKey);
      editor.destroy();
      root.remove();
      style.remove();
    },
  };
}
