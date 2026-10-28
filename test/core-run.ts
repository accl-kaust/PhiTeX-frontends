// The core (core/, built for wasm32-wasip1-threads) on Node as VS Code's
// builtin engine runs it: thread 0 here, its threads Node workers
// (vscode/src/thread.ts), the files it lacks found by kpsewhich (TeX Live
// on this machine) and given back asynchronously.
//
//   scripts/sandbox node test/core-run.ts [FILE.tex] [--threads N] [--ini]
//
// Without FILE: a plain TeX job in ini mode (cmr10 from TeX Live), DVI out.

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { Core } from "../common/src/wasm/core.ts";
import { spawner } from "../vscode/src/thread.ts";

const run = promisify(execFile);
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const value = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const file = args.find((a, i) => a.endsWith(".tex") && args[i - 1] !== "--threads");
const ini = !file || flag("--ini");
const text = file ? await readFile(file, "latin1") : "\\catcode`\\{=1 \\catcode`\\}=2 \\font\\x=cmr10 \\x \\shipout\\hbox{Hello}\\end\n";

const wasm = new URL("../target/core/wasm32-wasip1-threads/release/core.wasm", import.meta.url);
const module = await WebAssembly.compile(await readFile(wasm));
// (the format's state kept between runs, as the hosts' stores keep it;
// kpsewhich's answers too, as the hosts' Shelf index answers at once)
const store = "target/core-run.prelude";
const pathsFile = "target/core-run.paths.json";
const paths: Record<string, string | null> = existsSync(pathsFile) ? JSON.parse(await readFile(pathsFile, "utf8")) : {};
const t0 = performance.now();
let wants = 0;
const core = Core.start(module, {
  spawn: spawner(new URL("../vscode/src/thread.ts", import.meta.url)),
  async resolve(name) {
    wants++;
    if (!(name in paths)) paths[name] = await run("kpsewhich", ["-progname=pdflatex", name]).then((r) => r.stdout.trim() || null, () => null);
    const path = paths[name];
    return path ? { path, bytes: new Uint8Array(await readFile(path)) } : null;
  },
  async event(e) {
    if (e.event !== "built") return;
    const out = core.takeOutput();
    const stored = e.prelude ? writeFile(store, core.takePrelude()) : undefined;
    const ms = performance.now() - t0;
    console.log(`built: ${e.pages} page(s), ${out.length} bytes ${e.pdf ? "PDF" : "DVI"}, build ${e.ms.toFixed(0)} ms, ${ms.toFixed(0)} ms from start, ${wants} files asked${e.prelude ? `, format state ${(e.prelude / 1e6).toFixed(1)} MB stored` : ""}`);
    if (!e.pages) console.log(e.log.split("\n").slice(-25).join("\n"));
    await Promise.all([stored, writeFile(`target/core-run.${e.pdf ? "pdf" : "dvi"}`, out), writeFile(pathsFile, JSON.stringify(paths))]);
    process.exit(e.pages > 0 ? 0 : 1);
  },
  log: (s) => process.stderr.write(s),
  trap(tid, error) {
    console.error(`thread ${tid} trapped: ${error}`);
    process.exit(2);
  },
});
const main = file ? file.split("/").pop()! : "plain.tex";
if (!ini && existsSync(store) && !flag("--cold")) core.setPrelude(new Uint8Array(await readFile(store)));
core.open({ main, text, ini, threads: value("--threads") ? Number(value("--threads")) : undefined });
