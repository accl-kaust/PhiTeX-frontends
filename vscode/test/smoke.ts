// The VS Code extension's builtin engine without VS Code: the core in this
// thread, its threads Node worker threads (core.ts, dist/thread.js), a
// project folder opened through CoreSession as the webview's requests open
// it, and its language server spoken to as the editor speaks to it
// (lspChannel). Checks the first build settles with pages and a PDF, an
// edit sent as the editor sends it (didChange) settles again with a
// different PDF, the server's status and the caches' commands answer, and
// how long each took.
//
// With --high, the core's heap is first filled to 2 GiB (blocks never
// touched: not committed), so the pointers the round trip passes are at or
// above 2 GiB, where JS sees wasm's i32 as negative.
//
//   scripts/build-vscode.sh && scripts/sandbox --net node vscode/dist/smoke.mjs FOLDER [MAIN] [--high]

import { readdirSync, readFileSync, statSync, mkdtempSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { setPlatform } from "../../common/src/platform.ts";
import { findMain } from "../src/changes.ts";
import { prefetch, startCore } from "../src/core.ts";
import { nodePlatform } from "../src/platform.ts";
import { lspChannel } from "../../common/src/wasm/host.ts";

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
const fetched = new Set<string>();
session.onEvent((e: any) => {
  if (e.event === "settled") (settled++, wake());
  if (e.event === "progress" && e.phase === "fetching" && e.pack) fetched.add(e.pack);
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
// (the editor's language client: initialized, the main file opened as its buffer)
const lsp = lspChannel(core, "smoke");
const answers = new Map<number, (m: any) => void>();
const states: string[] = [];
lsp.onMessage((m) => {
  if (m.id !== undefined && !m.method) answers.get(m.id)?.(m);
  if (m.method === "phitex/status") states.push(m.params.state);
});
let ids = 0;
const ask = (method: string, params: unknown) => new Promise<any>((ok) => {
  const id = ++ids;
  answers.set(id, ok);
  lsp.send({ jsonrpc: "2.0", id, method, params });
});
const tell = (method: string, params: unknown) => lsp.send({ jsonrpc: "2.0", method, params });
// (as VS Code's client is: window/showDocument supported, the folder's absolute URI its root)
const folderAt = resolve(folder);
const uri = "file://" + join(folderAt, main);
const init = await ask("initialize", { processId: null, rootUri: "file://" + folderAt, capabilities: { window: { showDocument: { support: true } } }, initializationOptions: { threads } });
tell("initialized", {});
tell("textDocument/didOpen", { textDocument: { uri, languageId: "latex", version: 1, text: files[main] } });
console.log(`lsp: ${(init.result?.capabilities?.executeCommandProvider?.commands ?? []).length} commands`);
await next(1);
const pages = await session.request({ op: "pages" } as never);
const first = core.pdf();
console.log(`first build: ${ms()} ms, ${pages.json?.pages?.length ?? "?"} pages, PDF ${first?.length ?? 0} bytes, packs fetched: ${fetched.size} (${[...fetched].join(" ")})`);

// (an edit as the editor sends it: a word after the main file's \begin{document}, at its
// line and UTF-16 column)
const at = files[main].indexOf("\\begin{document}") + "\\begin{document}".length;
const before = files[main].slice(0, at).split("\n");
const pos = { line: before.length - 1, character: before[before.length - 1].length };
let version = 1;
// (what the edits inserted at `at`, each before the last: the text as the core has it)
let inserted = "";
const edit = (text: string) => {
  inserted = text + inserted;
  tell("textDocument/didChange", { textDocument: { uri, version: ++version }, contentChanges: [{ range: { start: pos, end: pos }, text }] });
};
const t1 = performance.now();
edit("\nSmoke test words.\n");
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
// (PHITEX_KEYS keystrokes, 5 by default: two runs' profiles apart are that many more keystrokes' own)
for (let i = 0; i < +(process.env.PHITEX_KEYS ?? 5); i++) {
  const n = settled;
  const b = performance.now();
  edit(`w${i} `);
  await next(n + 1);
  builds.push(performance.now() - b);
  const a = performance.now();
  const f = await session.request({ op: "frame", page: 0, scale: 2.67 } as never);
  times.push(f.ok ? `${(performance.now() - a).toFixed(1)} ms (${f.json.drawn} drawn, ${f.json.kept} kept)` : "FAILED");
}
console.log(`keystroke builds (edit to settled): ${builds.slice(0, 12).map((x) => x.toFixed(0)).join(" ")}${builds.length > 12 ? " ..." : ""} ms; median ${[...builds].sort((a, b) => a - b)[builds.length >> 1]?.toFixed(1)}`);
console.log(`keystroke frames: ${times.slice(0, 5).join(", ")}`);
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
// (a double-click on the page, as the webview asks for it: the source of a place, the
// editor told by the server, window/showDocument)
const shown = new Promise<any>((ok) => {
  lsp.onMessage((m) => m.method === "window/showDocument" && ok(m));
  setTimeout(() => ok(null), 10_000);
});
const now = files[main].slice(0, at) + inserted + files[main].slice(at);
const word = now.indexOf("Smoke test words.");
const bytes = (n: number) => new TextEncoder().encode(now.slice(0, n)).length;
const src = await session.request({ op: "source", file: main, start: bytes(word), end: bytes(word + 5) } as never);
const doc = await shown;
console.log(`double-click: source ${src.ok ? "ok" : "failed " + src.error}; showDocument ${doc ? `${doc.params.uri.split("/").pop()} line ${doc.params.selection?.start?.line}` : "NOT SENT"}`);
// (the status the server told; the caches, this host's)
const caches = await ask("workspace/executeCommand", { command: "phitex.cacheStats", arguments: [] });
const said = caches.result?.caches?.map((c: any) => `${c.scope} ${c.entries} entries ${c.hits}/${c.misses}`).join(", ");
console.log(`lsp: status ${[...new Set(states)].join(" ")}; caches: ${said ?? caches.error?.message}`);
const statusOk = states.includes("ready") && !!caches.result && !!doc;
await ask("shutdown", null);
tell("exit", null);
lsp.close();
core.end();
process.exit(first && changed && png.ok && statusOk ? 0 : 1);
