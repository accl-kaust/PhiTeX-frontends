// The persisted graph in VS Code's builtin engine, without VS Code (PhiTeX's
// docs/spec-persisted-graph.md): a project in a temporary folder opened as
// the extension opens it, each open on a core of its own (VS Code closed
// and opened again), the graphs kept as the extension keeps them
// (graphs.ts's kvGraphs in a folder standing for the workspace's storage,
// src/extension.ts). Each open's PDF must be, byte for byte, a clean
// build's of the folder as it is then (a core of its own, no graph):
//   the first open, no graph kept: a clean build, its graph saved at the pause;
//   opened again, nothing changed: the graph loaded, no node run;
//   an \input file edited while closed: loaded, the edit built;
//   the main file edited, the figure replaced and the .bib edited while closed;
//   the kept graph damaged (a byte flipped): refused, dropped, a clean build;
//   graphs off (phitex.graph): none loaded, none saved.
//
//   tools/build/build-vscode.sh && tools/sandbox --net node build/vscode/dist/graph.mjs
//
// --threads N: the engine's threads (default: the extension's).
// --time DIR MAIN [ENGINE] [N]: the timings instead, of the folder DIR
// copied aside (its main file MAIN, pdflatex by default), N rounds (3): each
// round an open with graphs off (as every open was before), an open that
// saves its graph, the same document opened again unchanged (the graph
// loaded), and opened again after a word typed while closed; each open on
// a fresh core, the store's formats and packs warm (the first round's open
// warms them, not counted). Times from the open's request to its first
// build's event and to its pages settled.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { setPlatform } from "../../../common/src/platform.ts";
import { startCore, prefetch } from "../src/core.ts";
import { fsKeyValue, nodePlatform } from "../src/platform.ts";
import { kvGraphs, type GraphStore } from "../../../common/src/wasm/graphs.ts";
import { CoreFiles, walk, BINARY } from "../src/project.ts";
import { relPath } from "../src/changes.ts";
import { liveWorkers, workersGone } from "../src/thread.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// (VS Code's global storage: the formats and the packs, warm across the opens)
setPlatform(nodePlatform(root, mkdtempSync(join(tmpdir(), "phitex-store-"))));
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);

/** A `w`×`h` PNG of one colour. */
function png(w: number, h: number, [r, g, b]: number[]): Uint8Array {
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(h * (1 + 3 * w));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set([r, g, b], y * (1 + 3 * w) + 1 + 3 * x);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())]);
}

/** The folder as the extension reads it at an open (loadProject, no editor). */
function load(folder: string) {
  return walk(folder).then((all) => {
    const files: Record<string, string> = {};
    const binaries: Record<string, Uint8Array> = {};
    for (const p of all) {
      const r = relPath(folder, p)!;
      if (BINARY.test(p)) binaries[r] = new Uint8Array(readFileSync(p));
      else files[r] = readFileSync(p, "utf8");
    }
    // (the job's own PDF is its output, not one of its files: the extension's jobPdf)
    return { files, binaries };
  });
}

/** What an open did: its first build's event, the graph's events, its PDF, its times. */
interface Opened {
  build: any;
  graph: any[];
  pdf: Buffer;
  toBuild: number;
  toSettled: number;
  start: number;
}

/**
 * The graphs as the extension keeps them, its puts awaited (`stored()`: the
 * next put done): VS Code's workspace storage is the folder `dir`.
 */
function keptIn(dir: string, folder: () => string, on: () => boolean) {
  const inner = kvGraphs(fsKeyValue(dir), folder, { count: 16, bytes: 2 * 1073741824 }, async () => on());
  let wake: (() => void) | undefined;
  let puts = 0;
  const g: GraphStore & { puts(): number; stored(n: number, limit?: number): Promise<boolean> } = {
    on: inner.on,
    get: inner.get,
    drop: inner.drop,
    async put(doc, bytes) {
      await inner.put(doc, bytes);
      puts++;
      wake?.();
    },
    puts: () => puts,
    stored: (n, limit = 120_000) =>
      new Promise<boolean>((ok) => {
        if (puts > n) return ok(true);
        const timer = setTimeout(() => ok(false), limit);
        wake = () => puts > n && (clearTimeout(timer), ok(true));
      }),
  };
  return g;
}

