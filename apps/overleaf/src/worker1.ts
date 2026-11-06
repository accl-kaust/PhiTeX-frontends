// The core in Firefox (common/src/wasm/core.ts's Core.startSingle): the
// single-threaded core (wasm32-wasip1, dist/core1.wasm), since Firefox gives
// an extension's pages no shared memory (Mozilla bug 1673477). One worker
// of the background page (firefox-bg.html) for each tab's port, as
// worker.ts is the offscreen document's in Chrome; a build runs on it to
// its end, the tab's requests answered between the document's steps.
//
// Nothing else runs while the core waits, so what it asks for is answered
// inside its call: the packs a project loads fetched before it opens (as
// worker.ts fetches them ahead), the rest read at once (sync XHR: the
// extension's own packs/ and texmf/, else Shelf, the hosts in the order
// found); the session's store read before the core starts (IndexedDB is
// asynchronous only), its writes kept as they come; minted's runner loaded
// before a project that uses minted opens (only loading Pyodide waits: its
// Python then runs `\write18` at once).

import "./platform.ts";
import { platform } from "./common/platform.ts";
import { Core, CoreSession } from "./common/wasm/core.ts";
import { coreIndex, packsOf, pack } from "./common/wasm/host.ts";
import { order, shipped } from "./common/shelf.ts";
import { putPack } from "./common/packstore.ts";
import { type Runner, runOn, usesMinted } from "./common/wasm/minted.ts";
import { loadMinted } from "./pyodide.ts";

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

/**
 * The formats shipped (formats/names.txt, build.sh: each NAME's
 * NAME.gzdata and NAME.pkgrec.gzdata), as the store's `format/NAME` and
 * `format/NAME/pkgrec`, read before the core starts: without them a first
 * open makes the format here, every language's patterns fetched for it.
 */
async function shippedFormats(): Promise<Map<string, Uint8Array>> {
  const r = await fetch(at("formats/names.txt"));
  if (!r.ok) throw new Error(`formats/names.txt: ${r.status} (scripts/build/build.sh writes it)`);
  const gz = async (p: string) => new Uint8Array(await new Response((await fetch(at(p))).body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  const out = new Map<string, Uint8Array>();
  for (const n of (await r.text()).split("\n").filter(Boolean)) {
    out.set(`format/${n}`, await gz(`formats/${n}.gzdata`));
    out.set(`format/${n}/pkgrec`, await gz(`formats/${n}.pkgrec.gzdata`));
  }
  return out;
}

const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

/** Packs fetched before the core asks (a project's, at its open), by id. */
const ready = new Map<string, Uint8Array>();
/** The store's entries, read before the core starts; the core's writes kept here too. */
let kept = new Map<string, Uint8Array>();
let hosts: string[] = [];
let ours = new Set<string>();
/** The formats the extension ships, gunzipped: a format kept nowhere is read from them (the core's `stored` asks at once). */
let formats = new Map<string, Uint8Array>();
/** minted's runner, loaded at the open of a project that uses it. */
let minted: Promise<Runner> | undefined;
let runner: Runner | undefined;

const module = WebAssembly.compileStreaming(fetch(at("dist/core1.wasm")));
const index = coreIndex();

async function start(): Promise<{ core: Core; session: CoreSession }> {
  const t0 = performance.now();
  [kept, hosts, ours, formats] = await Promise.all([platform().kv.all<Uint8Array>(KV), order(), shipped(), shippedFormats()]);
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
      shell: (command, files) => (runner ? runOn(runner, command, files) : { status: 127 << 8, wrote: [], removed: [] }),
    },
    store: {
      get: async (key) => kept.get(scoped(key)) ?? formats.get(key) ?? null,
      put: (key, bytes) => {
        kept.set(scoped(key), bytes);
        return platform().kv.write([[KV, scoped(key), bytes]]);
      },
    },
    event: post,
    log: (s) => say("error", s),
    // (a build's step trapped: this core is gone, the tab told now (it
    // reopens, which starts a new one); its memory its own, nothing to free)
    trap: (_tid, error) => {
      started = undefined;
      post({ event: "trapped", error: `core trapped (thread 0): ${error.split("\n")[0]}` });
    },
  });
  const ix = await index;
  core.setIndex(ix.tsv, ix.release, ix.table, ix.names);
  say("info", `single-threaded core started in ${Math.round(performance.now() - t0)} ms`);
  // (one thread)
  return { core, session: new CoreSession(core, { shell: true, threads: 1 }) };
}

let started: ReturnType<typeof start> | undefined;

self.onmessage = async (e: MessageEvent<{ id: number; op: string; [k: string]: unknown }>) => {
  const m = e.data;
  try {
    // (another core ended: this one's memory is its own, so nothing waits on it)
    if (m.op === "freeing") return;
    if (m.op === "hello") {
      project = String(m.project ?? "");
      return post({ id: m.id, ok: true });
    }
    // (started after the hello: the store's document keys are the project's)
    const { core, session } = await (started ??= start());
    if (m.op === "binary") {
      core.provide(m.file as string, { path: "./" + m.file, bytes: m.bytes as Uint8Array });
      return post({ id: m.id, ok: true });
    }
    // (the packs the project loads, fetched before it opens: all at once, from this browser or Shelf)
    if (m.op === "open") {
      const ids = packsOf(await index, (m.files ?? {}) as Record<string, string>, String(m.engine ?? "pdflatex"));
      const files = Object.values((m.files ?? {}) as Record<string, string>);
      // (minted's runner too, beside the packs, for a project that uses it)
      if (usesMinted(files)) minted ??= loadMinted();
      await Promise.all([...[...ids].map((id) => pack(id).then((b) => void ready.set(id, b), () => undefined)), minted?.then((r) => void (runner = r), (e) => say("error", `minted: ${e}`))]);
    }
    const r = (await session.request(m as never)) as { bytes?: Uint8Array };
    if (r.bytes) return (self as unknown as Worker).postMessage({ ...r, id: m.id }, [r.bytes.buffer as ArrayBuffer]);
    post({ ...r, id: m.id });
  } catch (err) {
    say("error", `${m.op}: ${String((err as Error)?.stack ?? err)}`);
    post({ id: m.id, ok: false, error: String(err) });
  }
};
