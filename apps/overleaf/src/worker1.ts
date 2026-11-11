// The extension's core, in both browsers (common/src/wasm/core.ts's
// Core.startSingle): the single-threaded core (wasm32-wasip1, dist/core1.wasm).
// Firefox gives an extension's pages no shared memory (Mozilla bug 1673477),
// and in Chromium the threaded core was no faster (a first page 6.3–7.2 s
// against 7.2–8.1 s on test/scenarios/longdoc, a keystroke 34 ms against
// 37): one core, one host. One worker of the engine's
// iframe (engine.ts, which starts this bundled, dist/engine-worker.js) for each tab, its core; a build runs
// on it to its end, the tab's requests answered between the document's steps.
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
import { coreIndex, packsOf, pack } from "./common/wasm/host.ts";
import { order, shipped } from "./common/shelf.ts";
import { hasPack, putPack } from "./common/packstore.ts";
import { type Runner, runOn, usesMinted } from "./common/wasm/minted.ts";
import { loadMinted } from "./pyodide.ts";
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
const scoped = (key: string) => (key.startsWith("doc/") ? `doc/${project}/${key.slice(4)}` : key);

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

/** Packs fetched before the core asks (a project's, at its open), by id. */
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

async function start(): Promise<{ core: Core; session: CoreSession }> {
  const t0 = performance.now();
  [kept, hosts, ours, names] = await Promise.all([platform().kv.all<Uint8Array>(KV), order(), shipped(), shippedNames()]);
  const core = Core.startSingle(await module, {
    sync: {
      resolve: (name) => {
        const bytes = readNow(at("texmf/" + name));
        return bytes ? { path: name, bytes } : null;
      },
      fetch: (id, downloading) => {
        const early = ready.get(id);
        if (early) return (ready.delete(id), early);
        if (ours.has(id)) return readNow(at(`packs/${id}.pack`));
        downloading?.();
        for (const h of hosts) {
          const raw = readNow(`${h}h/${encodeURIComponent(id)}.pack`);
          // (kept for the next session; the core checks it against the release's pack table)
          if (raw && isGzip(raw)) return (void putPack(id, raw).catch(() => undefined), raw);
        }
        return null;
      },
      stored: (key) => kept.get(scoped(key)) ?? formats.get(key) ?? null,
      // (refused, as "not found", until minted's runner is loaded)
      shell: (command, files) => (runner ? runOn(runner, command, files) : { status: 127 << 8, wrote: [], removed: [], why: mintedFailed ? `minted's runner failed to load: ${mintedFailed}` : "minted's runner is not loaded (the project did not load minted when it opened)" }),
    },
    store: {
      get: async (key) => kept.get(scoped(key)) ?? formats.get(key) ?? null,
      put: (key, bytes) => {
        kept.set(scoped(key), bytes);
        return platform().kv.write([[KV, scoped(key), bytes]]);
      },
    },
    // (the core about to abort says why first (`lost`: out of memory, a panic): the tab told that, not the trap after it)
    event: (e: { event?: string; why?: string; message?: string }) => (e.event === "lost" ? gone(lostReason(e)) : post(e)),
    log: (s) => {
      stderr = (stderr + s).slice(-4000);
      say("error", s);
    },
    // (a build's step trapped: this core is gone, the tab told now (it
    // reopens, which starts a new one); its memory its own, nothing to free.
    // An allocation refused just before (Rust's "memory allocation of N bytes
    // failed": no `lost` from this core then) is the document outgrowing the
    // most memory a wasm32 core has: said so, and the tab does not reopen)
    trap: (_tid, error) => gone(`core trapped (thread 0): ${outgrew(stderr) ? outgrownMessage(PAGES_MAX) : error.split("\n")[0]}`),
  });
  const ix = await index;
  core.setIndex(ix.tsv, ix.release, ix.table, ix.names);
  for (const [f, b] of binaries) core.provide(f, { path: "./" + f, bytes: b });
  say("info", `single-threaded core started in ${Math.round(performance.now() - t0)} ms`);
  // (one thread)
  return { core, session: new CoreSession(core, { shell: true, threads: 1 }) };
}

let started: ReturnType<typeof start> | undefined;
/**
 * Why the core is gone (it trapped, or said it was lost): every request
 * answers with it (the tab's session reopens once on "core trapped", or
 * stops on a document that outgrew the memory), and only an open starts a
 * new core. Before, the next request of any kind started one, which had
 * no document: "no document open", and the tab never heard why.
 */
let dead: string | undefined;
/** What the core wrote last (its stderr): an allocation refused before a trap. */
let stderr = "";
function gone(why: string): void {
  if (dead) return;
  dead = why;
  started = undefined;
  say("error", why);
  post({ event: "trapped", error: why });
}

self.onmessage = async (e: MessageEvent<{ id: number; op: string; [k: string]: unknown }>) => {
  const m = e.data;
  try {
    // (another core ended: this one's memory is its own, so nothing waits on it)
    if (m.op === "freeing") return;
    if (m.op === "hello") {
      project = String(m.project ?? "");
      // (the core started now, after the hello (the store's document keys are
      // the project's): its start, the store read and the formats unpacked, runs
      // while the tab downloads the project, not after it, at its first figure)
      started ??= start();
      started.catch(() => undefined);
      return post({ id: m.id, ok: true });
    }
    // (a figure: kept, and given to the core if it is up; never waited on, the start may still be running)
    if (m.op === "binary") {
      const [file, bytes] = [m.file as string, m.bytes as Uint8Array];
      binaries.set(file, bytes);
      if (started) void started.then(({ core }) => core.provide(file, { path: "./" + file, bytes }), () => undefined);
      return post({ id: m.id, ok: true });
    }
    if (dead) {
      if (m.op !== "open") return post({ id: m.id, ok: false, error: dead });
      [dead, stderr] = [undefined, ""];
    }
    const { core, session } = await (started ??= start());
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
      const files = Object.values((m.files ?? {}) as Record<string, string>);
      // (minted's runner too, beside the packs, for a project that uses it)
      if (usesMinted(files)) minted ??= loadMinted({ loadPyodide, createPyodideModule, createMintedRunner });
      // (a pack that goes to Shelf said as the core's own fetches are: the tab counts it, Downloads; one kept here, not)
      const early = (id: string) => {
        let told = false;
        return pack(id, () => ((told = true), post({ event: "pack", id, state: "fetching" }))).then(
          (b) => (ready.set(id, b), told && post({ event: "pack", id, state: "done", bytes: b.length })),
          () => told && post({ event: "pack", id, state: "failed" }),
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