/**
 * The folder opened on a fresh core (VS Code started again), as the
 * extension opens it (`graphs`: kept, or none: a core that keeps none, a
 * clean build's): its first build in, its pages settled; the core ended
 * after `after` (a graph's save awaited there).
 */
async function openOnce(folder: string, main: string, engine: string, graphs?: ReturnType<typeof keptIn>, after?: (o: Opened) => Promise<void>): Promise<Opened> {
  const ts = performance.now();
  const c = await startCore(root, () => folder, (s) => process.stderr.write(s.endsWith("\n") ? s : s + "\n"), THREADS, undefined, undefined, graphs);
  const start = performance.now() - ts;
  const given = new CoreFiles(c.core);
  const p = await load(folder);
  delete p.binaries[main.replace(/\.tex$/, ".pdf")];
  given.open(Object.keys(p.files), p.binaries);
  prefetch(c.core, c.index, p.files, engine);
  const graph: any[] = [];
  let build: any;
  let settled = 0;
  const done = new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("the open did not settle in 10 min")), 600_000);
    // (the pages settled (the viewer's, told as it happens) and the build's facts (after its step), in either order)
    c.session.onEvent((e: any) => {
      if (e.event === "graph") graph.push(e);
      if ((e.event === "build" || e.event === "failed") && !build) build = { ...e, at: performance.now() };
      if (e.event === "settled" && !settled) settled = performance.now();
      if (build && settled) {
        clearTimeout(timer);
        ok();
      }
    });
  });
  const t = performance.now();
  const r = await c.session.request({ op: "open", main, files: p.files, engine } as never);
  if (!r.ok) throw new Error(`open: ${r.error}`);
  await done;
  const out = c.core.mainOutput();
  const o: Opened = { build, graph, pdf: Buffer.from(out?.bytes ?? new Uint8Array()), toBuild: build.at - t, toSettled: settled - t, start };
  await after?.(o);
  await c.core.end();
  return o;
}

/** The engine's threads (`--threads N`; the extension's default otherwise: this machine's cores, at most 4). */
const THREADS = process.argv.includes("--threads") ? Number(process.argv[process.argv.indexOf("--threads") + 1]) : undefined;

