// The core (core/, built for wasm32-wasip1-threads) on Node as VS Code's
// builtin engine runs it: thread 0 here, its threads Node workers
// (vscode/src/thread.ts). Files as the hosts give them: Shelf's index (the
// repo's copy) resolved inside the core, its packs from target/shelf-cache/
// or Shelf itself, the bundled texmf/ by name, the document's directory
// given before the build; or (--kpse) every name found by kpsewhich (TeX
// Live on this machine). The session's store (the format's state, the
// records) in target/core-run-store/, as the hosts' stores keep it.
//
//   scripts/sandbox --net node test/core-run.ts [FILE.tex] [--threads N] [--ini] [--cold] [--kpse] [--timeline] [--minted]
//
// --cold: the store's formats not given (built again, and stored).
// --store DIR: the store there (scripts/build/make-formats.sh: the formats shipped).
// --packs FILE: the ids of the packs the build fetched, written there.
// --names FILE: the bundled texmf/ files the build read, by name, written there
// (scripts/build/build-web.sh: a format's first build's, fetched ahead by the web frontend).
// --texmf DIR: the bundled texmf/ read from there (default: the repo's texmf/).
// --wasm PATH: the core built elsewhere (e.g. with --features profile).
// --env NAME=value (repeatable): the core's environment, e.g. PHITEX_TEX_TIME=1.
// --no-bundled: no texmf/ bundled, every file from Shelf (/try's question: are the bundled files needed?).
// --engine NAME: the TeX program (pdflatex by default; xelatex: make-formats.sh's XeLaTeX format).
// --single: the single-threaded core (wasm32-wasip1, Firefox's: target/core's
// core.wasm for that target), every ask answered inside its call (the
// packs from target/shelf-cache/, else Shelf by curl).
// --minted: \write18 runs latexminted in Pyodide (PhiTeX's
// tools/minted-pyodide runner, Pyodide from node_modules, minted's wheels
// from TeX Live's scripts/minted).
//
// Without FILE: a plain TeX job in ini mode (cmr10), DVI out. The first
// build's output is written to target/core-run.pdf (or .dvi), and
// the harness ends after it (the records the build changed are stored as it
// settles, before its event).

import { execFile, execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Core, type Store } from "../common/src/wasm/core.ts";
import { mintedShell } from "../common/src/wasm/minted.ts";
import { HOSTS } from "../common/src/shelf.ts";
import { spawner } from "../vscode/src/thread.ts";

const run = promisify(execFile);
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const value = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const file = args.find((a, i) => a.endsWith(".tex") && !["--threads", "--wasm", "--env", "--store", "--packs", "--names", "--texmf", "--engine"].includes(args[i - 1]));
const ini = !file || flag("--ini");
const kpse = flag("--kpse");
const text = file ? await readFile(file, "utf8") : "\\catcode`\\{=1 \\catcode`\\}=2 \\font\\x=cmr10 \\x \\shipout\\hbox{Hello}\\end\n";

// (--wasm PATH: another build, e.g. target/core-profile's)
const single = flag("--single");
const wasm = value("--wasm") ?? new URL(`../target/core/${single ? "wasm32-wasip1" : "wasm32-wasip1-threads"}/release/core.wasm`, import.meta.url);
const module = await WebAssembly.compile(await readFile(wasm));
// (the session's store kept between runs, as the hosts' stores keep it;
// kpsewhich's answers too, as the hosts' Shelf index answers at once)
const storeDir = (value("--store") ?? `target/core-run-store${kpse ? "-kpse" : ""}`) + "/";
const stored: Promise<void>[] = [];
let formatBytes = 0;
const store: Store = {
  async get(key) {
    if (flag("--cold") && key.startsWith("format/")) return null;
    return readFile(storeDir + encodeURIComponent(key)).then((b) => new Uint8Array(b), () => null);
  },
  put(key, bytes) {
    if (/^format\/[^/]+$/.test(key)) formatBytes = bytes.length;
    const p = mkdir(storeDir, { recursive: true }).then(() => writeFile(storeDir + encodeURIComponent(key), bytes));
    stored.push(p);
    return p;
  },
};
const pathsFile = "target/core-run.paths.json";
const paths: Record<string, string | null> = existsSync(pathsFile) ? JSON.parse(await readFile(pathsFile, "utf8")) : {};
const t0 = performance.now();
let wants = 0;
let stderr = "";
/** When each pack was asked and answered (ms from start). */
const timeline: [string, number, number][] = [];
let packs = 0;
let fetched = 0;
// (Shelf's hosts in order, as the extensions ask them (shelf.ts HOSTS): one that cannot be
// reached (KAUST resets v1.shelf.phitex.org) passed over, and asked last from then on;
// SHELF_URL: that address alone)
const shelfHosts = process.env.SHELF_URL ? [process.env.SHELF_URL] : [...HOSTS];
async function fromShelf(path: string): Promise<Response> {
  let why: unknown;
  for (const h of [...shelfHosts]) {
    try {
      return await fetch(h + path);
    } catch (e) {
      why = e;
      shelfHosts.push(...shelfHosts.splice(shelfHosts.indexOf(h), 1));
    }
  }
  throw why;
}
const bundledDir = value("--texmf") ? new URL(pathToFileURL(resolvePath(value("--texmf")!)).href + "/") : new URL("../texmf/", import.meta.url);
/** The bundled files the build read, in the order it asked (--names). */
const read: string[] = [];

