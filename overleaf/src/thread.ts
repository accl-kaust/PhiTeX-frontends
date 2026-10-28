// A thread of the core (common/src/wasm/threads.ts) as a browser module
// worker: this file is both the spawner, used by the core's worker
// (thread 0, worker.ts, which starts every thread's worker), and the
// thread's own entry, which takes its data in its first message (a browser
// worker has no workerData). The workers are thread 0's own (nested
// dedicated workers), so they end with it; the page that runs it is cross-
// origin isolated (the manifest's cross_origin_embedder_policy and
// cross_origin_opener_policy, the offscreen document's), so the module and
// its shared memory cross to the worker as they are.

import { runThread, type ThreadData } from "./common/wasm/threads.ts";

/** Starts a core thread as a module worker on this file: the worker. */
export function spawnThread(d: ThreadData): Worker {
  const w = new Worker(new URL("thread.js", import.meta.url), { type: "module", name: `phitex-thread-${d.tid}` });
  w.postMessage(d);
  return w;
}

// (a thread's worker: its data, then the thread runs to its end and the worker closes)
if (!("document" in globalThis) && self.name.startsWith("phitex-thread-")) {
  self.onmessage = (e: MessageEvent<ThreadData>) => {
    runThread(e.data);
    self.close();
  };
}
