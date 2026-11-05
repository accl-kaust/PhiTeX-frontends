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
import { Core, CoreSession, WASM_THREADS } from "./common/wasm/core.ts";
import { mintedShell } from "./common/wasm/minted.ts";
import { loadMinted } from "./pyodide.ts";
import { coreIndex, coreStore, pack, prefetch, texmfFile, warmDiff, warmFormats } from "./common/wasm/host.ts";
import { spawnThread } from "./thread.ts";
import { gib, outgrew, outgrownMessage } from "./common/wasm/threads.ts";
import { order } from "./common/shelf.ts";

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

/** The project this tab shows (its path): the document's store keys are its own. */
let project = "";
const store = coreStore(() => project, async () => (await running()).core);

const at = (p: string) => platform().assetUrl(p);
const shell = mintedShell(loadMinted);

/** The project's binary files (figures), given again to a core started after a trap. */
const binaries = new Map<string, Uint8Array>();
/** The core's threads' workers: ended with a core that trapped. */
let threads: Worker[] = [];
/** Why the core is gone (a thread trapped): a request then says so, and an open starts a new one. */
let dead: string | undefined;
let stderr = "";
/** A compare's packs kept ahead (warmDiff): asked at the first open, done at its first build. */
let diffWarm: false | "asked" | "done" = false;

const module = WebAssembly.compileStreaming(fetch(at("dist/core.wasm")));
const index = coreIndex();
// (the shipped formats and a first build's texmf/ files on their way while the core compiles: the web frontend's; the extension's are local)
warmFormats().catch((e: unknown) => console.warn("[phitex core] fetching ahead:", e));
// (which Shelf host answers first, found while the core compiles: its first pack waits for none)
void order();

async function start(): Promise<{ core: Core; session: CoreSession }> {
  for (;;) {
    try {
      return await startCore();
    } catch (e) {
      const memory = e instanceof RangeError && /allocate memory/.test(e.message);
      // (a core the offscreen document just ended still holds its 4 GiB:
      // Chrome frees a terminated worker's memory a moment later, and says
      // nothing when it has; so while one is being freed, the start waits
      // for it, and only then is a refusal this core's own)
      if (memory && performance.now() - freeing < FREEING_MS) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      // (said here: a request then fails with it, but the console says it at once, where a check reads it)
      console.error("[phitex core] not started:", String(e));
      // (the next request starts it again)
      started = undefined;
      // (the message as it is, the panel's card: no "Error: " before it)
      throw memory ? NO_MEMORY : e;
    }
  }
}

/** When the offscreen document last ended another core (op "freeing"), on this worker's clock. */
let freeing = -Infinity;
/** How long after that its memory may still be held: a reload's was freed 0.4 s after its core was ended (Chrome 156, a 16 GB machine). */
const FREEING_MS = 5000;

/**
 * Why a core's memory was refused, as the tab shows it: Chrome gives the
 * extension's page on a machine with 16 GB of memory or less 8 GiB of data
 * in all; a first tab's core takes 4 GiB and a second's 2 (core/build.rs,
 * threads.ts chooseSize), so a third Overleaf tab showing PhiTeX does not
 * fit beside them.
 */
const NO_MEMORY =
  "Chrome refused the 2 GiB of memory PhiTeX's engine needs at least, most likely because other Overleaf tabs showing PhiTeX hold the rest of what Chrome allows the extension (8 GiB in all on a Linux computer with 16 GB of memory or less). Close one of them, or switch it to Overleaf's own PDF, then reload this one.";

/** The core's size (pages), once started: what a document that outgrows it is told it had. */
let pages = 0;

/**
 * Why the core stopped (thread `tid` trapped), from what it wrote: an
 * allocation refused is the document outgrowing the size this tab's core
 * got. "core trapped" first: the tab's session says it (and opens once
 * more, viewer/session.ts), where a failed status would be silent.
 */
const why = (tid: number, error: string) =>
  `core trapped (thread ${tid}): ${pages && outgrew(stderr) ? outgrownMessage(pages) : stderr.split("\n").filter(Boolean).slice(-2).join(" | ") || error.split("\n")[0]}`;

