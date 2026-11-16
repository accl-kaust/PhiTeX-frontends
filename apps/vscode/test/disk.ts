// The builtin engine and the disk, without VS Code: a project in a
// temporary folder opened on the core as the extension opens it (its files
// given, the document opened through CoreSession), its folder watched (Node's
// recursive fs.watch standing for VS Code's file watcher) into the
// extension's DiskSync (src/project.ts), which gives the core what changed.
// Each change on disk must build again, its PDF changed, and its pages drawn
// as a clean build's of the folder as it is then (a second core's, its
// document opened anew for each):
//   an image saved over in place, the same size, another colour (its new
//   bytes typeset, not a decode kept from before); one replaced by a rename;
//   a .bib edited; an \input file edited outside the editor; one made, then
//   removed; the main file edited.
// And the editor's buffer wins: a file the language client has open (its
// buffer the core's) edited on disk builds nothing, the buffer's text
// stays on the page; closed, the disk's is built. Last, the preview opened
// again on the same core (VS Code's Restart), then an image saved over.
//
//   tools/build/build-vscode.sh && tools/sandbox --net node build/vscode/dist/disk.mjs

import { mkdtempSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { setPlatform } from "../../../common/src/platform.ts";
import { startCore, prefetch } from "../src/core.ts";
import { nodePlatform } from "../src/platform.ts";
import { lspChannel } from "../../../common/src/wasm/host.ts";
import { CoreFiles, DiskSync, walk, BINARY, type Held } from "../src/project.ts";
import { relPath } from "../src/changes.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
setPlatform(nodePlatform(root, mkdtempSync(join(tmpdir(), "phitex-store-"))));

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

/** The figure's versions, by colour. */
const COLOURS: [string, number[]][] = [["red", [220, 30, 30]], ["blue", [30, 30, 220]], ["green", [30, 200, 30]], ["yellow", [200, 200, 30]]];
const colour = (n: string) => png(16, 16, COLOURS.find(([c]) => c === n)![1]);
const folder = mkdtempSync(join(tmpdir(), "phitex-disk-"));
const main = "main.tex";
const MAIN = [
  "\\documentclass{article}",
  "\\usepackage{graphicx}",
  "\\begin{document}",
  "Disk check. \\input{part}",
  "\\IfFileExists{extra.tex}{\\input{extra}}{No extra.}",
  "",
  "\\includegraphics[width=2cm]{fig.png}",
  "",
  "See \\cite{knuth}.",
  "\\bibliographystyle{plain}",
  "\\bibliography{refs}",
  "\\end{document}",
  "",
].join("\n");
const write = (p: string, b: string | Uint8Array) => writeFileSync(join(folder, p), b);
write(main, MAIN);
write("part.tex", "The part as first written.\n");
write("refs.bib", "@book{knuth, author={Donald Knuth}, title={The {\\TeX}book}, year={1984}, publisher={Addison-Wesley}}\n");
write("fig.png", colour("red"));

/** The folder as the extension reads it at an open (loadProject, no editor). */
async function load() {
  const files: Record<string, string> = {};
  const binaries: Record<string, Uint8Array> = {};
  for (const p of await walk(folder)) {
    const r = relPath(folder, p)!;
    if (BINARY.test(p)) binaries[r] = new Uint8Array(readFileSync(p));
    else files[r] = readFileSync(p, "utf8");
  }
  return { files, binaries };
}

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);

/** A core, its builds counted as they settle. */
async function attach(key: string) {
  const c = await startCore(root, () => key, (s) => process.stderr.write(s.endsWith("\n") ? s : s + "\n"));
  const d = { ...c, settled: 0, wake: () => {}, given: new CoreFiles((n, f) => c.core.provide(n, f)) };
  c.session.onEvent((e: any) => e.event === "settled" && (d.settled++, d.wake()));
  return d;
}
type Doc = Awaited<ReturnType<typeof attach>>;
/** `d`'s next build settled after its `n`th (false: none within `limit` ms). */
const settle = (d: Doc, n: number, limit = 60_000) =>
  new Promise<boolean>((ok) => {
    if (d.settled > n) return ok(true);
    const timer = setTimeout(() => ok(false), limit);
    d.wake = () => d.settled > n && (clearTimeout(timer), ok(true));
  });

/** Opens the folder as it is on `d` (as the extension opens it: the binaries given, then the document), its first build settled. */
async function open(d: Doc) {
  const p = await load();
  d.given.open(Object.keys(p.files), p.binaries);
  prefetch(d.core, d.index, p.files, "pdflatex");
  const n = d.settled;
  const r = await d.session.request({ op: "open", main, files: p.files, engine: "pdflatex" } as never);
  if (!r.ok) throw new Error(`open: ${r.error}`);
  if (!(await settle(d, n, 180_000))) throw new Error("the open did not settle");
  return p;
}

