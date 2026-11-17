// The single-threaded core (core1.wasm, Firefox's: wasm32-wasip1, no
// JSPI there) saving a document's persisted graph in slices (PhiTeX's
// crates/wasm/live/src/session.rs save_slice, docs/spec-persisted-graph.md
// §16): each slice a step of its own, a few ms long, the host's tasks run
// between two, so an edit typed while the graph is being saved is taken
// within one slice, not after the whole save (Grail: 1.2 s). Run on Node,
// thread 0 the host's as in the extension's worker1.ts, every ask answered
// inside its call; the formats the build made (build.sh: build/overleaf/).
//
//   node test/harness/core1-save.ts [--wasm CORE1] [--formats DIR] [--doc DIR MAIN [ENGINE]] [--minted]
//
// The document (by default one made here: an article of sections, lists and
// equations, a few pages) is opened with graphs kept; its first build's
// graph is saved at once. Each of the first three saves is interrupted by
// an edit, typed 0, 25 and 80 ms after the save began (the core's
// `graph` event `saving`); the fourth is let run. Checks:
//   - each edit's task ran within one slice of the save: its delay past
//     its time at most the longest slice the core says it ran (`slice_ms`),
//     and a few ms for the timer;
//   - each interrupted save was given up (`given_up`, nothing kept) before
//     the edit's build, and no graph was kept until the last;
//   - the last save is whole: a fresh core given it loads it, runs no node,
//     and makes the PDF of the last build, byte for byte, which is a clean
//     build's of the last text (a fresh core, no graph).
// --doc: that folder's document instead (its files given as the
// extension gives a project's), for timings (amsldoc, Grail).

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { Core, CoreSession } from "../../common/src/wasm/core.ts";
import type { GraphStore } from "../../common/src/wasm/graphs.ts";
import { HOSTS } from "../../common/src/shelf.ts";
import { runOn, type Runner } from "../../common/src/wasm/minted.ts";

const args = process.argv.slice(2);
const value = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const wasm = value("--wasm") ?? "build/overleaf/dist/core1.wasm";
const formatsDir = value("--formats") ?? "build/overleaf/formats";
const docAt = args.indexOf("--doc");
const docDir = docAt >= 0 ? args[docAt + 1] : undefined;
const docMain = docAt >= 0 ? args[docAt + 2] : "main.tex";
const engine = docAt >= 0 && args[docAt + 3] && !args[docAt + 3].startsWith("--") ? args[docAt + 3] : "pdflatex";
const module = await WebAssembly.compile(readFileSync(wasm));
const T0 = performance.now();
const ms = () => Math.round(performance.now() - T0);

// (the formats shipped, as the extension's worker gives them: `format/NAME`)
const formats = new Map<string, Uint8Array>();
for (const f of readdirSync(formatsDir).filter((n) => n.endsWith(".gzdata"))) formats.set(`format/${f.replace(/\.gzdata$/, "")}`, new Uint8Array(gunzipSync(readFileSync(join(formatsDir, f)))));
if (!formats.size) throw new Error(`no format in ${formatsDir} (tools/build/build.sh makes them)`);

/** Shelf's pack `id` at once: kept in target/shelf-cache/, else Shelf's by curl, kept. */
function packNow(id: string): Uint8Array | null {
  const kept = `target/shelf-cache/${id}.pack`;
  if (existsSync(kept)) return new Uint8Array(readFileSync(kept));
  for (const h of process.env.SHELF_URL ? [process.env.SHELF_URL] : HOSTS) {
    try {
      const b = new Uint8Array(execFileSync("curl", ["-fsS", "--max-time", "60", h + "h/" + encodeURIComponent(id) + ".pack"], { maxBuffer: 1 << 30 }));
      if (b[0] !== 0x1f) continue;
      mkdirSync("target/shelf-cache", { recursive: true });
      writeFileSync(kept, b);
      return b;
    } catch {
      /* (the next host) */
    }
  }
  return null;
}