async function startCore(): Promise<{ core: Core; session: CoreSession }> {
  const t0 = performance.now();
  const core = await Core.start(await module, {
    spawn: (d) => void threads.push(spawnThread(d)),
    fetch: pack,
    resolve: texmfFile,
    store,
    shell,
    event: post,
    log: (s) => {
      stderr = (stderr + s).slice(-4000);
      console.warn("[phitex core]", s);
    },
    trap: (tid, error) => {
      // (the first trap: the tab told now. A thread's trap mid-build has no
      // request waiting on it, so a cold build that outgrew its core was
      // said only at the tab's next request, which never came)
      const first = !dead;
      dead ??= why(tid, error);
      console.error("[phitex core]", dead, error);
      if (first) post({ event: "trapped", error: dead });
    },
    // (a reload's core starts while the old page's still holds its 4 GiB:
    // the 4 asked again until that is freed, not 2 taken for good)
    again: () => performance.now() - freeing < FREEING_MS,
  });
  pages = core.pages;
  console.info(`[phitex core] memory: ${gib(pages)} GiB`);
  // (the offscreen document keeps each tab's, for the checks: scripts/dev/mock-run.mjs)
  post({ event: "memory", gib: gib(pages) });
  const ix = await index;
  core.setIndex(ix.tsv, ix.release, ix.table, ix.names);
  for (const [f, b] of binaries) core.provide(f, { path: "./" + f, bytes: b });
  console.info(`[phitex core] started in ${Math.round(performance.now() - t0)} ms`);
  // (every project may use minted: the runner loads only at its first call)
  // (the engine's threads: this machine's cores, at most WASM_THREADS.
  // wasm has no available_parallelism, so the host says)
  return { core, session: new CoreSession(core, { shell: true, threads: Math.min(navigator.hardwareConcurrency || 1, WASM_THREADS) }) };
}

/** The core, started at the first request that needs it (an open), not when this worker loads: a reloaded page's core then starts after the old page's has ended (offscreen.ts). */
let started: ReturnType<typeof start> | undefined;
const running = () => (started ??= start());

self.onmessage = async (e: MessageEvent<{ id: number; op: string; [k: string]: unknown }>) => {
  const m = e.data;
  try {
    if (m.op === "freeing") {
      freeing = performance.now() - Number(m.ago ?? 0);
      return;
    }
    if (m.op === "hello") {
      project = String(m.project ?? "");
      return post({ id: m.id, ok: true });
    }
    if (m.op === "binary") {
      const [file, bytes] = [m.file as string, m.bytes as Uint8Array];
      binaries.set(file, bytes);
      // (a core not started yet is given them when it starts)
      if (started) (await started).core.provide(file, { path: "./" + file, bytes });
      return post({ id: m.id, ok: true });
    }
    if (dead) {
      if (m.op !== "open") return post({ id: m.id, ok: false, error: dead });
      // (an open after a trap: a new core, the old one's threads ended)
      for (const w of threads) w.terminate();
      [threads, dead, stderr] = [[], undefined, ""];
      started = undefined;
    }
    const { core, session } = await running();
    if (m.op === "open") prefetch(core, await index, (m.files ?? {}) as Record<string, string>, String(m.engine ?? "pdflatex"));
    // (a compare's packs kept ahead, once, when the first build is in: its own packs first)
    if (m.op === "open" && !diffWarm) {
      diffWarm = "asked";
      const [ix, engine] = [await index, String(m.engine ?? "pdflatex")];
      core.onEvent((e: { event?: string }) => void (e.event === "settled" && diffWarm === "asked" && ((diffWarm = "done"), warmDiff(ix, engine))));
    }
    // (the pages are strips: `frame`, `text` and `outline` the core's ops,
    // `strips` their pixels, passed on without a copy)
    const r = (await session.request(m as never)) as { bytes?: Uint8Array };
    if (r.bytes) return (self as unknown as Worker).postMessage({ ...r, id: m.id }, [r.bytes.buffer as ArrayBuffer]);
    post({ ...r, id: m.id });
  } catch (err) {
    // (thread 0's own allocation refused: the core is gone, as a thread's trap)
    if (pages && outgrew(stderr)) dead = why(0, String(err));
    post({ id: m.id, ok: false, error: dead ?? String(err) });
  }
};
