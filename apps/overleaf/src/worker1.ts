// The extension's core, in both browsers (common/src/wasm/core.ts's
// Core.startSingle): the single-threaded core (wasm32-wasip1, dist/core1.wasm).
// Firefox gives an extension's pages no shared memory (Mozilla bug 1673477),
// and in Chromium the threaded core was no faster (a first page 6.3–7.2 s
// against 7.2–8.1 s on test/scenarios/longdoc, a keystroke 34 ms against
// 37): one core, one host. One worker of the engine's
// iframe (engine.ts, which starts this bundled, dist/engine-worker.js) for each tab, its core; a build runs
// on it to its end, the tab's requests answered between the document's steps.
// A compare's marked-up document (`doc: "diff"` on its requests, its events
// told with it) is a second instance of the same compiled core on this same
// worker: the format unpacked, the store read, Shelf's index and the packs
// the editor's build had are this worker's and shared, not fetched again;
// its first build starts from the editor's persisted graph (the editor's
// main file, its job), an edit of the editor's build, as `phitex watch`'s
// Compare forks the document's session (crates/cli/src/compare.rs).
//
// Nothing else runs while the core waits, so what it asks for is answered
// inside its call: the packs a project loads fetched before it opens, the rest read at once (sync XHR: the
// extension's own packs/ and texmf/, else Shelf, the hosts in the order
// found); the session's store read before the core starts (IndexedDB is
// asynchronous only), its writes kept as they come; minted's runner loaded
// before a project that uses minted opens (only loading Pyodide waits: its
// Python then runs `\write18` at once).

import "./platform.ts";
import { platform } from "./common/platform.ts";
import { Core, CoreSession, engineFor, lostReason } from "./common/wasm/core.ts";
import { PAGES_MAX, outgrew, outgrownMessage } from "./common/wasm/threads.ts";
import { coreIndex, diffPacksOf, keepDiffPacks, packsOf, pack } from "./common/wasm/host.ts";
import { order, shipped } from "./common/shelf.ts";
import { hasPack, putPack } from "./common/packstore.ts";
import { type Runner, runOn, usesMinted } from "./common/wasm/minted.ts";
import { loadMinted } from "./pyodide.ts";
import { BROWSER_CAP, graphsOn, kvGraphs } from "./common/wasm/graphs.ts";
// (minted's modules bundled in: this worker can import nothing at run time, pyodide.ts)
import { loadPyodide } from "pyodide";
import createPyodideModule from "pyodide/pyodide.asm.mjs";
import { createMintedRunner } from "phitex-minted-runner";

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
/** Said to the tab (its console; a dev trace on the mock). */
const say = (kind: "info" | "error", text: string) => post({ event: "console", item: { kind, text } });
const at = (p: string) => platform().assetUrl(p);

/** The store's namespace (host.ts's coreStore) and this tab's project, its document's keys under it. */
const KV = "core.kv";
let project = "";
/** The store's key for document `doc`'s core (the editor's: ""): a compare's own records apart from the editor's, under the same project. */
const scoped = (key: string, doc = "") => (key.startsWith("doc/") ? `doc/${project}${doc ? `~${doc}` : ""}/${key.slice(4)}` : key);
/** What document `doc`'s core reads under `key`: its own, else (a compare's) the editor's, else the shipped formats'. */
const storedFor = (doc: string, key: string) => kept.get(scoped(key, doc)) ?? (doc ? kept.get(scoped(key)) : undefined) ?? formats.get(key) ?? null;

/** `url`'s bytes, at once (a worker may read synchronously); null: not there. */
function readNow(url: string): Uint8Array | null {
  const x = new XMLHttpRequest();
  x.open("GET", url, false);
  x.responseType = "arraybuffer";
  try {
    x.send();
  } catch {
    return null;
  }
  return x.status === 200 && x.response ? new Uint8Array(x.response as ArrayBuffer) : null;
}

/** The formats shipped (formats/names.txt, build.sh), by name: read at the start, each unpacked only at its engine's first open (formatsFor). */
async function shippedNames(): Promise<string[]> {
  const r = await fetch(at("formats/names.txt"));
  if (!r.ok) throw new Error(`formats/names.txt: ${r.status} (tools/build/build.sh writes it)`);
  return (await r.text()).split("\n").filter(Boolean);
}
let names: string[] = [];

/**
 * `engine`'s shipped formats (NAME.gzdata, its names starting with the
 * engine's), gunzipped into `formats` as the store's `format/NAME`, before
 * its first open asks for them (the core's `stored` answers at once):
 * without them that open makes the format here, every language's patterns
 * fetched for it. Only the engine opened: four formats (XeTeX's alone
 * 12 MB packed) unpacked in every tab's engine was memory few documents use.
 */
