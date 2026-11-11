// The core's threads (wasi-threads): one worker each, every one with the
// same module on the same shared memory. Thread 0 is the host's (core.ts):
// it calls the core's exports and never blocks. A thread the core starts
// (`wasi.thread-spawn`, std's thread::spawn) is a worker of the platform's
// (`Spawn`: a browser's module worker, a Node worker thread) entering
// `wasi_thread_start`; what it tells the host (a file or a pack it lacks, the store's bytes, an event)
// goes to thread 0 on a BroadcastChannel, so no thread needs a port to it,
// and it waits for the answer inside the core (files.rs, store.rs).
//
// Thread 0 starts every worker, also a thread's: a thread's thread-spawn
// takes the new id and asks thread 0 for the worker. A browser starts a
// worker only once its parent returns to its event loop, and a thread that
// starts one usually waits for it inside the core: started there, the two
// would wait for each other for ever.

import { unsigned, wasi } from "./wasi.ts";

/** What a thread's worker is started with (structured-cloneable). */
export interface ThreadData {
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  /** The next thread's id (a shared counter: ids from 1, thread 0 the host's). */
  ids: SharedArrayBuffer;
  /** The BroadcastChannel to thread 0 (one per core). */
  channel: string;
  /** The environment every thread has (`NAME=value`). */
  env: string[];
  tid: number;
  arg: number;
}

/** Starts a worker on `data` that calls `runThread(data)` (thread 0 only). */
export type Spawn = (data: ThreadData) => void;

/** What threads tell thread 0. */
export type ThreadMsg =
  | { t: "spawn"; tid: number; arg: number }
  | { t: "want"; name: string }
  | { t: "fetch"; id: string }
  | { t: "shell"; id: number; frame: Uint8Array }
  | { t: "store_get"; key: string }
  | { t: "store_put"; key: string; bytes: Uint8Array }
  | { t: "event"; json: string }
  | { t: "lsp"; json: string }
  | { t: "log"; s: string }
  | { t: "trap"; tid: number; error: string };

/**
 * The memory's size (core/build.rs, core/src/heap.rs): made at 2 GiB, the
 * module's initial memory; grown on thread 0 before the first thread
 * starts to the largest of SIZE_TRIES the browser gives (chooseSize), then
 * sealed, never grown again: another thread's memory.copy or memory.fill
 * into pages one thread just grew traps in V8. At most 64 KiB short of
 * 4 GiB (the allocator's heap end would wrap to 0). Committed only as it
 * is touched, but Chrome counts a memory's size against its renderer's
 * data limit in full (8 GiB on a Linux machine with 16 GB or less), so a
 * second tab's core, beside a first one's 4 GiB, gets 2.
 */
export const PAGES_INITIAL = 32768;
export const PAGES_MAX = 65535;
/** The sizes asked for, in pages: 4 GiB (less 64 KiB), 3, else the 2 the memory starts with. */
export const SIZE_TRIES = [PAGES_MAX, 49152, PAGES_INITIAL];
/** How far below a try the memory may end and the try count as given (the allocator's sbrk stops a page or two short). */
const SLACK = 4;

export function newMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: PAGES_INITIAL, maximum: PAGES_MAX, shared: true });
}

/**
 * The core's size, chosen once: the first of SIZE_TRIES `grow` reaches
 * (`grow(pages)`: the core's ph_grow, the memory's pages after; a refused
 * growth changes nothing). While `again()` (another core's memory still
 * being freed: a reload's), the largest is asked again every 100 ms before
 * a smaller one is taken.
 */
export async function chooseSize(grow: (pages: number) => number, again: () => boolean = () => false, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<number> {
  for (const [i, p] of SIZE_TRIES.entries()) {
    if (grow(p) >= p - SLACK) return p;
    while (i === 0 && again()) {
      await sleep(100);
      if (grow(p) >= p - SLACK) return p;
    }
  }
  return PAGES_INITIAL;
}

/** `pages` (a SIZE_TRIES size) in GiB as the tab says it: 4, 3, 2. */
export function gib(pages: number): number {
  return Math.round(pages / 16384);
}

/** Whether what the core wrote to stderr says an allocation failed (Rust's "memory allocation of N bytes failed"): its size outgrown. */
export function outgrew(stderr: string): boolean {
  return /memory allocation of \d+ bytes failed/.test(stderr);
}

/** Why the core stopped when the document outgrew its `pages` (`chooseSize`'s): the size it got, and what to close. */
export function outgrownMessage(pages: number): string {
  const n = gib(pages);
  // ("needs more than the N GiB of memory" is what the viewer's session knows these by: it stops, not restarts)
  if (pages >= PAGES_MAX - SLACK) return `This document needs more than the ${n} GiB of memory PhiTeX can use in a browser. Use phitex on your computer for it, or switch to Overleaf's PDF.`;
  return `This document needs more than the ${n} GiB of memory PhiTeX got in this tab. Other Overleaf tabs using PhiTeX are holding the rest. Close them or switch them to Overleaf's PDF, then reload this tab.`;
}

/** The core's imports on any thread: thread 0's `spawn` starts a worker, any other thread's asks thread 0 to. */
export function imports(d: Omit<ThreadData, "tid" | "arg">, spawn: Spawn | null, post: (m: ThreadMsg) => void): WebAssembly.Imports {
  const ids = new Int32Array(d.ids);
  const text = (p: number, n: number) => new TextDecoder().decode(new Uint8Array(d.memory.buffer).slice(p, p + n));
  return {
    env: { memory: d.memory },
    wasi_snapshot_preview1: wasi(d.memory, (s) => post({ t: "log", s }), d.env),
    wasi: {
      "thread-spawn": (arg: number) => {
        const tid = Atomics.add(ids, 0, 1);
        if (spawn) spawn({ ...d, tid, arg });
        else post({ t: "spawn", tid, arg });
        return tid;
      },
    },
    // (pointers and lengths as unsigned: wasi.ts's `unsigned`)
    phitex: {
      want: unsigned((p: number, n: number) => post({ t: "want", name: text(p, n) })),
      fetch: unsigned((p: number, n: number) => post({ t: "fetch", id: text(p, n) })),
      shell: unsigned((id: number, p: number, n: number) => post({ t: "shell", id, frame: new Uint8Array(d.memory.buffer).slice(p, p + n) })),
      store_get: unsigned((p: number, n: number) => post({ t: "store_get", key: text(p, n) })),
      store_put: unsigned((p: number, n: number, b: number, m: number) => post({ t: "store_put", key: text(p, n), bytes: new Uint8Array(d.memory.buffer).slice(b, b + m) })),
      event: unsigned((p: number, n: number) => post({ t: "event", json: text(p, n) })),
      lsp: unsigned((p: number, n: number) => post({ t: "lsp", json: text(p, n) })),
      // (a single-threaded build's turn for the host: the threaded core never calls it, given so it links either way)
      yield: () => {},
    },
  };
}

/** A thread the core started: its instance, entered at `wasi_thread_start`. */
export function runThread(d: ThreadData): void {
  const bc = new BroadcastChannel(d.channel);
  const post = (m: ThreadMsg) => bc.postMessage(m);
  const inst = new WebAssembly.Instance(d.module, imports(d, null, post));
  try {
    (inst.exports.wasi_thread_start as (tid: number, arg: number) => void)(d.tid, d.arg);
  } catch (e) {
    // (a panic aborts: the whole core is gone, thread 0 must hear of it)
    post({ t: "trap", tid: d.tid, error: String((e as Error)?.stack ?? e) });
  } finally {
    bc.close();
  }
}