const fails: string[] = [];
const say = (ok: boolean, what: string, how: string) => (console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${how}`), ok || fails.push(what));
const notes = (o: Opened) => o.graph.flatMap((e) => e.notes ?? []);
const loaded = (o: Opened) => o.graph.some((e) => e.loaded);

if (process.argv[2] === "--time") await timings(process.argv[3], process.argv[4], process.argv[5] ?? "pdflatex", Number(process.argv[6] ?? 3));
else await checks();

async function checks(): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "phitex-graph-"));
  const storage = mkdtempSync(join(tmpdir(), "phitex-workspace-"));
  const main = "main.tex";
  const MAIN = [
    "\\documentclass{article}",
    "\\usepackage{graphicx}",
    "\\begin{document}",
    "\\section{First}\\label{s:first}",
    "Graph check. \\input{part}",
    "See Section~\\ref{s:second} and \\cite{knuth}.",
    "",
    "\\includegraphics[width=2cm]{fig.png}",
    "\\section{Second}\\label{s:second}",
    "The second section, after Section~\\ref{s:first}.",
    "\\bibliographystyle{plain}",
    "\\bibliography{refs}",
    "\\end{document}",
    "",
  ].join("\n");
  const write = (p: string, b: string | Uint8Array) => writeFileSync(join(folder, p), b);
  write(main, MAIN);
  write("part.tex", "The part as first written.\n");
  write("refs.bib", "@book{knuth, author={Donald Knuth}, title={The {\\TeX}book}, year={1984}, publisher={Addison-Wesley}}\n");
  write("fig.png", png(16, 16, [220, 30, 30]));

  let on = true;
  const graphs = keptIn(storage, () => folder, () => on);
  /** An open that keeps graphs, its save awaited (`saves`: one is expected). */
  const open = (saves: boolean) => {
    const n = graphs.puts();
    return openOnce(folder, main, "pdflatex", graphs, async () => {
      if (saves && !(await graphs.stored(n))) console.log("  (no graph stored within 2 min)");
    });
  };
  const clean = () => openOnce(folder, main, "pdflatex");
  /** `o`'s PDF against a clean build's of the folder as it is: the same bytes. */
  const exact = async (o: Opened) => {
    const c = await clean();
    const same = o.pdf.length > 0 && Buffer.compare(o.pdf, c.pdf) === 0;
    if (!same) console.log(`  PDF ${o.pdf.length} bytes, a clean build's ${c.pdf.length}`);
    return same;
  };
  const stat = (o: Opened) => `${o.build.why}, ${o.build.ran} nodes run, ${Math.round(o.toBuild)} ms to its build; ${notes(o).join(" | ") || "no graph notes"}`;

  // (1: the first open, nothing kept)
  let before = graphs.puts();
  const first = await open(true);
  say(!loaded(first) && first.build.ran > 0 && graphs.puts() > before && (await exact(first)), "the first open (none kept): a clean build, its graph saved", stat(first));

  // (2: opened again, nothing changed)
  before = graphs.puts();
  const same = await open(false);
  // (a little longer than the core's pause: no save follows, the graph is the one kept)
  await new Promise((r) => setTimeout(r, 2500));
  const pdfSame = Buffer.compare(same.pdf, first.pdf) === 0;
  say(loaded(same) && same.build.ran === 0 && pdfSame && graphs.puts() === before, "opened again, nothing changed: the graph loaded, nothing built", `${stat(same)}; PDF ${pdfSame ? "the first's" : "NOT the first's"}; ${graphs.puts() - before} saves`);

  // (3: an \input file edited while closed)
  write("part.tex", "The part as edited while VS Code was closed.\n");
  before = graphs.puts();
  const edited = await open(true);
  say(loaded(edited) && edited.build.ran > 0 && graphs.puts() > before && (await exact(edited)), "an \\input file edited while closed: loaded, the edit built, a clean build's PDF", stat(edited));

  // (4: the main file, the figure and the .bib, all while closed)
  write(main, MAIN.replace("Graph check.", "Graph check, the main file edited while closed."));
  write("fig.png", png(16, 16, [30, 30, 220]));
  write("refs.bib", "@book{knuth, author={Donald E. Knuth}, title={The {\\TeX}book, edited while closed}, year={1986}, publisher={Addison-Wesley}}\n");
  const many = await open(true);
  say(loaded(many) && many.build.ran > 0 && (await exact(many)), "the main file, the figure and the .bib edited while closed: a clean build's PDF", stat(many));

  // (5: the graph kept damaged: a byte of its payload flipped on disk)
  const files = join(storage, "graph.files");
  const kept = (await import("node:fs")).readdirSync(files).filter((n) => n.startsWith("k"));
  const { deserialize, serialize } = await import("node:v8");
  for (const n of kept) {
    const b = deserialize(readFileSync(join(files, n))) as Uint8Array;
    b[b.length - 100] ^= 0x10;
    writeFileSync(join(files, n), serialize(b));
  }
  const damaged = await open(true);
  const dropped = damaged.graph.some((e) => e.dropped);
  say(kept.length > 0 && !loaded(damaged) && dropped && (await exact(damaged)), "the graph kept damaged: refused and dropped, a clean build's PDF", `${kept.length} kept; ${stat(damaged)}${dropped ? "; dropped" : ""}`);
  // (and the next open loads the one saved after it)
  const after = await open(false);
  say(loaded(after) && after.build.ran === 0 && Buffer.compare(after.pdf, damaged.pdf) === 0, "opened again after that: the new graph loaded, nothing built", stat(after));

  // (6: graphs off: none loaded, none saved)
  on = false;
  before = graphs.puts();
  const off = await openOnce(folder, main, "pdflatex", graphs, () => new Promise((r) => setTimeout(r, 3000)));
  say(!loaded(off) && off.build.ran > 0 && graphs.puts() === before && !off.graph.length, "graphs off: none loaded, none saved", stat(off));

  await workersGone();
  rmSync(folder, { recursive: true });
  rmSync(storage, { recursive: true });
}

