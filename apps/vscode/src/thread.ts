// A thread of the core (common/src/wasm/threads.ts) as a Node worker
// thread: this file is both the spawner, imported by whoever runs thread 0
// (which starts every thread's worker), and the thread's own entry, when a
// worker is started on it with a thread's data.

import { Worker, workerData } from "node:worker_threads";
import { runThread, type Spawn, type ThreadData } from "../../../common/src/wasm/threads.ts";

/** Starts the core's threads as workers on `entry` (this file, or its bundle). */
export function spawner(entry: URL | string): Spawn {
  const spawn: Spawn = (d) => {
    // (a file: URL as a URL object)
    new Worker(new URL(String(entry)), { workerData: { phitexThread: d } });
  };
  return spawn;
}

const mine = workerData as { phitexThread?: ThreadData } | undefined;
if (mine?.phitexThread) runThread(mine.phitexThread);