// (--minted: latexminted in Pyodide, loaded before the open, run inside its call as worker1.ts runs it)
let runner: Runner | undefined;
if (args.includes("--minted")) {
  const { loadPyodide } = await import("pyodide");
  const { createMintedRunner } = await import("../../phitex/tools/minted-pyodide/runner.mjs" as string);
  const dir = process.env.MINTED_WHEELS ?? "/usr/share/texmf-dist/scripts/minted/";
  const wheels = readdirSync(dir).filter((f) => f.endsWith(".whl")).map((f) => [f, new Uint8Array(readFileSync(join(dir, f)))]);
  runner = await createMintedRunner({ loadPyodide, wheels });
}

const index = { tsv: gunzipSync(readFileSync("shelf/shelf-index.tsv.gz")), release: readFileSync("shelf/shelf-release.json"), table: gunzipSync(readFileSync("shelf/shelf-packs.tsv.gz")) };
const bundled = readdirSync("shelf/texmf").filter((n) => n !== "names.txt");

/** The graphs kept, in memory: one a document. */
const kept = new Map<string, Uint8Array>();
let puts = 0;
const graphs: GraphStore = {
  get: async (d) => kept.get(d) ?? null,
  put: async (d, b) => void (kept.set(d, b), puts++),
  drop: async (d) => void kept.delete(d),
  on: async () => true,
};

/** A fresh single-threaded core, as worker1.ts starts one (`keep`: graphs kept). */
function start(keep: boolean, events: (e: any) => void): { core: Core; session: CoreSession } {
  const store = new Map<string, Uint8Array>();
  const core = Core.startSingle(module, {
    sync: {
      resolve: (name) => {
        try {
          return { path: name, bytes: new Uint8Array(readFileSync(join("shelf/texmf", name))) };
        } catch {
          return null;
        }
      },
      fetch: (id) => packNow(id),
      stored: (key) => store.get(key) ?? formats.get(key) ?? null,
      shell: runner ? (command, files) => runOn(runner!, command, files) : undefined,
    },
    store: {
      get: async (key) => store.get(key) ?? formats.get(key) ?? null,
      put: async (key, bytes) => void store.set(key, bytes),
    },
    graphs: keep ? graphs : undefined,
    event: events,
    log: (s) => process.stderr.write(s),
    trap: (_tid, error) => {
      console.log(`FAIL the core trapped: ${error.split("\n")[0]}`);
      process.exit(2);
    },
  });
  core.setIndex(index.tsv, index.release, index.table, bundled);
  return { core, session: new CoreSession(core, { shell: !!runner, threads: 1 }) };
}

/** The project: --doc's folder, else an article made here. */
function project(): { files: Record<string, string>; binaries: Record<string, Uint8Array> } {
  const files: Record<string, string> = {};
  const binaries: Record<string, Uint8Array> = {};
  if (docDir) {
    const walk = (d: string, rel = "") => {
      for (const n of readdirSync(join(docDir, d))) {
        const p = join(d, n);
        const r = rel ? `${rel}/${n}` : n;
        if (n.startsWith(".")) continue;
        if (statSync(join(docDir, p)).isDirectory()) walk(p, r);
        else if (/\.(tex|sty|cls|bib|bst|cfg|def|clo|bbx|cbx|dbx|lbx|ltx)$/.test(n)) files[r] = readFileSync(join(docDir, p), "utf8");
        else if (/\.(png|pdf|jpe?g|eps)$/.test(n) && r !== docMain.replace(/\.tex$/, ".pdf")) binaries[r] = new Uint8Array(readFileSync(join(docDir, p)));
      }
    };
    walk("");
    return { files, binaries };
  }
  const words = "the graph of the document is saved while the editor waits for nothing at all".split(" ");
  const para = (k: number) => Array.from({ length: 90 }, (_, i) => words[(i * 7 + k) % words.length]).join(" ") + ".";
  const body = Array.from({ length: 24 }, (_, s) => [
    `\\section{Section ${s + 1}}\\label{s${s}}`,
    para(s),
    `\\begin{equation}\\label{e${s}} \\sum_{i=1}^{${s + 2}} \\frac{x_i^{2}}{1+i} = \\int_0^{${s + 1}} f(t)\\,dt \\end{equation}`,
    `As (\\ref{e${s}}) in Section~\\ref{s${s}} shows, ${para(s + 3)}`,
    "\\begin{itemize}\\item " + para(s + 5).slice(0, 120) + "\\item " + para(s + 9).slice(0, 90) + "\\end{itemize}",
  ].join("\n\n"));
  files[docMain] = ["\\documentclass{article}", "\\usepackage{amsmath}", "\\begin{document}", "\\tableofcontents", ...body, "\\end{document}", ""].join("\n");
  return { files, binaries };
}

