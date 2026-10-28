// The offscreen document: an extension page, cross-origin isolated by the
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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "phitex") return;
  ports.add(port);
  const core = new Worker(new URL("worker.js", import.meta.url), { type: "module", name: "phitex-core" });
  const say = (m: any) => {
    try {
      port.postMessage(m);
    } catch {
      /* (the tab went away) */
    }
  };
  core.onmessage = (e) => {
    const m = e.data;
    // (bytes as base64: the port carries JSON; a page's image, the PDF only for a download)
    if (m.pdf) m.pdf = b64(m.pdf);
    if (m.image) m.image = b64(m.image);
    say(m);
  };
  core.onerror = (e) => say({ event: "console", item: { kind: "error", text: `core worker: ${e.message}` } });
  if (release) say({ event: "release", release });
  port.onMessage.addListener((m) => {
    if (m.op === "latexdiff") {
      (diffRun ??= platform().asset("dist/diff.wasm").then(async (r) => loadDiff(await r.arrayBuffer()))).then(
        (run) => say({ id: m.id, ok: true, json: run(m.req) }),
        (e) => say({ id: m.id, ok: false, error: `latexdiff: ${e}` }),
      );
      return;
    }
    // (the project's binary files, figures: as bytes to the core)
    if (m.op === "binary") {
      const bytes = Uint8Array.from(atob(m.b64), (c) => c.charCodeAt(0));
      return core.postMessage({ id: m.id, op: "binary", file: m.file, bytes }, [bytes.buffer]);
    }
    core.postMessage(m);
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    core.terminate();
  });
});
