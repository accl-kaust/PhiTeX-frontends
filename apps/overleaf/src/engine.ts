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
async function coreWorker(): Promise<Worker> {
  if (location.protocol === "moz-extension:") return new Worker(new URL("engine-worker.js", import.meta.url), { type: "module", name: "phitex-core" });
  const text = await (await fetch(new URL("engine-worker.js", import.meta.url))).text();
  const root = new URL("../", import.meta.url).href;
  const blob = new Blob([`globalThis.PHITEX_ROOT = ${JSON.stringify(root)};\n`, text], { type: "text/javascript" });
  return new Worker(URL.createObjectURL(blob), { type: "module", name: "phitex-core" });
}

let taken = false;
addEventListener("message", async (e) => {
  const port = e.ports[0];
  // (the tab's one port: its frame's parent's, the first)
  if (taken || e.source !== parent || e.data !== "phitex-engine" || !port) return;
  taken = true;
  /**
   * The core's worker, and what a new one is given again: the tab's hello
   * and its figures. A worker that dies (its error event: out of memory, a
   * crash) is said to the tab as a trap, the requests waiting on it
   * answered with why, every later one too until an open starts a new
   * worker. Before, they waited for ever, or a fresh core answered "no
   * document open".
   */
  let hello: unknown;
  const figures = new Map<string, unknown>();
  const waiting = new Set<number>();
  let dead: string | undefined;
  const begin = async () => {
    const w = await coreWorker();
    w.onmessage = (m) => {
      // (a replayed hello's or figure's reply: the tab had its own)
      if (m.data?.id === -1) return;
      if (typeof m.data?.id === "number") waiting.delete(m.data.id);
      port.postMessage(m.data, moved(m.data));
    };
    w.onerror = (err) => {
      port.postMessage({ event: "console", item: { kind: "error", text: `core worker: ${err.message}` } });
      if (dead) return;
      dead = `core trapped (worker): The engine crashed${err.message ? ` (${err.message})` : ""}.`;
      w.terminate();
      for (const id of waiting) port.postMessage({ id, ok: false, error: dead });
      waiting.clear();
      port.postMessage({ event: "trapped", error: dead });
    };
    if (hello) w.postMessage(hello);
    for (const f of figures.values()) w.postMessage(f);
    return w;
  };
  let core = await begin();
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
    if (r.op === "hello") hello = { ...r, id: -1 };
    if (r.op === "binary") figures.set(r.file, { ...r, id: -1, bytes: (r.bytes as Uint8Array).slice() });
    if (dead) {
      if (r.op !== "open") return port.postMessage({ id: r.id, ok: false, error: dead });
      dead = undefined;
      core = await begin();
    }
    if (typeof r.id === "number" && r.id >= 0) waiting.add(r.id);
    core.postMessage(r, moved(r));
  };
  // (at most once a day; a newer index is read by the next core)
  const tell = () => void refresh().then((release) => release && port.postMessage({ event: "release", release }), () => undefined);
  tell();
  setInterval(tell, 3600 * 1000);
});
