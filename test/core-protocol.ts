// The core's viewer protocol (phitex-live's, `phitex watch`'s) through
// CoreSession, the viewer's transport on the wasm core: a document opened
// with its files, its cold build settled; the viewer's `pages`, `status`
// and `origins` of page 0 asked; an edit that makes an error, its
// diagnostics told and its pages settled; the edit undone, the error gone;
// the edits' deltas in an `origins` event; the cursor revealed; the PDF.
// Files and store as test/core-run.ts has them (Shelf's index, its packs
// from target/shelf-cache/, the store in target/core-run-store/).
//
//   scripts/sandbox --net node test/core-protocol.ts [FILE.tex] [--cold]
//
// FILE: an article whose text has "Some text" (target/hello.tex: the
// amsmath article). Exits 0 when every check holds, else 1.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { Core, CoreSession, type Store } from "../common/src/wasm/core.ts";
import { spawner } from "../vscode/src/thread.ts";

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".tex")) ?? "target/hello.tex";
const cold = args.includes("--cold");
const main = file.split("/").pop()!;
const dir = file.slice(0, file.lastIndexOf("/") + 1) || "./";
const t0 = performance.now();
const at = () => (performance.now() - t0).toFixed(0).padStart(6) + " ms";

const storeDir = "target/core-run-store/";
const store: Store = {
  async get(key) {
    if (cold && key.startsWith("format/")) return null;
    return readFile(storeDir + encodeURIComponent(key)).then((b) => new Uint8Array(b), () => null);
  },
  async put(key, bytes) {
    await mkdir(storeDir, { recursive: true });
    await writeFile(storeDir + encodeURIComponent(key), bytes);
  },
};
const bundled = new URL("../texmf/", import.meta.url);
const core = Core.start(await WebAssembly.compile(await readFile(new URL("../target/core/wasm32-wasip1-threads/release/core.wasm", import.meta.url))), {
  spawn: spawner(new URL("../vscode/src/thread.ts", import.meta.url)),
  store,
  async fetch(id) {
    const b = await readFile(`target/shelf-cache/${id}.pack`).catch(() => null);
    if (b) return new Uint8Array(b);
    const r = await fetch("https://shelf-phitex.pages.dev/tl2026/h/" + encodeURIComponent(id) + ".pack");
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  },
  async resolve(name) {
    const b = await readFile(new URL(name, bundled)).catch(() => null);
    return b ? { path: name, bytes: new Uint8Array(b) } : null;
  },
  log: (s) => process.stderr.write(s),
  trap: (tid, e) => {
    console.error(`thread ${tid} trapped: ${e}`);
    process.exit(2);
  },
});
core.setIndex(gunzipSync(await readFile("shelf-index.tsv.gz")), await readFile("shelf-release.json"), (await readdir(bundled)).filter((n) => n !== "names.txt"));

const t = new CoreSession(core);
/** Every event, in order, with when it came. */
const seen: { e: any; ms: number }[] = [];
const waiting: { test: (e: any) => boolean; ok: (e: any) => void }[] = [];
t.onEvent((e: any) => {
  seen.push({ e, ms: performance.now() - t0 });
  for (const w of [...waiting]) if (w.test(e)) (waiting.splice(waiting.indexOf(w), 1), w.ok(e));
});
/** The next event `test` takes (within `ms`). */
const next = (test: (e: any) => boolean, what: string, ms = 120_000) =>
  new Promise<any>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`no ${what} in ${ms} ms`)), ms);
    waiting.push({ test, ok: (e) => (clearTimeout(timer), ok(e)) });
  });