const p = project();
const text0 = p.files[docMain];
if (text0 === undefined) throw new Error(`no ${docMain} in the project`);
/** The main text after edit `k` (a word typed into its first line of words after \begin{document}). */
function edited(k: number): string {
  const b = text0.indexOf("\\begin{document}");
  const m = /\n([A-Za-z][^\\%\n{}$]{20,})\n/.exec(text0.slice(b));
  if (!m) throw new Error("no line of words in the body");
  const at = b + m.index + 1 + m[1].length;
  let t = text0;
  for (let i = 1; i <= k; i++) t = t.slice(0, at) + ` Typed${i}` + t.slice(at);
  return t;
}

/** An open of the project (`text`: the main file's) on a fresh core; resolves at its first build. */
async function open(keep: boolean, text: string, on: (e: any, c: { core: Core; session: CoreSession }) => void = () => {}) {
  let first: any;
  let c!: { core: Core; session: CoreSession };
  const built = new Promise<any>((ok) => {
    c = start(keep, (e) => {
      on(e, c);
      if ((e.event === "build" || e.event === "failed") && !first) ok((first = e));
    });
  });
  for (const [n, b] of Object.entries(p.binaries)) c.core.provide(n, { path: "./" + n, bytes: b });
  const r = await c.session.request({ op: "open", main: docMain, files: { ...p.files, [docMain]: text }, engine } as never);
  if (!r.ok) throw new Error(`open: ${r.error}`);
  return { ...c, first: await built };
}