/** Shelf's pack `id`: kept in target/shelf-cache/, else Shelf's, kept. */
async function fetchPack(id: string): Promise<Uint8Array | null> {
  packs++;
  const kept = `target/shelf-cache/${id}.pack`;
  if (existsSync(kept)) return new Uint8Array(await readFile(kept));
  fetched++;
  const r = await fromShelf("h/" + encodeURIComponent(id) + ".pack");
  const b = new Uint8Array(await r.arrayBuffer());
  if (!r.ok || b[0] !== 0x1f) return null;
  await mkdir("target/shelf-cache", { recursive: true });
  await writeFile(kept, b);
  return b;
}
const WHEELS = "/usr/share/texmf-dist/scripts/minted/";
const shell = flag("--minted")
  ? mintedShell(async () => {
      const t = performance.now();
      const { loadPyodide } = await import("pyodide");
      const { createMintedRunner } = await import("../phitex/tools/minted-pyodide/runner.mjs" as string);
      const wheels = await Promise.all((await readdir(WHEELS)).filter((f) => f.endsWith(".whl")).map(async (f) => [f, new Uint8Array(await readFile(WHEELS + f))]));
      const r = await createMintedRunner({ loadPyodide, wheels });
      console.log(`minted: Pyodide and latexminted loaded in ${(performance.now() - t).toFixed(0)} ms`);
      return r;
    })
  : undefined;
