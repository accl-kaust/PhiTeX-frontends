// The offscreen document (in Firefox, the background page, firefox-bg.html,
// which has no offscreen documents): an extension page, cross-origin isolated by the
// manifest (SharedArrayBuffer: the core's memory is shared with its
// threads), that relays each tab's port to a core of its own: a worker
// (worker.ts, the core's thread 0), started when the tab connects and
// ended when it goes, its threads with it. What is not the core's is
// answered here: Shelf's release (told to each tab: an extension older than
// it needs asks for an update) and a compare's latexdiff (diff.wasm).
// Binary files and the PDF cross base64: runtime ports carry JSON.

import "./platform.ts";
import { platform } from "./common/platform.ts";
import { refresh, type Release } from "./common/release.ts";
import { type DiffReply, type DiffReq, loadDiff } from "./common/viewer/diff.ts";

let release: Release | undefined;
const ports = new Set<chrome.runtime.Port>();
const told = (r: Release | undefined) => {
  release = r;
  for (const p of ports) p.postMessage({ event: "release", release: r });
};
// (at most once a day; a newer index is read by the next core)
void refresh().then(told, () => undefined);
setInterval(() => void refresh().then(told, () => undefined), 3600 * 1000);

/** diff.wasm, loaded at the first compare. */
let diffRun: Promise<(r: DiffReq) => DiffReply> | undefined;

function b64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Each tab's (and frame's) core: one at a time. A reload connects the new
 * page's port before the old page's has gone, and the old core holds its
 * 4 GiB until it ends; on a machine with 16 GB of memory or less Chrome
 * gives this page's process 8 GiB of data in all, so the new core's memory
 * was refused (the release gate's browsers job, and a user's reload).
 */
const cores = new Map<string, Worker>();

/** A core ended, and every other told: one whose start was refused memory waits for this one's to be freed (worker.ts). */
function end(core: Worker): void {
  core.terminate();
  ended = performance.now();
  for (const c of cores.values()) if (c !== core) c.postMessage({ op: "freeing", ago: 0 });
}
/** When a core was last ended (a new core is told: its memory may still be held). */
let ended = -Infinity;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "phitex") return;
  ports.add(port);
  const tab = `${port.sender?.tab?.id ?? "?"}:${port.sender?.frameId ?? 0}`;
  // (the tab's previous page's core ended before this page's starts)
  const old = cores.get(tab);
  if (old) end(old);
  // (Chrome's offscreen page is cross-origin isolated: the threaded core;
  // Firefox's background page cannot be: the single-threaded one, worker1.ts)
  const core = new Worker(new URL(globalThis.crossOriginIsolated ? "worker.js" : "worker1.js", import.meta.url), { type: "module", name: "phitex-core" });
  cores.set(tab, core);
  if (performance.now() - ended < 5000) core.postMessage({ op: "freeing", ago: performance.now() - ended });
  const say = (m: any) => {
    try {
      port.postMessage(m);
    } catch {
      /* (the tab went away) */
    }
  };
  core.onmessage = (e) => {
    const m = e.data;
    // (bytes as base64: the port carries JSON; a page's strips' pixels, the PDF only for a download)
    if (m.pdf) m.pdf = b64(m.pdf);
    if (m.bytes) m.bytes = b64(m.bytes);
    say(m);
  };
  core.onerror = (e) => say({ event: "console", item: { kind: "error", text: `core worker: ${e.message}` } });
  if (release) say({ event: "release", release });
  port.onMessage.addListener((m) => {
    // (the tab's every 20 s: an event, so Firefox keeps this page and its core)
    if (m.op === "keepalive") return;
    if (m.op === "latexdiff") {
      (diffRun ??= platform().asset("dist/diff.wasm").then(async (r) => loadDiff(await r.arrayBuffer()))).then(
        (run) => say({ id: m.id, ok: true, json: run(m.req) }),
        (e) => say({ id: m.id, ok: false, error: `latexdiff: ${e}` }),
      );
      return;
    }
    // (the project's binary files, figures: as bytes to the core)
    if (m.op === "binary") {
      // (atob's string copied in a plain loop: a mapping function per byte is slow)
      const t = atob(m.b64);
      const bytes = new Uint8Array(t.length);
      for (let i = 0; i < t.length; i++) bytes[i] = t.charCodeAt(i);
      return core.postMessage({ id: m.id, op: "binary", file: m.file, bytes }, [bytes.buffer]);
    }
    core.postMessage(m);
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (cores.get(tab) === core) {
      cores.delete(tab);
      end(core);
    }
  });
});
