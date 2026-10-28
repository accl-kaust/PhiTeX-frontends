// The core (core/, built for wasm32-wasip1-threads) on Node as VS Code's
// builtin engine runs it: thread 0 here, its threads Node workers
// (vscode/src/thread.ts). Files as the hosts give them: Shelf's index (the
// repo's copy) resolved inside the core, its packs from target/shelf-cache/
// or Shelf itself, the bundled texmf/ by name, the document's directory
// given before the build; or (--kpse) every name found by kpsewhich (TeX
// Live on this machine).
//
//   scripts/sandbox --net node test/core-run.ts [FILE.tex] [--threads N] [--ini] [--cold] [--kpse] [--timeline] [--minted]
//
// --wasm PATH: the core built elsewhere (e.g. with --features profile).
// --env NAME=value (repeatable): the core's environment, e.g. PHITEX_TEX_TIME=1.
// --minted: \write18 runs latexminted in Pyodide (PhiTeX's
// tools/minted-pyodide runner, Pyodide from node_modules, minted's wheels
// from TeX Live's scripts/minted).
//
// Without FILE: a plain TeX job in ini mode (cmr10), DVI out.

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import { Core } from "../common/src/wasm/core.ts";
import { mintedShell } from "../common/src/wasm/minted.ts";
import { spawner } from "../vscode/src/thread.ts";

const run = promisify(execFile);
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const value = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const file = args.find((a, i) => a.endsWith(".tex") && !["--threads", "--wasm", "--env"].includes(args[i - 1]));
const ini = !file || flag("--ini");
const kpse = flag("--kpse");
const text = file ? await readFile(file, "latin1") : "\\catcode`\\{=1 \\catcode`\\}=2 \\font\\x=cmr10 \\x \\shipout\\hbox{Hello}\\end\n";

// (--wasm PATH: another build, e.g. target/core-profile's)
const wasm = value("--wasm") ?? new URL("../target/core/wasm32-wasip1-threads/release/core.wasm", import.meta.url);
const module = await WebAssembly.compile(await readFile(wasm));
// (the format's state kept between runs, as the hosts' stores keep it;
// kpsewhich's answers too, as the hosts' Shelf index answers at once)
const store = `target/core-run${kpse ? "-kpse" : ""}.prelude`;
const pathsFile = "target/core-run.paths.json";
const paths: Record<string, string | null> = existsSync(pathsFile) ? JSON.parse(await readFile(pathsFile, "utf8")) : {};
const t0 = performance.now();
let wants = 0;
let stderr = "";
/** When each pack was asked and answered (ms from start). */
const timeline: [string, number, number][] = [];
let packs = 0;
let fetched = 0;
const SHELF = "https://shelf-phitex.pages.dev/tl2026/";
const bundledDir = new URL("../texmf/", import.meta.url);

/** Shelf's pack `id`: kept in target/shelf-cache/, else Shelf's, kept. */
async function fetchPack(id: string): Promise<Uint8Array | null> {
  packs++;
  const kept = `target/shelf-cache/${id}.pack`;
  if (existsSync(kept)) return new Uint8Array(await readFile(kept));
  fetched++;
  const r = await fetch(SHELF + "h/" + encodeURIComponent(id) + ".pack");
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
const core = Core.start(module, {
  // (--env NAME=value, repeatable: the engine's switches)
  env: args.flatMap((a, i) => (args[i - 1] === "--env" ? [a] : [])),
  shell: shell && (async (command, files) => {
    shellCalls++;
    const r = await shell(command, files);
    console.log(`  \\write18 ${command.slice(0, 60)}: status ${r.status}, ${files.length} files in, ${r.wrote.length} written, ${r.removed.length} removed`);
    return r;
  }),
  spawn: spawner(new URL("../vscode/src/thread.ts", import.meta.url)),
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
      const b = await readFile(new URL(name, bundledDir)).catch(() => null);
      return b ? { path: name, bytes: new Uint8Array(b) } : null;
    }
    if (!(name in paths)) paths[name] = await run("kpsewhich", ["-progname=pdflatex", name]).then((r) => r.stdout.trim() || null, () => null);
    const path = paths[name];
    return path ? { path, bytes: new Uint8Array(await readFile(path)) } : null;
  },
  async event(e) {
    if (e.event !== "built") return;
    const out = core.takeOutput();
    const stored = e.prelude ? writeFile(store, core.takePrelude()) : undefined;
    const ms = performance.now() - t0;
    console.log(`built: ${e.pages} page(s), ${out.length} bytes ${e.pdf ? "PDF" : "DVI"}, build ${e.ms.toFixed(0)} ms, ${ms.toFixed(0)} ms from start, ${wants} files asked by name, ${packs} packs (${fetched} from Shelf)${e.prelude ? `, format state ${(e.prelude / 1e6).toFixed(1)} MB stored` : ""}`);
    if (!e.prelude_complete || e.prelude_diagnostics?.length) console.log("format:", e.prelude_complete ? "complete" : "INCOMPLETE", e.prelude_diagnostics.slice(0, 10));
    if (flag("--timeline")) for (const [id, a, b] of timeline) console.log(`  ${a.toFixed(0).padStart(6)} → ${b.toFixed(0).padStart(6)} ms  ${id}`);
    if (!e.pages) console.log(e.log.split("\n").slice(-25).join("\n"));
    await Promise.all([stored, writeFile(`target/core-run.${e.pdf ? "pdf" : "dvi"}`, out), writeFile(pathsFile, JSON.stringify(paths))]);
    process.exit(e.pages > 0 ? 0 : 1);
  },
  log(s) {
    stderr += s;
    process.stderr.write(s);
  },
  async trap(tid, error) {
    // (the whole of it kept: a panic's message is what the core wrote before it)
    const f = `target/core-trap-${Date.now()}.txt`;
    await writeFile(f, `thread ${tid} trapped\n${stderr}\n${error}\n`);
    console.error(`thread ${tid} trapped (all of it in ${f}): ${stderr.split("\n").filter(Boolean).slice(-3).join(" | ")}`);
    process.exit(2);
  },
});
const main = file ? file.split("/").pop()! : "plain.tex";
if (!kpse) {
  core.setIndex(gunzipSync(await readFile("shelf-index.tsv.gz")), await readFile("shelf-release.json"), (await readdir(bundledDir)).filter((n) => n !== "names.txt"));
  // (the document's directory, given before the build: a project's files)
  const dir = file ? file.slice(0, file.lastIndexOf("/") + 1) || "./" : null;
  for (const n of dir ? await readdir(dir) : []) if (n !== main && /\.(tex|sty|cls|bib|bst|cfg|def|png|pdf|jpg)$/.test(n)) core.provide(n, { path: "./" + n, bytes: new Uint8Array(await readFile(dir + n)) });
}
if (!ini && existsSync(store) && !flag("--cold")) core.setPrelude(new Uint8Array(await readFile(store)));
core.open({ main, text, ini, shell: !!shell, threads: value("--threads") ? Number(value("--threads")) : undefined });
