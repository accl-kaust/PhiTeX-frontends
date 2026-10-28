// A thread of the core (common/src/wasm/threads.ts) as a browser module
// worker: this file is both the spawner, used by the core's worker
// (thread 0, which starts every thread's worker), and the thread's own
// entry, which takes its data in its first message (a browser worker has
// no workerData). The page that runs the core is cross-origin isolated
// (the manifest's cross_origin_embedder_policy and
// cross_origin_opener_policy), so the module and its shared memory cross
// to the worker as they are.

import { runThread, type Spawn, type ThreadData } from "./common/wasm/threads.ts";

/** Starts the core's threads as module workers on this file. */
export const spawnThread: Spawn = (d) => {
  new Worker(new URL("thread.js", import.meta.url), { type: "module", name: `phitex-thread-${d.tid}` }).postMessage(d);
};

// (a thread's worker: its data, then the thread runs to its end and the worker closes)
if (!("document" in globalThis) && self.name.startsWith("phitex-thread-")) {
  self.onmessage = (e: MessageEvent<ThreadData>) => {
    runThread(e.data);
    self.close();
  };
}
