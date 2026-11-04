// The worker inside wasm the whole time (spin): the main thread grows a page, writes its
// number at 0; the worker's memory.fill into that page at once, then acks at 4.
import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";
import { bytes } from "./mod.mjs";
if (isMainThread) {
  const mem = new WebAssembly.Memory({ initial: 1, maximum: 65535, shared: true });
  const w = new Worker(new URL(import.meta.url), { workerData: { mem } });
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { mem } });
  const N = +(process.argv[2] ?? 4000);
  let trapped = null;
  w.on("error", (e) => { trapped = String(e); });
  w.on("message", (m) => { console.log("worker:", m); });
  for (let i = 0; i < N && !trapped; i++) {
    const old = inst.exports.grow(1);
    const v = new Int32Array(mem.buffer);
    Atomics.store(v, 0, old + 1); Atomics.notify(v, 0);
    const t = Date.now();
    while (Atomics.load(v, 1) !== old + 1 && Date.now() - t < 5000) {}
    if (Atomics.load(v, 1) !== old + 1) { trapped = trapped ?? "no ack in 5 s at page " + (old + 1); break; }
  }
  { const v = new Int32Array(mem.buffer); Atomics.store(v, 0, -1); Atomics.notify(v, 0); }
  setTimeout(() => { console.log({ pages: inst.exports.size(), trapped }); process.exit(0); }, 500);
} else {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { mem: workerData.mem } });
  try { inst.exports[process.env.FN ?? "spin"](); parentPort.postMessage("ended"); } catch (e) { parentPort.postMessage("TRAP " + e); }
}