async function timings(dir: string, main: string, engine: string, rounds: number): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "phitex-graph-time-"));
  cpSync(dir, folder, { recursive: true });
  const storage = mkdtempSync(join(tmpdir(), "phitex-workspace-"));
  let on = false;
  const graphs = keptIn(storage, () => folder, () => on);
  const line = (what: string, o: Opened, extra = "") =>
    console.log(`${what.padEnd(28)} build ${String(Math.round(o.toBuild)).padStart(6)} ms  pages ${String(Math.round(o.toSettled)).padStart(6)} ms  ran ${String(o.build.ran).padStart(6)}  core start ${Math.round(o.start)} ms${extra}`);
  // (the store's formats and packs warmed: not counted)
  await openOnce(folder, main, engine, graphs);
  const text = readFileSync(join(folder, main), "utf8");
  const word = (k: number) => {
    // (a word typed into the body's first line of words: an edit's)
    const body = text.indexOf("\\begin{document}");
    const m = /\n([A-Za-z][^\\%\n{}$]{20,})\n/.exec(text.slice(body));
    if (!m) throw new Error("no line of words in the body");
    const at = body + m.index + 1 + m[1].length;
    writeFileSync(join(folder, main), text.slice(0, at) + ` Typedword${k}` + text.slice(at));
  };
  for (let k = 1; k <= rounds; k++) {
    writeFileSync(join(folder, main), text);
    on = false;
    line(`round ${k}: graphs off`, await openOnce(folder, main, engine, graphs));
    on = true;
    await graphs.drop(main);
    let save = "";
    const n = graphs.puts();
    line(`round ${k}: first open (saves)`, await openOnce(folder, main, engine, graphs, async (o) => {
      const ok = await graphs.stored(n);
      const s = o.graph.find((e) => e.saved);
      save = ok && s ? `  graph ${(s.saved / 1048576).toFixed(1)} MB, saved in ${Math.round(s.ms)} ms (core)` : "  NO GRAPH SAVED";
    }), save);
    const again = await openOnce(folder, main, engine, graphs);
    line(`round ${k}: second open`, again, `  ${notes(again).find((x: string) => x.startsWith("graph: loaded"))?.replace(/^graph: /, "") ?? "NOT LOADED: " + notes(again).join(" | ")}`);
    word(k);
    const m = graphs.puts();
    const typed = await openOnce(folder, main, engine, graphs, async () => void (await graphs.stored(m)));
    line(`round ${k}: second open, a word`, typed, `  ${loaded(typed) ? "loaded" : "NOT LOADED"}`);
  }
  await workersGone();
  rmSync(folder, { recursive: true });
  rmSync(storage, { recursive: true });
}

console.log(fails.length ? `${fails.length} FAILED: ${fails.join("; ")}` : `all passed (${ms()} ms)`);
process.exitCode = fails.length ? 1 : 0;
setTimeout(() => {
  console.log(`FAIL the process did not exit by itself within 30 s; still active: ${process.getActiveResourcesInfo().join(", ")}; workers: ${liveWorkers()}`);
  process.exit(1);
}, 30_000).unref();