let shellCalls = 0;
/** Shelf's pack `id` at once (--single): kept in target/shelf-cache/, else Shelf's by curl, kept. */
function packNow(id: string): Uint8Array | null {
  packs++;
  const kept = `target/shelf-cache/${id}.pack`;
  if (existsSync(kept)) return new Uint8Array(readFileSync(kept));
  fetched++;
  for (const h of shelfHosts) {
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
const options = {
  // (--env NAME=value, repeatable: the engine's switches)
  env: args.flatMap((a, i) => (args[i - 1] === "--env" ? [a] : [])),
  shell: shell && (async (command, files) => {
    shellCalls++;
    const r = await shell(command, files);
    console.log(`  \\write18 ${command.slice(0, 60)}: status ${r.status}, ${files.length} files in, ${r.wrote.length} written, ${r.removed.length} removed`);
    return r;
  }),
  spawn: spawner(new URL("../vscode/src/thread.ts", import.meta.url)),
  store,
  async fetch(id) {
    const t = performance.now() - t0;
    try {
      return await fetchPack(id);
    } finally {
      timeline.push([id, t, performance.now() - t0]);
    }
  },
  async resolve(name) {
    wants++;
    if (!kpse) {
      // (by name only the bundled texmf/: the project's own were given before)
      const b = flag("--no-bundled") ? null : await readFile(new URL(name, bundledDir)).catch(() => null);
      if (b) read.push(name);
      return b ? { path: name, bytes: new Uint8Array(b) } : null;
    }
    if (!(name in paths)) paths[name] = await run("kpsewhich", ["-progname=pdflatex", name]).then((r) => r.stdout.trim() || null, () => null);
    const path = paths[name];
    return path ? { path, bytes: new Uint8Array(await readFile(path)) } : null;
  },
  event(e) {
    if (e.event === "build" || e.event === "failed") void built(e);
  },
  log(s) {
    stderr += s;
    process.stderr.write(s);
  },
  async trap(tid: number, error: string) {
    // (the whole of it kept: a panic's message is what the core wrote before it)
    const f = `target/core-trap-${Date.now()}.txt`;
    await writeFile(f, `thread ${tid} trapped\n${stderr}\n${error}\n`);
    console.error(`thread ${tid} trapped (all of it in ${f}): ${stderr.split("\n").filter(Boolean).slice(-3).join(" | ")}`);
    process.exit(2);
  },
} satisfies Parameters<typeof Core.start>[1];
const core = single
  ? Core.startSingle(module, {
      ...options,
      sync: {
        resolve: (name) => {
          wants++;
          const b = flag("--no-bundled") ? null : (() => { try { return readFileSync(new URL(name, bundledDir)); } catch { return null; } })();
          if (b) read.push(name);
          return b ? { path: name, bytes: new Uint8Array(b) } : null;
        },
        fetch: (id) => {
          const t = performance.now() - t0;
          try {
            return packNow(id);
          } finally {
            timeline.push([id, t, performance.now() - t0]);
          }
        },
        stored: (key) => {
          if (flag("--cold") && key.startsWith("format/")) return null;
          try {
            return new Uint8Array(readFileSync(storeDir + encodeURIComponent(key)));
          } catch {
            return null;
          }
        },
      },
    })
  : Core.start(module, options);
const main = file ? file.split("/").pop()! : "plain.tex";
if (!kpse) {
  core.setIndex(gunzipSync(await readFile("shelf-index.tsv.gz")), await readFile("shelf-release.json"), gunzipSync(await readFile("shelf-packs.tsv.gz")), flag("--no-bundled") ? [] : (await readdir(bundledDir)).filter((n) => n !== "names.txt"));
  // (the document's directory, given before the build: a project's files)
  const dir = file ? file.slice(0, file.lastIndexOf("/") + 1) || "./" : null;
  for (const n of dir ? await readdir(dir) : []) if (n !== main && /\.(tex|sty|cls|bib|bst|cfg|def|png|pdf|jpg)$/.test(n)) core.provide(n, { path: "./" + n, bytes: new Uint8Array(await readFile(dir + n)) });
}
let first: any;
/** The first build in: its output written, what it took said, the stores awaited, the harness done. */
async function built(e: any): Promise<void> {
  if (first) return;
  first = e;
  const out = core.mainOutput();
  const ms = performance.now() - t0;
  console.log(`built: ${e.pages ?? 0} page(s), ${out?.bytes.length ?? 0} bytes ${out ? (out.pdf ? "PDF" : "DVI") : ""}, build ${(e.wall_ms ?? 0).toFixed(0)} ms, ${ms.toFixed(0)} ms from start, ${wants} files asked by name, ${packs} packs (${fetched} from Shelf)${formatBytes ? `, format state ${(formatBytes / 1e6).toFixed(1)} MB stored` : ""}`);
  if (e.errors?.length || e.message) console.log("errors:", e.message ?? "", (e.errors ?? []).slice(0, 10));
  if (flag("--timeline")) for (const [id, a, b] of timeline) console.log(`  ${a.toFixed(0).padStart(6)} → ${b.toFixed(0).padStart(6)} ms  ${id}`);
  if (out) stored.push(writeFile(`target/core-run.${out.pdf ? "pdf" : "dvi"}`, out.bytes));
  // (--packs FILE: the packs this build fetched, one id a line)
  if (value("--packs")) stored.push(writeFile(value("--packs")!, timeline.map(([id]) => id + "\n").join("")));
  // (--names FILE: the bundled files it read, one name a line)
  if (value("--names")) stored.push(writeFile(value("--names")!, read.map((n) => n + "\n").join("")));
  await Promise.all([...stored, writeFile(pathsFile, JSON.stringify(paths))]);
  process.exit(first.pages > 0 ? 0 : 1);
}
core.open({ main, text, ini, shell: !!shell, threads: value("--threads") ? Number(value("--threads")) : undefined, engine: value("--engine") });
