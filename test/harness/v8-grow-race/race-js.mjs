// Thread A grows the shared memory a page at a time; thread B, told the new size through
// an Atomics word, at once writes into the newest page with memory.fill, memory.copy and a
// plain store. Does any trap? (core/build.rs says memory.copy/fill into just-grown pages traps in V8.)
import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";
import { bytes } from "./mod.mjs";
const P = 65536;
if (isMainThread) {
  const mem = new WebAssembly.Memory({ initial: 1, maximum: 65535, shared: true });
  const sig = new Int32Array(new SharedArrayBuffer(8));
  const w = new Worker(new URL(import.meta.url), { workerData: { mem, sig } });
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { mem } });
  const N = +(process.argv[2] ?? 4000);
  for (let i = 0; i < N; i++) {
    const old = inst.exports.grow(1);
    Atomics.store(sig, 0, old + 1); Atomics.notify(sig, 0);
    while (Atomics.load(sig, 1) !== old + 1) Atomics.wait(sig, 1, Atomics.load(sig, 1), 1000);
  }
  Atomics.store(sig, 0, -1); Atomics.notify(sig, 0);
  w.on("message", (m) => { console.log(m); process.exit(0); });
} else {
  const { mem, sig } = workerData;
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { mem } });
  const res = { fill: 0, copy: 0, store: 0, ok: 0 };
  for (let seen = 1; ; ) {
    Atomics.wait(sig, 0, seen);
    const n = Atomics.load(sig, 0);
    if (n < 0) break;
    const at = (n - 1) * P;
    for (const [k, f] of [["fill", () => inst.exports.fill(at, 7, P)], ["copy", () => inst.exports.copy(at, 0, P)], ["store", () => inst.exports.store(at + P - 4, 1)]]) {
      try { f(); res.ok++; } catch (e) { res[k]++; res.last = String(e); }
    }
    seen = n;
    Atomics.store(sig, 1, n); Atomics.notify(sig, 1);
  }
  parentPort.postMessage({ v8: process.versions.v8, ...res });
}