async function formatsFor(engine: string): Promise<void> {
  const gz = async (p: string) => new Uint8Array(await new Response((await fetch(at(p))).body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  for (const n of names.filter((n) => n.startsWith(`${engine}-`) && !formats.has(`format/${n}`))) formats.set(`format/${n}`, await gz(`formats/${n}.gzdata`));
}

/** The packs a warm build on `engine`'s shipped formats reads (formats/NAME.packs.txt), by id. */
async function formatPacks(engine: string): Promise<string[]> {
  const names = (await (await fetch(at("formats/names.txt"))).text()).split("\n").filter((n) => n.startsWith(`${engine}-`));
  const lists = await Promise.all(names.map((n) => fetch(at(`formats/${n}.packs.txt`)).then((r) => (r.ok ? r.text() : ""), () => "")));
  return lists.flatMap((t) => t.split("\n").filter(Boolean));
}

const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

/**
 * The packs this worker has (as Shelf serves them, gzip), by id: fetched
 * before a core asks (a project's, at its open), or given to one of its
 * cores; every core here reads them from here (a compare's build gets the
 * editor's packs without a fetch).
 */
const ready = new Map<string, Uint8Array>();
/** The store's entries, read before the core starts; the core's writes kept here too. */
let kept = new Map<string, Uint8Array>();
let hosts: string[] = [];
let ours = new Set<string>();
/** The formats the extension ships, gunzipped, those of the engines opened so far: a format kept nowhere is read from them (the core's `stored` asks at once). */
const formats = new Map<string, Uint8Array>();
/** minted's runner, loaded at the open of a project that uses it. */
let minted: Promise<Runner> | undefined;
let runner: Runner | undefined;
/** Why it did not load, if it failed (said in each `\write18`'s answer). */
let mintedFailed = "";
/** The project's binary files (figures), kept until the core starts and given to it then. */
const binaries = new Map<string, Uint8Array>();

const module = WebAssembly.compileStreaming(fetch(at("dist/core1.wasm")));
const index = coreIndex();

/** The store read, Shelf's hosts ordered, the shipped packs and formats listed: once, for every core here. */
let shared: Promise<void> | undefined;

/** The editor's persisted graph as its core last saved it here (a compare's first build starts from it), and the document's name. */
let editorGraph: { doc: string; bytes: Uint8Array } | undefined;
const editorGraphs = kvGraphs(platform().kv, () => project, BROWSER_CAP, async () => await graphsOn(platform().kv));

/** Document `doc`'s core (the editor's: ""; a compare's marked-up document's: "diff"). */
async function start(doc: string): Promise<{ core: Core; session: CoreSession }> {
  const t0 = performance.now();
  await (shared ??= Promise.all([platform().kv.all<Uint8Array>(KV), order(), shipped(), shippedNames()]).then((r) => void ([kept, hosts, ours, names] = r)));
  const tag = <T extends object>(e: T) => (doc ? { ...e, doc } : e);
  const core = Core.startSingle(await module, {
    sync: {
      resolve: (name) => {
        const bytes = readNow(at("texmf/" + name));
        return bytes ? { path: name, bytes } : null;
      },
      fetch: (id, downloading) => {
        const here = ready.get(id);
        if (here) return here;
        const keep = (b: Uint8Array | null) => (b && ready.set(id, b), b);
        if (ours.has(id)) return keep(readNow(at(`packs/${id}.pack`)));
        downloading?.();
        for (const h of hosts) {
          const raw = readNow(`${h}h/${encodeURIComponent(id)}.pack`);
          // (kept for the next session; the core checks it against the release's pack table)
          if (raw && isGzip(raw)) return (void putPack(id, raw).catch(() => undefined), keep(raw));
        }
        return null;
      },
      stored: (key) => storedFor(doc, key),
      // (refused, as "not found", until minted's runner is loaded)
      shell: (command, files) => (runner ? runOn(runner, command, files) : { status: 127 << 8, wrote: [], removed: [], why: mintedFailed ? `minted's runner failed to load: ${mintedFailed}` : "minted's runner is not loaded (the project did not load minted when it opened)" }),
    },
    store: {
      get: async (key) => storedFor(doc, key),
      put: (key, bytes) => {
        kept.set(scoped(key, doc), bytes);
        return platform().kv.write([[KV, scoped(key, doc), bytes]]);
      },
    },
    // (each document's persisted graph, in this browser's IndexedDB under the project's name: at most BROWSER_CAP;
    // the editor's last one kept here too. A compare's core is given the editor's, opened as the editor's main
    // file: its first build an edit of the editor's build. It saves none: its graph is not the document's)
    graphs: doc
      ? { on: async () => true, get: async (d) => (editorGraph?.doc === d ? editorGraph.bytes : await editorGraphs.get(d).catch(() => null)), put: async () => {}, drop: async () => {} }
      : { ...editorGraphs, put: (d, bytes) => ((editorGraph = { doc: d, bytes }), editorGraphs.put(d, bytes)), drop: (d) => ((editorGraph = undefined), editorGraphs.drop(d)) },
    // (the core about to abort says why first (`lost`: out of memory, a panic): the tab told that, not the trap after it)
    event: (e: { event?: string; why?: string; message?: string; notes?: string[] }) => {
      // (the persisted graph: loaded, saved, or why not, said to the tab as `phitex -v` says it)
      if (e.event === "graph") for (const n of e.notes ?? []) say("info", `${doc ? `${doc}: ` : ""}${n}`);
      return e.event === "lost" ? gone(doc, lostReason(e)) : post(tag(e));
    },
    log: (s) => {
      stderr.set(doc, ((stderr.get(doc) ?? "") + s).slice(-4000));
      say("error", s);
    },
    // (a build's step trapped: this core is gone, the tab told now (it
    // reopens, which starts a new one); its memory its own, nothing to free.
    // An allocation refused just before (Rust's "memory allocation of N bytes
    // failed": no `lost` from this core then) is the document outgrowing the
    // most memory a wasm32 core has: said so, and the tab does not reopen)
    trap: (_tid, error) => gone(doc, `core trapped (thread 0): ${outgrew(stderr.get(doc) ?? "") ? outgrownMessage(PAGES_MAX) : error.split("\n")[0]}`),
  });
  const ix = await index;
  core.setIndex(ix.tsv, ix.release, ix.table, ix.names);
  for (const [f, b] of binaries) core.provide(f, { path: "./" + f, bytes: b });
  say("info", `single-threaded core${doc ? ` (${doc})` : ""} started in ${Math.round(performance.now() - t0)} ms`);
  // (one thread)
  return { core, session: new CoreSession(core, { shell: true, threads: 1 }) };
}

/** The documents' cores started, by document ("": the editor's). */
const docs = new Map<string, ReturnType<typeof start>>();
/** Each core started, as it is when up. */
const cores = () => [...docs.values()].map((p) => p.then(({ core }) => core, () => null));
/**
 * Why the core is gone (it trapped, or said it was lost): every request
 * answers with it (the tab's session reopens once on "core trapped", or
 * stops on a document that outgrew the memory), and only an open starts a
 * new core. Before, the next request of any kind started one, which had
 * no document: "no document open", and the tab never heard why.
 */
const dead = new Map<string, string>();
/** What each core wrote last (its stderr): an allocation refused before a trap. */
const stderr = new Map<string, string>();
function gone(doc: string, why: string): void {
  if (dead.has(doc)) return;
  dead.set(doc, why);
  docs.delete(doc);
  say("error", why);
  post(doc ? { event: "trapped", error: why, doc } : { event: "trapped", error: why });
}

self.onmessage = async (e: MessageEvent<{ id: number; op: string; doc?: string; [k: string]: unknown }>) => {
  const m = e.data;
  // (whose: the editor's document, or a compare's marked-up one, `doc` on its requests)
  const doc = typeof m.doc === "string" ? m.doc : "";
  delete m.doc;
  const tag = <T extends object>(e: T) => (doc ? { ...e, doc } : e);
  try {
    // (another core ended: this one's memory is its own, so nothing waits on it)
    if (m.op === "freeing") return;
    if (m.op === "hello") {
      const next = String(m.project ?? "");
      // (another project on this core: the last one's figures withdrawn, as worker.ts)
      if (next !== project && binaries.size) {
        const gone = [...binaries.keys()];
        binaries.clear();
        for (const c of cores()) void c.then((core) => core && gone.forEach((f) => core.withdraw(f)));
      }
      if (next !== project) editorGraph = undefined;
      project = next;
      // (the core started now, after the hello (the store's document keys are
      // the project's): its start, the store read and the formats unpacked, runs
      // while the tab downloads the project, not after it, at its first figure)
      if (!docs.has("")) docs.set("", start(""));
      docs.get("")!.catch(() => undefined);
      // (a compare's packs kept on this machine, should the background not have kept them yet)
      void index.then((ix) => keepDiffPacks(ix)).catch(() => undefined);
      return post({ id: m.id, ok: true });
    }
    // (a figure: kept, and given to every core up; never waited on, a start may still be running)
    if (m.op === "binary") {
      const [file, bytes] = [m.file as string, m.bytes as Uint8Array];
      binaries.set(file, bytes);
      for (const c of cores()) void c.then((core) => core?.provide(file, { path: "./" + file, bytes }));
      return post({ id: m.id, ok: true });
    }
    // (a figure deleted or renamed: withdrawn, as worker.ts)
    if (m.op === "withdraw") {
      const file = m.file as string;
      binaries.delete(file);
      for (const c of cores()) void c.then((core) => core?.withdraw(file));
      return post({ id: m.id, ok: true });
    }
    // (a compare stopped: its core ended, its memory let go; the editor's stays)
    if (m.op === "close") {
      const c = docs.get(doc);
      if (doc) docs.delete(doc);
      if (doc && c) await c.then(({ core }) => core.end(), () => undefined);
      return post({ id: m.id, ok: true });
    }
    if (dead.has(doc)) {
      if (m.op !== "open") return post({ id: m.id, ok: false, error: dead.get(doc) });
      dead.delete(doc);
      stderr.delete(doc);
    }
    if (!docs.has(doc)) docs.set(doc, start(doc));
    const { session } = await docs.get(doc)!;
    // (the packs the project loads, fetched before it opens: all at once, from this browser or Shelf)
    if (m.op === "open") {
      // (the engine the core is opened with: a plain document's plain one, as CoreSession decides)
      const engine = engineFor(((m.files ?? {}) as Record<string, string>)[String(m.main)] ?? "", String(m.engine ?? "pdflatex")) ?? "pdflatex";
      // (its shipped format unpacked now, while the packs below are fetched: the core asks for it as the open starts)
      const unpacked = formatsFor(engine);
      const ids = packsOf(await index, (m.files ?? {}) as Record<string, string>, engine);
      // (and those of the packs a warm build on the engine's shipped format
      // reads (make-formats.sh's formats/NAME.packs.txt) kept in this browser:
      // asked inside the build, a pack comes from Shelf at once, never from
      // the copies here (IndexedDB is asynchronous only). One not kept is
      // fetched only if the build asks for it: the list is the format's
      // sample's, more than a document may need)
      for (const id of await formatPacks(engine)) if (await hasPack(id).catch(() => false)) ids.add(id);
      // (and, for every document, the packs a compare's markup may load (changebar's bars,
      // the fonts of its marks, diffPacks): kept in this browser since the extension's
      // start (background.ts), read from it now, so a diff's build asks the network nothing)
      for (const id of diffPacksOf(await index, engine)) if (await hasPack(id).catch(() => false)) ids.add(id);
      const files = Object.values((m.files ?? {}) as Record<string, string>);
      // (minted's runner too, beside the packs, for a project that uses it)
      if (usesMinted(files)) minted ??= loadMinted({ loadPyodide, createPyodideModule, createMintedRunner });
      // (a pack that goes to Shelf said as the core's own fetches are: the tab counts it, Downloads; one kept
      // here, not; one this worker has already (the editor's, for a compare's core), not read again)
      const early = (id: string) => {
        if (ready.has(id)) return;
        let told = false;
        return pack(id, () => ((told = true), post(tag({ event: "pack", id, state: "fetching" })))).then(
          (b) => (ready.set(id, b), told && post(tag({ event: "pack", id, state: "done", bytes: b.length }))),
          () => told && post(tag({ event: "pack", id, state: "failed" })),
        );
      };
      // (the figures' paths too, for a latexmkrc's TEXINPUTS folders: the tab sends the texts')
      if (Array.isArray(m.projectFiles)) m.projectFiles = [...new Set([...(m.projectFiles as string[]), ...binaries.keys()])];
      await Promise.all([unpacked, ...[...ids].map(early), minted?.then((r) => void (runner = r), (e) => (say("error", `minted: ${e}`), (mintedFailed = String(e))))]);
    }
    const r = (await session.request(m as never)) as { bytes?: Uint8Array };
    if (r.bytes) return (self as unknown as Worker).postMessage({ ...r, id: m.id }, [r.bytes.buffer as ArrayBuffer]);
    post({ ...r, id: m.id });
  } catch (err) {
    say("error", `${m.op}: ${String((err as Error)?.stack ?? err)}`);
    post({ id: m.id, ok: false, error: String(err) });
  }
};