/**
 * `d`'s pages as drawn (each page's frame at 1 px/pt, all its strips: their
 * pixels and the text lines): what the preview shows. (The viewer's PDF of
 * an edit carries its update sections, a clean build's none.)
 */
async function drawn(d: Doc): Promise<{ pages: number; bytes: Buffer; text: string[] }> {
  const n = ((await d.session.request({ op: "pages" } as never)) as any).json?.pages?.length ?? 0;
  const parts: Buffer[] = [Buffer.from(`${n} pages`)];
  const text: string[] = [];
  for (let k = 0; k < n; k++) {
    const r = (await d.session.request({ op: "frame_with", page: k, scale: 1, have: [] } as never)) as { ok: boolean; bytes?: Uint8Array };
    if (!r.ok || !r.bytes) throw new Error(`page ${k}: no frame`);
    const len = new DataView(r.bytes.buffer, r.bytes.byteOffset).getUint32(0, true);
    const json = JSON.parse(new TextDecoder().decode(r.bytes.subarray(4, 4 + len)));
    parts.push(Buffer.from(JSON.stringify([json.pw, json.ph, json.text])), Buffer.from(r.bytes.subarray(4 + len)));
    text.push(...(json.text as { text: string }[]).map((l) => l.text));
  }
  return { pages: n, bytes: Buffer.concat(parts), text };
}

const live = await attach(folder);
const ref = await attach(folder + "#clean");
const pdf = () => Buffer.from(live.core.pdf() ?? new Uint8Array());

/**
 * Whether `live`'s pages are a clean build's of the folder as it is now: as
 * many, the same text drawn on them, the figure drawn in the same colour
 * (which version of the image); where not, what differs said. (Not their
 * pixels: the strips an edit draws again differ from a fresh drawing's by a
 * level or so in a few anti-aliased pixels. Nor the page hashes: an edit's
 * pages, an update of the PDF, hash otherwise than a clean build's.)
 */
async function asClean(): Promise<boolean> {
  const colours = (b: Buffer) => COLOURS.filter(([, c]) => b.includes(Buffer.from([...c, 255]))).map(([n]) => n).join(" ") || "none";
  const now = await drawn(live);
  await open(ref);
  const clean = await drawn(ref);
  const lines = now.text.flatMap((l, i) => (l === clean.text[i] ? [] : [`    built: ${l}`, `    clean: ${clean.text[i] ?? ""}`]));
  const [a, b] = [colours(now.bytes), colours(clean.bytes)];
  if (now.pages === clean.pages && !lines.length && now.text.length === clean.text.length && a === b) return true;
  if (now.pages !== clean.pages) console.log(`  built ${now.pages} pages, clean ${clean.pages}`);
  if (lines.length) console.log(`  the text differs:\n${lines.slice(0, 6).join("\n")}`);
  if (a !== b) console.log(`  the figure drawn: built ${a}; clean ${b}`);
  return false;
}

const first = await open(live);
console.log(`opened: ${ms()} ms, PDF ${pdf().length} bytes`);

const holds: Record<string, Held> = {};
const sync = new DiskSync({
  folder,
  main,
  given: { ...first.files, ...first.binaries },
  held: (rel) => holds[rel],
  sink: {
    give: (rel, bytes) => live.given.give(rel, bytes),
    setMain: (text) => void live.session.request({ op: "set_file", file: main, text } as never),
    rebuild: () => void live.session.request({ op: "rebuild" } as never),
  },
  log: (s) => console.log(`  ${s}`),
});
const watcher = watch(folder, { recursive: true }, (_e, name) => name && sync.touched(join(folder, String(name))));

