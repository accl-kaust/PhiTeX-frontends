// The core's threads (wasi-threads): one worker each, every one with the
// same module on the same shared memory. Thread 0 is the host's (core.ts):
// it calls the core's exports and never blocks. A thread the core starts
// (`wasi.thread-spawn`, std's thread::spawn) is a worker of the platform's
// (`Spawn`: a browser's module worker, a Node worker thread) entering
// `wasi_thread_start`; what it tells the host (a file or a pack it lacks, an event)
// goes to thread 0 on a BroadcastChannel, so no thread needs a port to it,
// and it waits for the answer inside the core (files.rs).

import { wasi } from "./wasi.ts";

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

/** Starts a worker on `data` that calls `runThread(data, spawn)`. */
export type Spawn = (data: ThreadData) => void;

/** What threads tell thread 0. */
export type ThreadMsg = { t: "want"; name: string } | { t: "fetch"; id: string } | { t: "shell"; id: number; frame: Uint8Array } | { t: "event"; json: string } | { t: "log"; s: string } | { t: "trap"; tid: number; error: string };

/** The memory's limits (core/build.rs: 64 MiB at first, up to 4 GiB). */
export const PAGES_INITIAL = 1024;
export const PAGES_MAX = 65536;

export function newMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: PAGES_INITIAL, maximum: PAGES_MAX, shared: true });
}

/** The core's imports on any thread. */
export function imports(d: Omit<ThreadData, "tid" | "arg">, spawn: Spawn, post: (m: ThreadMsg) => void): WebAssembly.Imports {
  const ids = new Int32Array(d.ids);
  const text = (p: number, n: number) => new TextDecoder().decode(new Uint8Array(d.memory.buffer).slice(p, p + n));
  return {
    env: { memory: d.memory },
    wasi_snapshot_preview1: wasi(d.memory, (s) => post({ t: "log", s }), d.env),
    wasi: {
      "thread-spawn": (arg: number) => {
        const tid = Atomics.add(ids, 0, 1);
        spawn({ ...d, tid, arg });
        return tid;
      },
    },
    phitex: {
      want: (p: number, n: number) => post({ t: "want", name: text(p, n) }),
      fetch: (p: number, n: number) => post({ t: "fetch", id: text(p, n) }),
      shell: (id: number, p: number, n: number) => post({ t: "shell", id, frame: new Uint8Array(d.memory.buffer).slice(p, p + n) }),
      event: (p: number, n: number) => post({ t: "event", json: text(p, n) }),
    },
  };
}

/** A thread the core started: its instance, entered at `wasi_thread_start`. */
export function runThread(d: ThreadData, spawn: Spawn): void {
  const bc = new BroadcastChannel(d.channel);
  const post = (m: ThreadMsg) => bc.postMessage(m);
  const inst = new WebAssembly.Instance(d.module, imports(d, spawn, post));
  try {
    (inst.exports.wasi_thread_start as (tid: number, arg: number) => void)(d.tid, d.arg);
  } catch (e) {
    // (a panic aborts: the whole core is gone, thread 0 must hear of it)
    post({ t: "trap", tid: d.tid, error: String((e as Error)?.stack ?? e) });
  } finally {
    bc.close();
  }
}
