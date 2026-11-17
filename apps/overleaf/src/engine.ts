// The engine's page: an extension page in a hidden iframe of the Overleaf
// tab (content-main.ts's FrameTransport puts it there) that runs the tab's
// core in a worker of its own (worker1.ts) and hands the tab a MessagePort
// to it, as the web demo talks to its worker: requests and replies cross as
// structured clones, bytes as they are. (Before: the tab's runtime port to
// the offscreen document, or Firefox's background page, which relayed each
// message to the worker; in Chrome every page's pixels base64 both ways.)
// The core ends with the tab, its iframe gone. What is not the core's is
// answered here: Shelf's release (told to the tab: an extension older than
// it needs asks for an update) and a compare's latexdiff (diff.wasm).

import "./platform.ts";
import { platform } from "./common/platform.ts";
import { refresh } from "./common/release.ts";
import { type DiffReply, type DiffReq, loadDiff } from "./common/viewer/diff.ts";

/** diff.wasm, loaded at the first compare. */
let diffRun: Promise<(r: DiffReq) => DiffReply> | undefined;

/** The bytes a message carries (a page's strips, the PDF, a figure): moved to the other side, not copied. */
const moved = (m: { bytes?: unknown; pdf?: unknown }) => [m?.bytes, m?.pdf].filter((b): b is Uint8Array => b instanceof Uint8Array).map((b) => b.buffer as ArrayBuffer);

/**
 * The core's worker: worker1.ts bundled (build.sh: dist/engine-worker.js).
 * In Chrome from a blob of its text, told the extension's root: Chrome
 * loads no extension script (module or classic, web-accessible or not)
 * into a worker of an extension iframe in a web page, but runs a blob, and
 * from there the extension's files are fetched as ever. Firefox the other
 * way round: its extension pages' policy refuses a blob worker (worker-src
 * blob: too), and it loads the extension's own script.
 */
async function coreWorker(test?: string): Promise<Worker> {
  // (a test's broken worker (engine-boot.ts: the local mock only): a script that throws as it loads)
  if (test === "worker-script") return new Worker(URL.createObjectURL(new Blob(['throw new Error("a test: the core worker\'s script failed")'], { type: "text/javascript" })), { type: "module" });
  if (location.protocol === "moz-extension:") return new Worker(new URL("engine-worker.js", import.meta.url), { type: "module", name: "phitex-core" });
  const res = await fetch(new URL(test === "worker-fetch" ? "engine-worker-missing.js" : "engine-worker.js", import.meta.url)).catch((e: unknown) => {
    throw new Error(`fetching the core's worker script (dist/engine-worker.js): ${e instanceof Error ? e.message : String(e)}`);
  });
  if (!res.ok) throw new Error(`fetching the core's worker script (dist/engine-worker.js): HTTP ${res.status}`);
  const text = await res.text();
  const root = new URL("../", import.meta.url).href;
  const blob = new Blob([`globalThis.PHITEX_ROOT = ${JSON.stringify(root)};\n`, text], { type: "text/javascript" });
  return new Worker(URL.createObjectURL(blob), { type: "module", name: "phitex-core" });
}

/**
 * The tab's port served (engine-boot.ts hands it over): first the answer the
 * tab waits for, `{ event: "engine", ok }`, once the core's worker is made,
 * or why it couldn't be; then the requests. `test`: a failure a scenario
 * asks for, on the local mock only.
 */
export async function serve(port: MessagePort, test?: string): Promise<void> {
  /**
   * The core's worker, and what a new one is given again: the tab's hello
   * and its figures. A worker that dies (its error event: out of memory, a
   * crash) is said to the tab as a trap, the requests waiting on it
   * answered with why, every later one too until an open starts a new
   * worker. Before, they waited for ever, or a fresh core answered "no
   * document open".
   */
  let hello: { project?: unknown } | undefined;
  const figures = new Map<string, unknown>();
  const waiting = new Set<number>();
  let dead: string | undefined;
  const begin = async () => {
    const w = await coreWorker(test);
    w.onmessage = (m) => {
      // (a replayed hello's or figure's reply: the tab had its own)
      if (m.data?.id === -1) return;
      if (typeof m.data?.id === "number") waiting.delete(m.data.id);
      port.postMessage(m.data, moved(m.data));
    };
    // (its script failing to load or run says so with an error event, a
    // module's with no message: said as the engine not starting)
    const fail = (why: string) => {
      port.postMessage({ event: "console", item: { kind: "error", text: `core worker: ${why}` } });
      if (dead) return;
      dead = `core trapped (worker): The engine crashed or didn't start (${why}).`;
      w.terminate();
      for (const id of waiting) port.postMessage({ id, ok: false, error: dead });
      waiting.clear();
      port.postMessage({ event: "trapped", error: dead });
    };
    w.onerror = (err) => fail(err.message || "its script failed to load or threw as it started");
    // (a reply that couldn't be read here: its request would wait for ever)
    w.onmessageerror = () => fail("a reply of the core couldn't be read");
    if (hello) w.postMessage(hello);
    for (const f of figures.values()) w.postMessage(f);
    return w;
  };
  let core: Worker;
  try {
    core = await begin();
  } catch (err) {
    // (no worker: the tab told why, and every request after answered with it)
    const why = `the engine didn't start: ${err instanceof Error ? err.message : String(err)}`;
    port.postMessage({ event: "engine", ok: false, error: why });
    port.onmessage = (m) => typeof m.data?.id === "number" && port.postMessage({ id: m.data.id, ok: false, error: why });
    return;
  }
  port.postMessage({ event: "engine", ok: true });
  port.onmessage = async (m) => {
    const r = m.data;
    if (r.op === "latexdiff") {
      (diffRun ??= platform().asset("dist/diff.wasm").then(async (a) => loadDiff(await a.arrayBuffer()))).then(
        (run) => port.postMessage({ id: r.id, ok: true, json: run(r.req) }),
        (err) => port.postMessage({ id: r.id, ok: false, error: `latexdiff: ${err}` }),
      );
      return;
    }
    // (kept for a new worker: its replies to these go nowhere, the tab has had them)
    if (r.op === "hello") {
      if (hello && hello.project !== r.project) figures.clear();
      hello = { ...r, id: -1 };
    }
    if (r.op === "binary") figures.set(r.file, { ...r, id: -1, bytes: (r.bytes as Uint8Array).slice() });
    if (r.op === "withdraw") figures.delete(r.file);
    if (dead) {
      if (r.op !== "open") return port.postMessage({ id: r.id, ok: false, error: dead });
      try {
        core = await begin();
        dead = undefined;
      } catch (err) {
        return port.postMessage({ id: r.id, ok: false, error: `the engine didn't start again: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    if (typeof r.id === "number" && r.id >= 0) waiting.add(r.id);
    core.postMessage(r, moved(r));
  };
  // (at most once a day; a newer index is read by the next core)
  const tell = () => void refresh().then((release) => release && port.postMessage({ event: "release", release }), () => undefined);
  tell();
  setInterval(tell, 3600 * 1000);
}
