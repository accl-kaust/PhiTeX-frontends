// A thread of the core (common/src/wasm/threads.ts) as a Node worker
// thread: this file is both the spawner, imported by whoever runs thread 0
// (which starts every thread's worker), and the thread's own entry, when a
// worker is started on it with a thread's data. A thread's worker ends by
// itself once its thread returns (the core's end, Core.end, returns them
// all): nothing of it is left to keep the process alive.

import { Worker, workerData } from "node:worker_threads";
import { runThread, type Spawn, type ThreadData } from "../../../common/src/wasm/threads.ts";

/** The threads' workers started here that have not exited yet (any core's). */
const live = new Set<Worker>();

/** Told when the last live worker exits. */
const none: (() => void)[] = [];

/** How many threads' workers started here have not exited yet: none once every core started here has ended. */
export function liveWorkers(): number {
  return live.size;
}

/** Resolved once no thread's worker started here is left (a core's end returns its threads; their workers then exit). */
export function workersGone(): Promise<void> {
  return live.size ? new Promise((ok) => none.push(ok)) : Promise.resolve();
}

/** Starts the core's threads as workers on `entry` (this file, or its bundle). */
export function spawner(entry: URL | string): Spawn {
  return (d) => {
    // (a file: URL as a URL object)
    const w = new Worker(new URL(String(entry)), { workerData: { phitexThread: d } });
    live.add(w);
    // (gone for good: the core's end waits for this, not only for its thread's "exit" message)
    const exited = new Promise<void>((ok) =>
      w.once("exit", () => {
        live.delete(w);
        if (!live.size) for (const f of none.splice(0)) f();
        ok();
      }),
    );
    return Object.assign(w, { exited });
  };
}

const mine = workerData as { phitexThread?: ThreadData } | undefined;
if (mine?.phitexThread) runThread(mine.phitexThread);