let failed = 0;
const check = (ok: boolean, what: string, detail: unknown = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : ` ${JSON.stringify(detail).slice(0, 400)}`}`);
  if (!ok) failed++;
};

let text = await readFile(file, "utf8");
const files: Record<string, string> = { [main]: text };
for (const n of await readdir(dir)) if (n !== main && /\.(tex|sty|cls|bib|cfg)$/.test(n) && dir !== "target/") files[n] = await readFile(dir + n, "utf8");

// (the open: its reply at once, the cold build's pages as `settled`)
const settled = () => next((e) => e.event === "settled", "settled");
let s = settled();
const opened = await t.request({ op: "open", main, files, fuel: 0 });
check(opened.ok, "open answered", opened);
await s;
const build0 = seen.find((x) => x.e.event === "build")?.e ?? (await next((e) => e.event === "build", "build"));
console.log(`${at()}  cold build settled: ${build0.pages} page(s), engine ${build0.wall_ms.toFixed(0)} ms, ok ${build0.ok}`);
check(build0.ok && build0.pages >= 1, "the cold build made pages", build0);

const pages = await t.request({ op: "pages" });
check(pages.ok && pages.json.pages.length === build0.pages, "pages: one hash a page", pages);
const status = await t.request({ op: "status" });
check(status.ok && status.json.pages === build0.pages && status.json.engine === "phitex", "status: the pages, the engine", status);
const o0 = await t.request({ op: "origins", page: 0 });
check(o0.ok && o0.json.g.length > 0 && o0.json.files.includes(main) && o0.json.g.some((g: number[]) => g[2] >= 0 && g[4] > g[3]), `origins of page 0: ${o0.json?.g?.length} glyphs, files ${JSON.stringify(o0.json?.files)}`, o0);
const pdf0 = await t.request({ op: "pdf" });
check(!!pdf0.pdf && new TextDecoder().decode(pdf0.pdf.subarray(0, 5)) === "%PDF-", `pdf: ${pdf0.pdf?.length} bytes`, pdf0.error);
// (a page to draw: the PDF along the first time, its key the next)
const [png0, png1] = [(await t.request({ op: "png", page: 0, dpi: -1 })) as any, (await t.request({ op: "png", page: 0, dpi: -1 })) as any];
check(png0.ok && png0.render?.page === 0 && png0.pdf?.length === pdf0.pdf?.length && png1.ok && !png1.pdf && png1.render?.key === png0.render?.key, `png: render ${JSON.stringify(png0.render)}, the PDF sent once`, [png0, png1]);

// (an edit that makes an error: an undefined control sequence)
const where = text.indexOf("Some text");
const bad = "\\undefinedmacro ";
const utf16 = (s: string, i: number) => s.slice(0, i).length;
let e0 = performance.now();
s = settled();
let diags = next((e) => e.event === "diagnostics", "diagnostics");
const ed = await t.request({ op: "edit", file: main, start: utf16(text, where), end: utf16(text, where), text: bad, page: 0, dpi: -1 });
check(ed.ok, "edit answered", ed);
let d = await diags;
await s;
const errs = d.items.filter((i: any) => i.severity === "error");
console.log(`${at()}  edit (error) settled in ${(performance.now() - e0).toFixed(0)} ms: ${d.items.length} diagnostic(s)`);
check(errs.length > 0 && errs.some((i: any) => /undefined/i.test(i.message)), `the error told: ${errs.map((i: any) => `${i.file}:${i.line}: ${i.message}`).join("; ")}`, d.items);
text = text.slice(0, where) + bad + text.slice(where);

// (the edit undone: the error gone)
e0 = performance.now();
s = settled();
diags = next((e) => e.event === "diagnostics", "diagnostics");
await t.request({ op: "edit", file: main, start: utf16(text, where), end: utf16(text, where + bad.length), text: "", page: 0, dpi: -1 });
d = await diags;
await s;
console.log(`${at()}  edit (fixed) settled in ${(performance.now() - e0).toFixed(0)} ms: ${d.items.length} diagnostic(s)`);
check(!d.items.some((i: any) => i.severity === "error"), "the error cleared", d.items);
text = text.slice(0, where) + text.slice(where + bad.length);

const deltas = seen.filter((x) => x.e.event === "origins");
check(deltas.some((x) => x.e.edits?.length), `origins events with the edits' deltas: ${JSON.stringify(deltas.map((x) => x.e))}`);
const pdf1 = await t.request({ op: "pdf" });
check(!!pdf1.pdf && pdf1.pdf.length === pdf0.pdf?.length && pdf1.pdf.every((b, i) => b === pdf0.pdf![i]), "the PDF after the edit undone is the cold build's", [pdf0.pdf?.length, pdf1.pdf?.length]);

// (the editor's cursor on the word "text": revealed)
const line = text.slice(0, where).split("\n").length - 1;
const col = where - (text.lastIndexOf("\n", where - 1) + 1) + 6;
const rev = next((e) => e.event === "reveal", "reveal", 30_000);
core.push({ ask: "cursor", file: main, line, col });
const r = await rev.catch((e) => e);
check(!(r instanceof Error) && Array.isArray(r.texts) && r.texts.length > 0, `cursor revealed: page ${r?.page}, ${JSON.stringify(r?.texts?.slice(0, 2))}`, String(r));

const count: Record<string, number> = {};
for (const x of seen) count[x.e.event] = (count[x.e.event] ?? 0) + 1;
console.log(`events: ${Object.entries(count).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`order: ${seen.map((x) => x.e.event).join(" ")}`);
console.log(failed ? `${failed} check(s) failed` : "all checks hold");
core.close();
process.exit(failed ? 1 : 0);
