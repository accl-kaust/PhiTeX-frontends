// The offscreen document (in Firefox, the background page, firefox-bg.html,
// which has no offscreen documents): an extension page that relays each
// tab's port to a core of its own, the single-threaded one in a worker
// (worker1.ts; in both browsers: Chromium's threaded core was no faster on a
// first page or a keystroke, and two cores' hosts drifted apart), started
// when the tab connects and ended when it goes. What is not the core's is
// answered here: Shelf's release (told to each tab: an extension older than
// it needs asks for an update) and a compare's latexdiff (diff.wasm).
// Binary files and the PDF cross base64 in Chrome, whose runtime ports carry
// JSON; as they are in Firefox, whose ports carry structured clones.

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

/** Firefox's ports carry bytes as they are: no base64 either way. */
const BYTES_AS_THEY_ARE = location.protocol === "moz-extension:";

function b64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Each tab's (and frame's) core: one at a time (a reload's page connects before the old page's port has gone). */
const cores = new Map<string, Worker>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "phitex") return;
  ports.add(port);
  const tab = `${port.sender?.tab?.id ?? "?"}:${port.sender?.frameId ?? 0}`;
  // (the tab's previous page's core ended before this page's starts)
  const old = cores.get(tab);
  old?.terminate();
  const core = new Worker(new URL("worker1.js", import.meta.url), { type: "module", name: "phitex-core" });
  cores.set(tab, core);
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
    if (!BYTES_AS_THEY_ARE) {
      if (m.pdf) m.pdf = b64(m.pdf);
      // (a pack event's `bytes` is its size, a number: kept as it is)
      if (m.bytes instanceof Uint8Array) m.bytes = b64(m.bytes);
    }
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
      let bytes: Uint8Array;
      if (m.bytes instanceof Uint8Array) bytes = m.bytes;
      else {
        // (atob's string copied in a plain loop: a mapping function per byte is slow)
        const t = atob(m.b64);
        bytes = new Uint8Array(t.length);
        for (let i = 0; i < t.length; i++) bytes[i] = t.charCodeAt(i);
      }
      return core.postMessage({ id: m.id, op: "binary", file: m.file, bytes }, [bytes.buffer]);
    }
    core.postMessage(m);
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (cores.get(tab) === core) {
      cores.delete(tab);
      core.terminate();
    }
  });
});
