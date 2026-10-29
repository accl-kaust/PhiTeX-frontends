// The VS Code extension's builtin engine without VS Code: the core in this
// thread, its threads Node worker threads (core.ts, dist/thread.js), a
// project folder opened through CoreSession as the webview's requests open
// it. Checks the first build settles with pages and a PDF, an edit pushed
// as the editor pushes it settles again with a different PDF, and how long
// each took.
//
// With --high, the core's heap is first filled to 2 GiB (blocks never
// touched: not committed), so the pointers the round trip passes are at or
// above 2 GiB, where JS sees wasm's i32 as negative.
//
//   scripts/build-vscode.sh && scripts/sandbox --net node vscode/dist/smoke.mjs FOLDER [MAIN] [--high]

import { readdirSync, readFileSync, statSync, mkdtempSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { setPlatform } from "../../common/src/platform.ts";
import { findMain } from "../src/changes.ts";
import { prefetch, startCore } from "../src/core.ts";
import { nodePlatform } from "../src/platform.ts";

const high = process.argv.includes("--high");
const [folder, mainArg] = process.argv.slice(2).filter((a) => a !== "--high");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
setPlatform(nodePlatform(root, mkdtempSync(join(tmpdir(), "phitex-store-"))));

const files: Record<string, string> = {};
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tex|sty|cls|bib)$/.test(n)) files[relative(folder, p)] = readFileSync(p, "utf8");
  }
};
walk(folder);
const main = mainArg ?? findMain(files);
if (!main) throw new Error("no main .tex file");

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const threads = process.env.PHITEX_THREADS ? +process.env.PHITEX_THREADS : undefined;
const { core, session, index } = await startCore(root, () => folder, (s) => process.stderr.write(s), threads, process.env.PHITEX_TEX_TIME ? ["PHITEX_TEX_TIME=1"] : []);
console.log(`core started: ${ms()} ms`);

let settled = 0;
let wake = () => {};
const fetched: string[] = [];
session.onEvent((e: any) => {
  if (e.event === "settled") (settled++, wake());
  if (e.event === "fetching" && !e.failed) fetched.push(e.pack);
});
const next = (n: number) => new Promise<void>((ok, fail) => {
  const timer = setTimeout(() => fail(new Error(`no build settled in 120 s (${settled} settled)`)), 120_000);
  wake = () => settled >= n && (clearTimeout(timer), ok());
});

if (high) {
  // (the heap's top moved past 2 GiB by two 1.1 GB blocks (one Rust allocation
  // is at most isize::MAX), then the free space below it used up in 4 KiB
  // blocks: the allocator takes small ones from there first)
  const x = (core as unknown as { x: { ph_alloc(n: number): number } }).x;
  x.ph_alloc(1_100_000_000);
  x.ph_alloc(1_100_000_000);
  let probe = 0;
  while ((probe = x.ph_alloc(64) >>> 0) < 2 ** 31) if (!x.ph_alloc(4096)) throw new Error("--high: the heap is full below 2 GiB");
  console.log(`--high: a new allocation at ${(probe / 2 ** 30).toFixed(2)} GiB`);
}
prefetch(core, index, files, "pdflatex");
const r = await session.request({ op: "open", main, files } as never);
if (!r.ok) throw new Error(`open: ${r.error}`);
await next(1);
const pages = await session.request({ op: "pages" } as never);
const first = core.pdf();
console.log(`first build: ${ms()} ms, ${pages.json?.pages?.length ?? "?"} pages, PDF ${first?.length ?? 0} bytes, packs fetched: ${fetched.length} (${fetched.join(" ")})`);

// (an edit as the editor pushes it: a word after the main file's \begin{document})
const at = files[main].indexOf("\\begin{document}") + "\\begin{document}".length;
const t1 = performance.now();
core.push({ ask: "edit", file: main, start: at, end: at, text: "\nSmoke test words.\n" });
await next(2);
const second = core.pdf();
const changed = !!first && !!second && Buffer.compare(Buffer.from(first), Buffer.from(second)) !== 0;
console.log(`edit: ${Math.round(performance.now() - t1)} ms, PDF ${changed ? "changed" : "UNCHANGED"}`);
// (the page as the viewer's Strips asks for it: its frame at 2.67 px/pt, then its strips)
const t2 = performance.now();
const frame = await session.request({ op: "frame", page: 0, scale: 2.67 } as never);
const keys = frame.ok ? ((frame.json?.bands ?? []) as [string, number, number][]).map((b) => b[0]) : [];
const t3 = performance.now();
const strips = (await session.request({ op: "strips", keys } as never)) as { ok: boolean; bytes?: Uint8Array; error?: string };
const t4 = performance.now();
// (a keystroke's frame: one word typed, the page asked again; only its changed bands drawn)
const times: string[] = [];
const builds: number[] = [];
for (let i = 0; i < 5; i++) {
  const n = settled;
  const b = performance.now();
  core.push({ ask: "edit", file: main, start: at, end: at, text: `w${i} ` });
  await next(n + 1);
  builds.push(performance.now() - b);
  const a = performance.now();
  const f = await session.request({ op: "frame", page: 0, scale: 2.67 } as never);
  times.push(f.ok ? `${(performance.now() - a).toFixed(1)} ms (${f.json.drawn} drawn, ${f.json.kept} kept)` : "FAILED");
}
console.log(`keystroke builds (edit to settled): ${builds.map((x) => x.toFixed(0)).join(" ")} ms`);
console.log(`keystroke frames: ${times.join(", ")}`);
const png = { ok: frame.ok && !!strips.bytes?.length };
console.log(frame.ok ? `frame: ${frame.json.pw}x${frame.json.ph}, ${keys.length} bands (${frame.json.drawn} drawn, ${frame.json.kept} kept), ${frame.json.text.length} text lines, ${(t3 - t2).toFixed(1)} ms; strips: ${strips.bytes?.length ?? 0} bytes, ${(t4 - t3).toFixed(1)} ms` : `frame FAILED ${frame.error}`);
// (the heap: the last 64 KiB page with a byte set, from the top, and how many pages were written)
const mem = new Uint32Array((core as unknown as { memory: WebAssembly.Memory }).memory.buffer);
const PAGE = 65536 / 4;
let top = 0, written = 0;
for (let p = 0; p < mem.length / PAGE; p++) {
  const o = p * PAGE;
  for (let i = 0; i < PAGE; i++) if (mem[o + i]) { written++; top = p; break; }
}
console.log(`threads ${threads ?? "default"}: heap top ${((top + 1) * 65536 / 2 ** 20).toFixed(0)} MiB, ${(written * 65536 / 2 ** 20).toFixed(0)} MiB of pages written`);
core.close();
process.exit(first && changed && png.ok ? 0 : 1);