const fails: string[] = [];
const say = (ok: boolean, what: string, how: string) => (console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${how}`), ok || fails.push(what));
/** `change` made on disk: a build must follow, the PDF changed, its pages a clean build's. */
async function step(what: string, change: () => void) {
  const before = pdf();
  const n = live.settled;
  const t = performance.now();
  change();
  const built = await settle(live, n);
  const took = Math.round(performance.now() - t);
  const changed = built && Buffer.compare(before, pdf()) !== 0;
  const exact = await asClean();
  say(built && changed && exact, what, `${built ? `built in ${took} ms` : "NO BUILD"}, PDF ${changed ? "changed" : "UNCHANGED"}, ${exact ? "a clean build's pages" : "NOT a clean build's pages"}`);
  // (a step failed: the preview opened again, as a user would, so the next starts from the folder as it is)
  if (!(built && changed && exact)) await open(live);
}

await step("an image saved over in place (same size, another colour)", () => write("fig.png", colour("blue")));
await step("an \\input file edited outside the editor", () => write("part.tex", "The part as edited on disk.\n"));
await step("the main file edited", () => write(main, MAIN.replace("Disk check.", "Disk check, the main edited.")));
await step("a file made", () => write("extra.tex", "An extra file, made on disk.\n"));
await step("that file removed", () => rmSync(join(folder, "extra.tex")));
await step("the .bib edited (a file BibTeX reads, not TeX)", () => write("refs.bib", "@book{knuth, author={Donald E. Knuth}, title={The {\\TeX}book, edited on disk}, year={1986}, publisher={Addison-Wesley}}\n"));
await step("an image replaced by a rename (its second change)", () => {
  write("fig.png.tmp~", colour("green"));
  renameSync(join(folder, "fig.png.tmp~"), join(folder, "fig.png"));
});

// (the editor's buffer wins: part.tex open in the language client, its buffer typed)
const lsp = lspChannel(live.core, "disk");
let ids = 0;
const answers = new Map<number, (m: any) => void>();
lsp.onMessage((m) => m.id !== undefined && !m.method && answers.get(m.id)?.(m));
const ask = (method: string, params: unknown) =>
  new Promise<any>((ok) => {
    const id = ++ids;
    answers.set(id, ok);
    lsp.send({ jsonrpc: "2.0", id, method, params });
  });
const tell = (method: string, params: unknown) => lsp.send({ jsonrpc: "2.0", method, params });
await ask("initialize", { processId: null, rootUri: "file://" + folder, capabilities: {} });
tell("initialized", {});
const part = { uri: "file://" + join(folder, "part.tex") };
{
  let n = live.settled;
  holds["part.tex"] = "synced";
  tell("textDocument/didOpen", { textDocument: { ...part, languageId: "latex", version: 1, text: "The part as typed in the buffer.\n" } });
  await settle(live, n);
  const typed = pdf();
  n = live.settled;
  write("part.tex", "The part saved by another program.\n");
  const built = await settle(live, n, 3000);
  const kept = Buffer.compare(typed, pdf()) === 0;
  say(!built && kept, "a synced buffer's file edited on disk", `${built ? "BUILT" : "no build"}, the buffer's page ${kept ? "kept" : "NOT KEPT"}`);
  // (the buffer closed: the disk's text, given meanwhile, is the file's)
  n = live.settled;
  holds["part.tex"] = undefined;
  tell("textDocument/didClose", { textDocument: part });
  const closed = await settle(live, n);
  const exact = await asClean();
  say(closed && exact, "that buffer closed", `${closed ? "built" : "NO BUILD"}, ${exact ? "the disk's text (a clean build's pages)" : "NOT a clean build's pages"}`);
}
{
  // (a buffer the core never hears, unsaved: its file on disk ignored)
  holds["refs.bib"] = "unsaved";
  const before = pdf();
  const n = live.settled;
  write("refs.bib", "@book{knuth, author={Nobody}, title={Ignored}, year={2000}, publisher={None}}\n");
  const built = await settle(live, n, 3000);
  const kept = Buffer.compare(before, pdf()) === 0;
  say(!built && kept, "an unsaved buffer's file edited on disk", `${built ? "BUILT" : "no build"}, the page ${kept ? "kept" : "CHANGED"}`);
  holds["refs.bib"] = undefined;
}
await ask("shutdown", null);
tell("exit", null);
lsp.close();

// (the preview opened again on the same core, as Restart does: then an image saved over)
watcher.close();
sync.dispose();
const again = await open(live);
const sync2 = new DiskSync({
  folder,
  main,
  given: { ...again.files, ...again.binaries },
  held: () => undefined,
  sink: {
    give: (rel, bytes) => live.given.give(rel, bytes),
    setMain: (text) => void live.session.request({ op: "set_file", file: main, text } as never),
    rebuild: () => void live.session.request({ op: "rebuild" } as never),
  },
  log: (s) => console.log(`  ${s}`),
});
const watcher2 = watch(folder, { recursive: true }, (_e, name) => name && sync2.touched(join(folder, String(name))));
await step("after the preview opened again, an image saved over", () => write("fig.png", colour("yellow")));
await open(live);
await step("opened again right after an image change, then the image saved over", () => write("fig.png", colour("red")));
watcher2.close();
sync2.dispose();

live.core.end();
ref.core.end();
rmSync(folder, { recursive: true });
console.log(fails.length ? `${fails.length} FAILED: ${fails.join("; ")}` : `all passed (${ms()} ms)`);
process.exit(fails.length ? 1 : 0);
