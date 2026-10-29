// The core's thread 0 in the browser (common/src/wasm/core.ts): a module
// worker of the offscreen document, one for each tab's port, so a tab's
// document is its own core (its memory, its threads) and goes with it. A
// dedicated worker, not the offscreen page itself: the core's exports take
// its locks, held briefly by its threads, and a wait (Atomics.wait) is not
// allowed on a window's thread. The core's own threads are this worker's
// nested workers (thread.ts), ended with it.
//
// What the core asks for is answered here, never by waiting: Shelf's packs
// (those the extension ships, packs/; else shelf.ts's packRaw: kept in
// this browser, else fetched from Shelf and kept), the extension's bundled
// texmf/ by name, the session's store (IndexedDB, the document's keys
// under the project's), and `\write18`'s allowed commands (minted, in
// Pyodide, loaded at the first call). The tab's requests (the offscreen
// document relays its port) go to the core's viewer (CoreSession), the
// core's events back to the tab.

import "./platform.ts";
import { platform } from "./common/platform.ts";
import { Core, CoreSession } from "./common/wasm/core.ts";
import { mintedShell } from "./common/wasm/minted.ts";
import { coreIndex, coreStore, pack, prefetch } from "./common/wasm/host.ts";
import { spawnThread } from "./thread.ts";

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

/** The project this tab shows (its path): the document's store keys are its own. */
let project = "";
const store = coreStore(() => project, async () => (await started).core);

const at = (p: string) => platform().assetUrl(p);
const shell = mintedShell(async () => {
  const t0 = performance.now();
  const { loadPyodide } = await import(/* @vite-ignore */ at("dist/pyodide/pyodide.mjs"));
  const { createMintedRunner } = await import(/* @vite-ignore */ at("dist/minted/runner.mjs"));
  const names = (await (await platform().asset("minted/wheels.txt")).text()).split("\n").filter(Boolean);
  // (stdlib and wheels named .data: Edge's store refuses archives in a package)
  const wheels = await Promise.all(names.map(async (n) => [n, new Uint8Array(await (await platform().asset("minted/" + n + ".data")).arrayBuffer())]));
  const r = await createMintedRunner({ loadPyodide, pyodideOptions: { indexURL: at("dist/pyodide/"), stdLibURL: at("dist/pyodide/python_stdlib.data") }, wheels });
  console.info(`[phitex core] minted: Pyodide loaded in ${Math.round(performance.now() - t0)} ms`);
  return r;
});

/** The project's binary files (figures), given again to a core started after a trap. */
const binaries = new Map<string, Uint8Array>();
/** The core's threads' workers: ended with a core that trapped. */
let threads: Worker[] = [];
/** Why the core is gone (a thread trapped): a request then says so, and an open starts a new one. */
let dead: string | undefined;
let stderr = "";

const module = WebAssembly.compileStreaming(fetch(at("dist/core.wasm")));
const index = coreIndex();

async function start(): Promise<{ core: Core; session: CoreSession }> {
  const t0 = performance.now();
  const core = Core.start(await module, {
    spawn: (d) => void threads.push(spawnThread(d)),
    fetch: pack,
    async resolve(name) {
      const r = await platform().asset("texmf/" + name).catch(() => null);
      return r?.ok ? { path: name, bytes: new Uint8Array(await r.arrayBuffer()) } : null;
    },
    store,
    shell,
    event: post,
    log: (s) => {
      stderr = (stderr + s).slice(-4000);
      console.warn("[phitex core]", s);
    },
    trap: (tid, error) => {
      dead = `core trapped (thread ${tid}): ${stderr.split("\n").filter(Boolean).slice(-2).join(" | ") || error.split("\n")[0]}`;
      console.error("[phitex core]", dead, error);
    },
  });
  const ix = await index;
  core.setIndex(ix.tsv, ix.release, ix.table, ix.names);
  for (const [f, b] of binaries) core.provide(f, { path: "./" + f, bytes: b });
  console.info(`[phitex core] started in ${Math.round(performance.now() - t0)} ms`);
  // (every project may use minted: the runner loads only at its first call)
  // (the engine's threads: this machine's cores. wasm has no
  // available_parallelism, so the host says; an idle thread must cost
  // nothing, which is the engine's to keep so: no cap here)
  return { core, session: new CoreSession(core, { shell: true, threads: navigator.hardwareConcurrency || 1 }) };
}

let started = start();

self.onmessage = async (e: MessageEvent<{ id: number; op: string; [k: string]: unknown }>) => {
  const m = e.data;
  try {
    if (m.op === "hello") {
      project = String(m.project ?? "");
      return post({ id: m.id, ok: true });
    }
    if (m.op === "binary") {
      const [file, bytes] = [m.file as string, m.bytes as Uint8Array];
      binaries.set(file, bytes);
      (await started).core.provide(file, { path: "./" + file, bytes });
      return post({ id: m.id, ok: true });
    }
    if (dead) {
      if (m.op !== "open") return post({ id: m.id, ok: false, error: dead });
      // (an open after a trap: a new core, the old one's threads ended)
      for (const w of threads) w.terminate();
      [threads, dead, stderr] = [[], undefined, ""];
      started = start();
    }
    const { core, session } = await started;
    if (m.op === "open") prefetch(core, await index, (m.files ?? {}) as Record<string, string>, String(m.engine ?? "pdflatex"));
    // (the pages are strips: `frame`, `text` and `outline` the core's ops,
    // `strips` their pixels, passed on without a copy)
    const r = (await session.request(m as never)) as { bytes?: Uint8Array };
    if (r.bytes) return (self as unknown as Worker).postMessage({ ...r, id: m.id }, [r.bytes.buffer as ArrayBuffer]);
    post({ ...r, id: m.id });
  } catch (err) {
    post({ id: m.id, ok: false, error: String(err) });
  }
};