const fails: string[] = [];
const say = (ok: boolean, what: string, how: string) => (console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${how}`), ok || fails.push(what));

// (1: the document opened, graphs kept; its saves interrupted by edits)
const DELAYS = [0, 25, 80];
interface Edit { k: number; at: number; lag: number; givenUp?: any; built?: any }
const edits: Edit[] = [];
const graphEvents: any[] = [];
let saved: any;
let builds = 0;
/** When each build's event came (ms). */
const buildAt: number[] = [];
let done!: () => void;
const finished = new Promise<void>((ok) => (done = ok));
const o = await open(true, text0, (e, c) => {
  if (e.event === "graph") {
    graphEvents.push({ ...e, at: ms() });
    if (e.given_up) {
      const ed = edits.find((x) => !x.givenUp && !x.built);
      if (ed) ed.givenUp = e;
    }
    if (e.saved) (saved = e), setTimeout(done, 50);
    // (a save begun: the k-th of the first three interrupted after DELAYS[k])
    if (e.saving && edits.length < DELAYS.length) {
      const k = edits.length + 1;
      const due = performance.now() + DELAYS[k - 1];
      const ed: Edit = { k, at: 0, lag: 0 };
      edits.push(ed);
      setTimeout(() => {
        const now = performance.now();
        ed.at = ms();
        ed.lag = now - due;
        void c.session.request({ op: "set_file", file: docMain, text: edited(k) } as never);
      }, DELAYS[k - 1]);
    }
  }
  if (e.event === "build" || e.event === "failed") {
    builds++;
    buildAt.push(ms());
    const ed = edits.find((x) => x.at && !x.built);
    if (ed) ed.built = { ...e, at: ms() };
  }
});
const cold = o.first;
const timer = setTimeout(() => (console.log("FAIL no whole save within 10 min"), process.exit(1)), 600_000);
await finished;
clearTimeout(timer);
const pdf = Buffer.from(o.core.mainOutput()?.bytes ?? new Uint8Array());
await o.core.end();

const longest = Math.max(...graphEvents.filter((e) => e.slice_ms !== undefined).map((e) => e.slice_ms));
console.log(`the document: ${cold.pages ?? "?"} pages, its clean build ${Math.round(cold.wall_ms ?? 0)} ms; ${builds} builds`);
for (const e of graphEvents) if (e.saving || e.saved || e.given_up) console.log(`  ${String(e.at).padStart(7)} ms  graph ${e.saving ? "saving" : e.saved ? `saved ${(e.saved / 1048576).toFixed(1)} MB in ${Math.round(e.ms)} ms of slices, ${e.slices} slices, the longest ${(e.slice_ms ?? NaN).toFixed(1)} ms` : `given up after ${e.slices} slices (${Math.round(e.ms)} ms), the longest ${(e.slice_ms ?? NaN).toFixed(1)} ms`}`);
for (const ed of edits) console.log(`  edit ${ed.k} at ${ed.at} ms (${DELAYS[ed.k - 1]} ms into its save): its task ${ed.lag.toFixed(1)} ms late; ${ed.givenUp ? "the save given up" : "NO SAVE GIVEN UP"}; its build ${ed.built ? `at ${ed.built.at} ms` : "NONE"}`);

// (2: the checks)
// (each save begun soon after the build before it: the first of an open, or
// one given up for an edit before any was made, is due at once; a step that
// answered 3 instead was stepped again only after the host's 30 s pause
// (nightly 2026-11-16, ci-graph: "graph saved: NO after 30161 ms"))
const starts = graphEvents.filter((e) => e.saving).map((e) => e.at);
const waits = starts.map((t) => t - Math.max(...buildAt.filter((b) => b <= t)));
say(starts.length === DELAYS.length + 1 && waits.every((w) => w < 5000), "each save begun at once after the build before it", `${starts.length} begun, ${waits.map((w) => `${w} ms`).join(", ")} after their builds`);
say(edits.length === DELAYS.length && edits.every((e) => e.givenUp && e.built), "each of the first three saves given up for the edit typed during it, then the edit built", `${edits.filter((e) => e.givenUp).length} given up, ${edits.filter((e) => e.built).length} built`);
// (an edit's task waits for the slice under way at most, and the timer's own jitter)
const late = Math.max(...edits.map((e) => e.lag));
say(late <= longest + 5, "each edit taken within one slice of the save", `latest ${late.toFixed(1)} ms; the longest slice ${longest.toFixed(1)} ms`);
say(puts === 1 && !!saved && saved.slices > 3, "only the last save kept, made in slices", `${puts} kept; ${saved ? `${saved.slices} slices` : "none saved"}`);

// (3: the graph kept loads on a fresh core: nothing run, the last build's PDF, a clean build's)
const graphNotes: string[] = [];
const again = await open(true, edited(DELAYS.length), (e) => e.event === "graph" && graphNotes.push(...(e.notes ?? [])));
const pdfAgain = Buffer.from(again.core.mainOutput()?.bytes ?? new Uint8Array());
await again.core.end();
const clean = await open(false, edited(DELAYS.length));
const pdfClean = Buffer.from(clean.core.mainOutput()?.bytes ?? new Uint8Array());
await clean.core.end();
say(graphNotes.some((n) => n.startsWith("graph: loaded")) && again.first.ran === 0, "the saved graph loads on a fresh core, no node run", `${again.first.ran} nodes run; ${graphNotes.join(" | ")}`);
say(pdf.length > 0 && Buffer.compare(pdfAgain, pdf) === 0 && Buffer.compare(pdfClean, pdf) === 0, "its PDF the last build's, a clean build's byte for byte", `${pdf.length}, ${pdfAgain.length}, ${pdfClean.length} bytes`);

// (4: a change made while closed: the graph loaded, the change built, and its
// graph saved at once, nothing asked meanwhile (the nightly's ci-graph red:
// that open's build left nothing pending, and the save waited 30 s))
const t4 = ms();
let saved4: number | undefined;
const changed = await open(true, edited(DELAYS.length + 1), (e) => e.event === "graph" && e.saved && saved4 === undefined && (saved4 = ms()));
const built4 = ms();
await new Promise((ok) => setTimeout(ok, 8000));
await changed.core.end();
say(changed.first.ran > 0 && saved4 !== undefined && saved4 - built4 < 5000, "a change made while closed: loaded, built, its graph saved at once", `${changed.first.ran} nodes run, its build ${built4 - t4} ms after the open; ${saved4 === undefined ? "NOT SAVED within 8 s" : `saved ${saved4 - built4} ms after it`}`);

console.log(fails.length ? `${fails.length} FAILED: ${fails.join("; ")}` : `all passed (${ms()} ms)`);
process.exit(fails.length ? 1 : 0);
