// Dev harness: a scenario on the mock Overleaf, traced. Starts the mock with a
// project (folder or Overleaf source ZIP) and Chromium with the extension
// (:9223, .chrome-profile-3), waits for the first page, plays the steps the
// way Overleaf's editor delivers them, and writes what happened:
//   target/mock-run/<name>/trace.txt   every core request and reply, package
//                                      fetches, layouts, console errors, by ms
//   target/mock-run/<name>/<shot>.png  screenshots the steps ask for
//   target/mock-run/<name>/worker-console.txt  the workers' console (a core panic's message)
//   target/mock-run/<name>/core-log.txt  the core's build log (with rebuild traces: a "trace" step)
// and prints the timeline and a summary (builds, worst build, final status).
//
//   node tools/dev/mock-run.mjs SCENARIO.json [--fresh] [--keep]
//
// SCENARIO.json:
//   { "project": "path/to/dir-or.zip", "name": "circuitikz",
//     "steps": [
//       { "type": "circuitikz", "after": "\\usepackage{", "last": true, "keys": 150 },  // key by key, 150 ms apart, after the last match
//       { "type": "\\usepackage{}\n", "before": "\\begin{document}" },      // one edit (a paste)
//       { "replace": "Intro", "with": "Introduction" },
//       { "idle": 1500 },            // until nothing happens for 1.5 s (and no package in flight)
//       { "cpu": 3000 },             // the main thread over 3 s: busy, long tasks, hottest functions (on a "type" step: from its first key)
//       { "wait": 2000 },
//       { "shot": "after-package" },
//       { "clean": true },           // ⟳ Clean recompile
//       { "scroll": 5 },             // the ⚡ view scrolled to page 6
//       { "recompile": true },       // Overleaf's Recompile (the local pdflatex)
//       { "dblpage": [0, 0.3, 0.4] }, // double-click page 0 at 30% across, 40% down: the editor's selection after
//       { "cursor": "Every writer" },  // the cursor put in that text: the word's highlight boxes 150 ms after
//       { "dbltext": "Every writer" }, // double-click the editor at that text: the page's highlight boxes after
//       { "dbloutline": "Section 3" }, // double-click that heading in the file outline
//       { "replacefile": "fig.png", "b64": "…", "ms": 60000 }, // the binary file replaced as Overleaf says it is; until the session's PDF changes, else the run fails
//       { "onpage": "Typed words", "ms": 60000 }, // until that text is on a page, else the run fails
//       { "reload": 3, "ms": 120000 }, // the tab reloaded 3 times, each until its first page, else the run fails
//       { "secondtab": true, "ms": 120000 }, // the project in a second tab: its first page, or its panel saying why it has none; else (neither in time) the run fails
//       { "secondtab": "page", "ms": 120000 }, // the same, its first page required; at an 8 GiB data limit (a 16 GB machine) the cores 4 and 2 GiB
//       { "secondtab": "outgrow", "ms": 900000 }, // the same, its panel required to say the document outgrew its 2 GiB (a project larger than that: tabs-outgrow.json)
//       { "rootdoc": "main.tex" }    // Overleaf's main document changed (its Menu), as its socket tells the editor
//     ] }
//   "strict": true // (top level) the run fails on any exception or console error in the
//                  // tab or the extension (the release gate's: test/scenarios/ci.json)
//   "storage": { "toured": false } // (top level) over the onboarded settings (tools/dev/onboarded.mjs)
//   "nofirst": true              // (top level) the steps begin without waiting for the first tab's first page
//   "budget": { "ms": 30000, "packs": 12, "nopack": "^hyphen-" } // (top level) the first page within 30 s of
//                  // the tab's navigation, at most 12 packages fetched for it, none matching ^hyphen-; else
//                  // the run fails (the release gate's time check: a stale format rebuilt in the tab
//                  // fetches every language's patterns). On a "reload" step: each reload's.
//   "root": "report.tex"         // (top level) Overleaf's main document for the project (the mock's MOCK_ROOT; unset, none)
// --fresh: the package cache (IndexedDB) emptied first, as a new install.
// --keep: Chromium and the mock left running after.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { onboardScript } from "./onboarded.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const args = process.argv.slice(2);
const sc = JSON.parse(fs.readFileSync(args.find((a) => !a.startsWith("--")), "utf8"));
const fresh = args.includes("--fresh"), keep = args.includes("--keep");
// (its own mock port, apart from a mock the user has open on 8123)
// (PHITEX_RUN=n: a second run beside the first, on its own ports and profile)
const RUN = +(process.env.PHITEX_RUN ?? 0);
const PORT = 9223 + 10 * RUN, PROFILE = `.chrome-profile-${3 + RUN}`, MOCK = 8133 + RUN;
const out = path.join(root, "target/mock-run", sc.name ?? "run");
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the mock, on the scenario's project
try { execFileSync("pkill", ["-f", `^node tools/mock/server.mjs ${MOCK}`]); } catch {}
await sleep(500);
const mock = spawn("node", ["tools/mock/server.mjs", String(MOCK)], { cwd: root, env: { ...process.env, MOCK_PROJECT: path.resolve(sc.project), ...(sc.root ? { MOCK_ROOT: sc.root } : {}) }, stdio: ["ignore", "pipe", "inherit"], detached: true });
await new Promise((r) => mock.stdout.once("data", r));
// Chromium with the extension
if (fresh) fs.rmSync(path.join(root, PROFILE, "Default/IndexedDB"), { recursive: true, force: true });
execFileSync("bash", ["tools/dev/chrome.sh", `http://localhost:${MOCK}/project/mock`], { cwd: root, env: { ...process.env, PHITEX_CDP_PORT: String(PORT), PHITEX_PROFILE: PROFILE, PHITEX_HEADLESS: "1" } });

// the tab, over the DevTools protocol: page world (the editor) and the content script's
let tab;
for (let i = 0; i < 60 && !tab; i++) {
  await sleep(250);
  try { tab = (await (await fetch(`http://localhost:${PORT}/json`)).json()).find((t) => t.type === "page" && t.url.includes("project/mock")); } catch {}
}
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map(), contexts = [], events = [];
const T0 = Date.now();
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.method === "Runtime.executionContextCreated") contexts.push(d.params.context);
  if (d.method === "Runtime.executionContextsCleared") contexts.length = 0;
  if (d.method === "Runtime.exceptionThrown") events.push({ t: Date.now() - T0, k: "EXCEPTION", d: d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text });
  if (d.method === "Runtime.consoleAPICalled" && /error|warn/.test(d.params.type)) events.push({ t: Date.now() - T0, k: `console.${d.params.type}`, d: d.params.args.map((a) => a.value ?? a.description).join(" ") });
  pending.get(d.id)?.(d);
});
const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await call("Runtime.enable");
const evalIn = async (expr, cs = false) => {
  const ctx = cs ? contexts.find((c) => c.auxData?.type === "isolated" && c.origin.startsWith("chrome-extension://")) : contexts.find((c) => c.auxData?.isDefault);
  if (!ctx) return undefined;
  const r = await call("Runtime.evaluate", { expression: expr, contextId: ctx.id, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
};
// (a remote session building: its watch's build under way; its pkg.building is not cleared there)
const state = () => evalIn(`(() => { const s = globalThis.__phitexSession; if (!s) return null; return { n: s.trace.length, last: s.trace.at(-1)?.t ?? 0, now: Math.round(performance.now()), loading: s.pkg.loading.length, building: s.o?.remote ? s.watchBuilding : s.pkg.building, inflight: s.inflight, pages: s.pages, done: s.pkg.done ?? [], remote: !!s.o?.remote, built: !!s.trace.findLast((e) => e.k === "← status")?.d?.history } })()`, true);
/** A budget (the scenario's "budget"): `st`, the state at a first page, against it; over it, the run fails. */
function budget(b, st, what) {
  if (!b || !st?.pages) return;
  const done = st.done, odd = b.nopack ? done.filter((p) => new RegExp(b.nopack).test(p)) : [];
  const over = [
    b.ms !== undefined && st.now > b.ms && `its first page ${st.now} ms after the navigation, over ${b.ms}`,
    b.packs !== undefined && done.length > b.packs && `${done.length} packages fetched, over ${b.packs}: ${done.join(" ")}`,
    odd.length && `${odd.length} packages matching ${b.nopack}: ${odd.slice(0, 8).join(" ")}${odd.length > 8 ? " …" : ""}`,
  ].filter(Boolean);
  console.log(`budget, ${what}: ${st.now} ms, ${done.length} packages${over.length ? "" : " (within it)"}`);
  for (const m of over) console.log(`FAIL ${what}: ${m}`);
  if (over.length) process.exitCode = 1;
}
/** Until nothing new for `quiet` ms and no package in flight (or `max`). */
async function idle(quiet = 1500, max = 900_000) {
  const t = Date.now();
  let n = -1, since = Date.now();
  while (Date.now() - t < max) {
    const s = await state();
    if (s && s.n !== n) (n = s.n, since = Date.now());
    if (s && Date.now() - since >= quiet && !s.loading && !s.building && !s.inflight) return true;
    await sleep(200);
  }
  return false;
}
const shot = async (name) => {
  const r = await call("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.result.data, "base64"));
};
/**
 * `{"parity": pct}`: each page as the vector view draws it against poppler
 * (pdftoppm) on the same PDF (the session's), screenshot strip by strip (the
 * stage's height), compared in 4×4 blocks of grey. "missing": blocks the
 * reference inks that the vector view leaves blank (a figure dropped);
 * "diff": any block that differs. A page fails over `pct` % missing; diff
 * images (red: missing, blue/orange: other) land beside the shots as
 * parity-<page>-<strip>.png.
 */
async function parity(s) {
  const P = `const r = document.querySelector("phitex-preview").shadowRoot, st = r.getElementById("stage")`;
  // (a frame: a background tab paints, and its observers run, only when one is asked for)
  const frame = () => call("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } });
  // (a wide window: the page at fit width big enough to compare)
  await call("Emulation.setDeviceMetricsOverride", { width: 2400, height: 1400, deviceScaleFactor: 1, mobile: false });
  await sleep(1000);
  await idle(1000, 60_000);
  const n = await evalIn(`(() => { ${P}; return r.querySelectorAll(".slot").length; })()`, true);
  const strips = [];
  for (let k = 0; k < n; k++) {
    for (let off = 0, i = 0; ; i++) {
      const box = await evalIn(`(() => { ${P}; const el = r.querySelector('.slot[data-k="${k}"]'); st.scrollTop = el.offsetTop + ${off}; const a = el.getBoundingClientRect(), b = st.getBoundingClientRect(); const y = Math.max(a.top, b.top); return { x: a.left, y, top: y - a.top, w: a.width, h: Math.min(a.bottom, b.bottom) - y, H: a.height, step: b.height }; })()`, true);
      let drawn = false;
      for (let t = 0; t < 100 && !drawn; t++) {
        await frame();
        drawn = await evalIn(`(() => { ${P}; return !!r.querySelector('.slot[data-k="${k}"] svg.page'); })()`, true);
        if (!drawn) await sleep(100);
      }
      if (!drawn) console.log(`parity: page ${k} not drawn`);
      // (and its picture, the one scrolling shows: page2.ts raster; a page of only text has none)
      for (let t = 0; t < 30; t++) {
        await frame();
        if (await evalIn(`(() => { ${P}; const s = r.querySelector('.slot[data-k="${k}"]'); return !!s?.querySelector("img.ras") || !s?.querySelector("svg.page g.c > :not(text)"); })()`, true)) break;
        await sleep(100);
      }
      await sleep(300);
      // (whatever lies over the page (a dialog, the chip, a badge) hidden for the shot: the topmost element at points across it, if not the page's own)
      await evalIn(`(() => { ${P}; const el = r.querySelector('.slot[data-k="${k}"]'); const a = el.getBoundingClientRect(); for (let i = 1; i < 12; i++) for (let j = 1; j < 12; j++) { const x = a.left + a.width * i / 12, y = ${box.y} + ${box.h} * j / 12; for (let t = 0; t < 8; t++) { const top = (r.elementFromPoint?.(x, y) ?? document.elementFromPoint(x, y)); if (!top || el.contains(top) || top === st || top.closest?.("#stage") === st && !top.closest(".slot")) break; const o = top.closest?.("dialog, [role=dialog]") ?? top; if (o.dataset) o.dataset.parityHidden = o.style.visibility || "-"; o.style.visibility = "hidden"; } } })()`, true);
      await frame();
      const shotR = await call("Page.captureScreenshot", { format: "png", clip: { x: box.x, y: box.y, width: box.w, height: Math.max(1, box.h), scale: 1 } });
      strips.push({ k, i, box, vector: shotR.result.data });
      await evalIn(`(() => { const r = document.querySelector("phitex-preview").shadowRoot; for (const o of [...r.querySelectorAll("[data-parity-hidden]"), ...document.querySelectorAll("[data-parity-hidden]")]) { o.style.visibility = o.dataset.parityHidden === "-" ? "" : o.dataset.parityHidden; delete o.dataset.parityHidden; } })()`, true);
      off += box.step;
      if (off >= box.H || box.h <= 0) break;
    }
  }
  await call("Emulation.clearDeviceMetricsOverride");
  // (the reference: the session's PDF, by poppler, at the page's width on screen)
  const b64 = await evalIn(`(async () => { const b = await globalThis.__phitexSession.pdf(); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })()`, true);
  const pdf = path.join(out, "parity.pdf");
  fs.writeFileSync(pdf, Buffer.from(b64 ?? "", "base64"));
  const refs = {};
  for (let k = 0; k < n; k++) {
    const w = Math.round(strips.find((x) => x.k === k)?.box.w ?? 800);
    const base = path.join(out, `parity-ref-${k}`);
    execFileSync("pdftoppm", ["-png", "-singlefile", "-f", String(k + 1), "-l", String(k + 1), "-scale-to-x", String(w), "-scale-to-y", "-1", pdf, base]);
    refs[k] = fs.readFileSync(`${base}.png`).toString("base64");
  }
  const results = [];
  let worst = 0;
  for (const { k, i, box, vector } of strips) {
    const r = await evalIn(`(async () => {
      const load = async (b) => createImageBitmap(await (await fetch("data:image/png;base64," + b)).blob());
      const [a, b] = await Promise.all([load(${JSON.stringify(vector)}), load(${JSON.stringify(refs[k])})]);
      const w = a.width, h = a.height;
      const grey = (im, dy) => { const c = new OffscreenCanvas(w, h), x = c.getContext("2d"); x.fillStyle = "white"; x.fillRect(0, 0, w, h); x.drawImage(im, 0, -dy, w, im.height * w / im.width); const d = x.getImageData(0, 0, w, h).data, g = new Float32Array(w * h); for (let i = 0; i < w * h; i++) g[i] = d[4 * i] * 0.3 + d[4 * i + 1] * 0.59 + d[4 * i + 2] * 0.11; return [g, c]; };
      const [ga] = grey(a, 0), [gb, cb] = grey(b, ${box.top} * b.width / w);
      const B = 4, bw = Math.floor(w / B), bh = Math.floor(h / B);
      const out = new OffscreenCanvas(w, h), ox = out.getContext("2d"); ox.drawImage(cb, 0, 0); ox.fillStyle = "rgba(255,255,255,0.7)"; ox.fillRect(0, 0, w, h);
      let miss = 0, diff = 0;
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        let sa = 0, sb = 0;
        for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) { const i = (by * B + y) * w + bx * B + x; sa += ga[i]; sb += gb[i]; }
        sa /= B * B; sb /= B * B;
        if (Math.abs(sa - sb) > 48) { diff++; if (sa > 235 && sb < 200) { miss++; ox.fillStyle = "red"; } else ox.fillStyle = sa < sb ? "blue" : "orange"; ox.fillRect(bx * B, by * B, B, B); }
      }
      const png = await out.convertToBlob({ type: "image/png" });
      const u8 = new Uint8Array(await png.arrayBuffer()); let s = ""; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode(...u8.subarray(i, i + 32768));
      return { missing: 100 * miss / (bw * bh || 1), diff: 100 * diff / (bw * bh || 1), png: btoa(s) };
    })()`);
    if (!r) continue;
    fs.writeFileSync(path.join(out, `parity-${k}-${i}.png`), Buffer.from(r.png, "base64"));
    fs.writeFileSync(path.join(out, `parity-${k}-${i}-vector.png`), Buffer.from(vector, "base64"));
    results.push(`${k}-${i}: missing ${r.missing.toFixed(2)}%, diff ${r.diff.toFixed(2)}%`);
    worst = Math.max(worst, r.missing);
  }
  s.result = { pass: worst <= s.parity, worst: +worst.toFixed(2), strips: results };
  console.log("parity:", JSON.stringify(s.result, null, 1));
  if (worst > s.parity) process.exitCode = 1;
}
const pos = (s) => `(() => { const t = mockEditor.text(); ${s.after !== undefined ? `const i = t.${s.last ? "lastIndexOf" : "indexOf"}(${JSON.stringify(s.after)}); return i < 0 ? -1 : i + ${JSON.stringify(s.after)}.length;` : s.before !== undefined ? `return t.indexOf(${JSON.stringify(s.before)});` : "return t.length;"} })()`;

// the workers' console (the core's stderr: a panic's message, before its trap),
// through the offscreen document's target and the workers attached to it
const workerLog = [];
try {
  const off = (await (await fetch(`http://localhost:${PORT}/json`)).json()).find((t) => t.url.endsWith("/offscreen.html"));
  if (off) {
    const ow = new WebSocket(off.webSocketDebuggerUrl);
    await new Promise((r) => ow.addEventListener("open", r));
    let oid = 0;
    const osend = (method, params = {}, sessionId) => ow.send(JSON.stringify({ id: ++oid, method, params, ...(sessionId ? { sessionId } : {}) }));
    ow.addEventListener("message", (m) => {
      const d = JSON.parse(m.data);
      if (d.method === "Target.attachedToTarget") {
        osend("Runtime.enable", {}, d.params.sessionId);
        osend("Runtime.runIfWaitingForDebugger", {}, d.params.sessionId);
      }
      if (d.method === "Runtime.consoleAPICalled") {
        const text = d.params.args.map((a) => a.value ?? a.description).join(" ");
        workerLog.push(`${Date.now() - T0} ms ${d.params.type}: ${text}`);
      }
    });
    osend("Runtime.enable");
    osend("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }
} catch (e) {
  console.log("worker console: not attached:", String(e));
}

// the onboarded state (tools/dev/onboarded.mjs: no welcome tip, terms or
// tour over the page in a fresh profile), then the project again
{
  const version = JSON.parse(fs.readFileSync(path.join(root, "build/overleaf/manifest.json"), "utf8")).version;
  for (let i = 0; i < 40 && !contexts.some((c) => c.auxData?.isDefault); i++) await sleep(250);
  await sleep(1000);
  // (PHITEX_WORKERS=1: the one-worker start, to compare; else the two-worker start where it applies)
  // (each run from the same settings: the highlight and the page format as a
  // new user has them, then the scenario's own `storage` over the onboarded state)
  for (let i = 0; i < 20 && !contexts.some((c) => c.auxData?.type === "isolated"); i++) await sleep(250);
  await evalIn(`chrome.storage.local.remove(["follow", "panel"])`, true);
  if ((await evalIn(onboardScript(version, { workers: process.env.PHITEX_WORKERS === "1" ? 1 : 2, ...(sc.storage ?? {}) }))) === "onboarded") {
    // (PHITEX_SLOWZIP=kbit/s: the mock sends the project's ZIP that slowly;
    // a screenshot every 300 ms until the first page, load-<ms>.png: the
    // loading card as a slow connection shows it)
    const slow = +(process.env.PHITEX_SLOWZIP ?? 0);
    await call("Page.reload");
    if (slow) {
      const t0 = Date.now();
      for (let i = 0; i < 200; i++) {
        await sleep(300);
        const r = await call("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(path.join(out, `load-${String(Date.now() - t0).padStart(6, "0")}.png`), Buffer.from(r.result.data, "base64"));
        if (process.env.PHITEX_LOADDEBUG) console.log("load:", await evalIn(`(() => { const r = document.querySelector("phitex-preview")?.shadowRoot; const b = r?.querySelector(".load .bar"), i = b?.querySelector("i"); if (!i) return null; const cb = getComputedStyle(b), ci = getComputedStyle(i); return JSON.stringify({ html: b.outerHTML, bar: [cb.display, cb.height, cb.padding, cb.width], i: [ci.display, ci.width, ci.height, ci.backgroundColor, ci.transform, ci.opacity] }); })()`, true));
        const shown = await evalIn(`(() => { const r = document.querySelector("phitex-preview")?.shadowRoot; return !!r?.querySelector(".slot svg.page, .slot canvas"); })()`, true);
        if (shown) break;
      }
    }
    await sleep(1500);
  }
}

// cross-origin isolation, before the core's first page is waited for: the
// tab's (the mock serves COOP and COEP as overleaf.com does) and the
// offscreen document's (the manifest's), where the core's worker shares its
// memory with its threads; and what that document's Chrome allows that
// memory (the 4 GiB shared memory the threaded core asks for, PhiTeX's crates/wasm/live/build.rs,
// and a second beside it: the two-worker start), so a core that cannot
// start says why here
async function inOffscreen(expr) {
  const off = (await (await fetch(`http://localhost:${PORT}/json`)).json()).find((t) => t.url.endsWith("/offscreen.html"));
  if (!off) return undefined;
  const ow = new WebSocket(off.webSocketDebuggerUrl);
  await new Promise((r) => ow.addEventListener("open", r));
  const v = await new Promise((r) => {
    ow.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id === 1) r(d.result?.result?.value ?? d.result?.exceptionDetails?.exception?.description); });
    ow.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
  ow.close();
  return v;
}
// each tab's core's memory as it chose it at its start (GiB: 4, else 3, else
// 2; worker.ts, kept by the offscreen document), and the extension
// process's data limit (Chrome's sandbox sets RLIMIT_DATA by the machine's
// memory: 8 GiB at 16 GB or less), which decides what the cores can get
const memories = async () => JSON.parse((await inOffscreen("JSON.stringify(globalThis.__phitexMemory ?? {})")) ?? "{}");
function dataLimit() {
  let pids = [];
  try { pids = execFileSync("pgrep", ["-f", "--", "--extension-process"], { encoding: "utf8" }).split("\n").filter(Boolean); } catch {}
  const lims = new Set();
  for (const p of pids) {
    try {
      if (!fs.readFileSync(`/proc/${p}/cmdline`, "utf8").includes("--type=renderer")) continue;
      const l = /Max data size\s+(\S+)/.exec(fs.readFileSync(`/proc/${p}/limits`, "utf8"))?.[1];
      if (l) lims.add(l === "unlimited" ? Infinity : +l);
    } catch {}
  }
  return lims.size ? Math.max(...lims) : undefined;
}
const GiB = 2 ** 30;
{
  const iso = { tab: await evalIn("globalThis.crossOriginIsolated", true), offscreen: await inOffscreen("globalThis.crossOriginIsolated") };
  // (no memory tried here beside the cores: a 4 GiB shared memory made
  // to see whether it fits is held until a collection, in the renderer
  // whose data limit the cores share, and the cores' sizes and the
  // pages' JS then lacked it: the extension's renderer at its 8 GiB limit
  // from the start, the first tab's core lost on a 241-page document.
  // Each core's size is said with the tabs' steps, \`memories\`)
  console.log(`cross-origin isolated: tab ${iso.tab}, offscreen ${iso.offscreen}; the renderers' data limit ${dataLimit() === undefined ? "?" : (dataLimit() / GiB).toFixed(1) + " GiB"}`);
  if (iso.offscreen !== true) {
    console.log("FAIL the extension's offscreen document is not cross-origin isolated: the core cannot share its memory with its threads (the manifest's cross_origin_embedder_policy and cross_origin_opener_policy)");
    process.exitCode = 1;
  }
  if (iso.tab !== true) {
    console.log("FAIL the mock's page is not cross-origin isolated (COOP same-origin and COEP credentialless, tools/mock/server.mjs)");
    process.exitCode = 1;
  }
}

// the first page
// (a long project's first build may take a minute or more: waited for
// while the session is building, up to 10 minutes; given up after 30 s
// only when it builds nothing; a remote session's cold build shows in none
// of those flags while it fetches: it is waited for until a build is in)
// ("nofirst": not waited for: the steps begin while it builds, tabs-outgrow's
// second tab beside a first one still at its cold build)
let first;
for (let i = 0; i < (sc.nofirst ? 0 : 2000); i++) {
  const st = (first = await state());
  if (st?.pages || st?.built || (i >= 100 && !st?.remote && !st?.building && !st?.inflight && !st?.loading)) break;
  await sleep(300);
}
// (none: why, from the page, not after the idle's 15 minutes)
if (!sc.nofirst && !(await state())?.pages) {
  console.log("no first page; the session:", JSON.stringify(await state()));
  console.log("editor:", await evalIn(`(() => { const c = document.querySelector(".cm-editor .cm-content"); return c ? "cm-content" + (c.cmView || c.cmTile ? ", with its view" : ", no view") : typeof mockEditor; })()`));
  for (const e of events) console.log(`  ${e.t} ms  ${e.k}  ${String(e.d).slice(0, 400)}`);
  for (const l of workerLog.slice(-20)) console.log("  worker:", l.slice(0, 400));
  // (the session's own last events: what it opened, what the core said)
  const trace = await evalIn(`JSON.stringify((globalThis.__phitexSession?.trace ?? []).slice(-25))`, true).catch(() => "[]");
  for (const t of JSON.parse(trace ?? "[]")) console.log("  session:", JSON.stringify(t).slice(0, 400));
  try { process.kill(-mock.pid); } catch {}
  process.exit(1);
}
budget(sc.budget, first, "the first page");
// ("noidle": the steps start at the first page, while the core readies its rebuilds)
/**
 * The tab's main thread over `wall` ms: CPU time by kind (Performance
 * metrics), its long tasks (over 50 ms: start and length, ms from the
 * measure's start) and the hottest functions (a sampled CPU profile), page
 * and content script alike.
 */
async function cpu(wall) {
  const metrics = async () => Object.fromEntries((await call("Performance.getMetrics")).result.metrics.map((m) => [m.name, m.value]));
  await call("Performance.enable");
  await call("Profiler.enable");
  await call("Profiler.setSamplingInterval", { interval: 1000 });
  await evalIn(`(() => { globalThis.__phxLong = []; const t0 = performance.now(); new PerformanceObserver((l) => { for (const e of l.getEntries()) __phxLong.push([Math.round(e.startTime - t0), Math.round(e.duration)]); }).observe({ type: "longtask" }); })()`);
  const m0 = await metrics();
  await call("Profiler.start");
  await sleep(wall);
  const prof = (await call("Profiler.stop")).result.profile;
  const m1 = await metrics();
  const d = (k) => ((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000;
  const r = { busy: `${((d("TaskDuration") / wall) * 100).toFixed(1)}% of ${wall} ms`, script: Math.round(d("ScriptDuration")), layout: Math.round(d("LayoutDuration")), style: Math.round(d("RecalcStyleDuration")), layouts: (m1.LayoutCount ?? 0) - (m0.LayoutCount ?? 0), styles: (m1.RecalcStyleCount ?? 0) - (m0.RecalcStyleCount ?? 0), long: await evalIn("globalThis.__phxLong") };
  const per = (prof.endTime - prof.startTime) / 1000 / Math.max(1, prof.samples.length);
  const self = new Map(), parent = new Map();
  for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n);
  const name = (f) => `${f.functionName || "(anon)"} ${f.url.replace(/^.*\//, "")}:${f.lineNumber + 1}`;
  for (const n of prof.nodes) {
    const f = n.callFrame;
    if (!n.hitCount || f.functionName === "(idle)" || f.functionName === "(program)") continue;
    // (a native's time by its caller: which script forced a layout)
    const up = !f.url && parent.get(n.id)?.callFrame;
    const k = name(f) + (up?.url ? ` ← ${name(up)}` : "");
    self.set(k, (self.get(k) ?? 0) + n.hitCount * per);
  }
  r.top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${Math.round(v)} ms ${k}`);
  return r;
}

if (!sc.noidle) await idle();
const steps = [];
// (PHITEX_PARITY=pct: every scenario checked against poppler at its end)
if (process.env.PHITEX_PARITY && !(sc.steps ?? []).some((s) => s.parity !== undefined)) (sc.steps ??= []).push({ idle: 1500 }, { parity: +process.env.PHITEX_PARITY });
for (const s of sc.steps ?? []) {
  const t = Date.now() - T0;
  if (s.type !== undefined) {
    const at = await evalIn(pos(s));
    if (at < 0) {
      // (the run goes on, so the trace is still written)
      console.log(`step: anchor not found: ${JSON.stringify(s)}`);
      steps.push({ t, k: "STEP FAILED", d: s });
      continue;
    }
    // (with `"cpu": ms`: the main thread measured from the first key over ms, as the cpu step)
    const measuring = s.cpu !== undefined && cpu(s.cpu);
    if (s.keys) {
      // (key by key, as typing: each its own transaction)
      await evalIn(`(async () => { let at = ${at}; for (const c of ${JSON.stringify(s.type)}) { mockEditor.type(at, c); at += c.length; await new Promise((r) => setTimeout(r, ${s.keys})); } })()`);
    } else await evalIn(`mockEditor.type(${at}, ${JSON.stringify(s.type)})`);
    if (measuring) console.log("cpu while typing:", JSON.stringify((s.result = await measuring), null, 1));
  } else if (s.replace !== undefined) {
    await evalIn(`(() => { const t = mockEditor.text(), i = t.indexOf(${JSON.stringify(s.replace)}); if (i >= 0) mockEditor.replace(i, i + ${JSON.stringify(s.replace)}.length, ${JSON.stringify(s.with ?? "")}); })()`);
  } else if (s.replacefile !== undefined) {
    const digest = `(async () => { const b = await globalThis.__phitexSession.pdf(); return b ? [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].join() : ""; })()`;
    const was = await evalIn(digest, true);
    await fetch(`http://localhost:${MOCK}/project/mock/replace?path=${encodeURIComponent(s.replacefile)}`, { method: "POST", body: Buffer.from(s.b64, "base64") });
    let now = was;
    for (const t0 = Date.now(); now === was && Date.now() - t0 < (s.ms ?? 60000); ) (now = await evalIn(digest, true)) === was && (await sleep(200));
    console.log(`replacefile ${s.replacefile}: the PDF ${now === was ? "UNCHANGED" : "changed"}`);
    if (now === was) (steps.push({ t, k: "STEP FAILED", d: s }), (process.exitCode = 1));
  } else if (s.rootdoc !== undefined) {
    // (`{"rootdoc": "main.tex"}`: the project's main document changed in Overleaf's Menu, its socket telling the editor)
    await fetch(`http://localhost:${MOCK}/project/mock/root-doc?path=${encodeURIComponent(s.rootdoc)}`, { method: "POST" });
    console.log(`rootdoc ${s.rootdoc}: told`);
  } else if (s.onpage !== undefined) {
    const has = `(() => { const r = document.querySelector("phitex-preview")?.shadowRoot; return !!r && [...r.querySelectorAll(".slot text")].some((t) => t.textContent.includes(${JSON.stringify(s.onpage)})); })()`;
    let seen = false;
    for (const t0 = Date.now(); !seen && Date.now() - t0 < (s.ms ?? 60000); ) (seen = !!(await evalIn(has, true))) || (await sleep(200));
    console.log(`onpage ${JSON.stringify(s.onpage)}: ${seen ? "on the page" : "NOT on the page"}`);
    if (!seen) (steps.push({ t, k: "STEP FAILED", d: s }), (process.exitCode = 1));
  } else if (s.idle !== undefined) await idle(s.idle);
  // ({"cpu": ms}: the tab's main thread over ms with nothing typed: CPU
  // time by kind (Performance metrics) and the hottest functions (a
  // sampled CPU profile), page and content script alike)
  else if (s.cpu !== undefined) console.log("cpu:", JSON.stringify((s.result = await cpu(s.cpu)), null, 1));
  else if (s.scrollbench !== undefined) {
    // (`{"scrollbench": ms, "px": n}`: the ⚡ view scrolled n px a frame, down then back up, for ms;
    // the frames' times as the page saw them, and where the main thread went)
    await call("Page.bringToFront");
    await call("Emulation.setFocusEmulationEnabled", { enabled: true });
    // (`"css"`: a style added to the view's shadow root first, to try a change)
    if (s.css !== undefined) await evalIn(`(() => { const r = document.querySelector("phitex-preview").shadowRoot; let st = r.getElementById("phx-bench"); if (!st) { st = document.createElement("style"); st.id = "phx-bench"; r.append(st); } st.textContent = ${JSON.stringify(s.css)}; })()`, true);
    const metrics = async () => Object.fromEntries((await call("Performance.getMetrics")).result.metrics.map((m) => [m.name, m.value]));
    await call("Performance.enable");
    await call("Profiler.enable");
    await call("Profiler.setSamplingInterval", { interval: 200 });
    const m0 = await metrics();
    await call("Profiler.start");
    const frames = await evalIn(`new Promise((done) => { const st = document.querySelector("phitex-preview").shadowRoot.getElementById("stage"); st.scrollTop = 0; const t0 = performance.now(), ts = []; let dir = 1; const f = (t) => { ts.push(t); st.scrollTop += dir * ${s.px ?? 60}; if (st.scrollTop + st.clientHeight >= st.scrollHeight - 1) dir = -1; if (st.scrollTop <= 0) dir = 1; if (t - t0 < ${s.scrollbench}) requestAnimationFrame(f); else done(ts); }; requestAnimationFrame(f); })`, true);
    const prof = (await call("Profiler.stop")).result.profile;
    const m1 = await metrics();
    const d = (k) => ((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000;
    const dt = (frames ?? []).slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
    const q = (p) => dt[Math.min(dt.length - 1, Math.floor(p * dt.length))]?.toFixed(1);
    s.result = { frames: dt.length, fps: +((1000 * dt.length) / s.scrollbench).toFixed(1), median: q(0.5), p95: q(0.95), max: dt.at(-1)?.toFixed(1), over33: dt.filter((x) => x > 33.4).length, busy: `${((d("TaskDuration") / s.scrollbench) * 100).toFixed(1)}%`, script: Math.round(d("ScriptDuration")), layout: Math.round(d("LayoutDuration")), style: Math.round(d("RecalcStyleDuration")), layouts: (m1.LayoutCount ?? 0) - (m0.LayoutCount ?? 0), styles: (m1.RecalcStyleCount ?? 0) - (m0.RecalcStyleCount ?? 0) };
    const per = (prof.endTime - prof.startTime) / 1000 / Math.max(1, prof.samples.length);
    const self = new Map();
    for (const n of prof.nodes) {
      const f = n.callFrame;
      if (!n.hitCount || f.functionName === "(idle)") continue;
      const k = `${f.functionName || "(anon)"} ${f.url.replace(/^.*\//, "")}:${f.lineNumber + 1}`;
      self.set(k, (self.get(k) ?? 0) + n.hitCount * per);
    }
    s.result.top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${Math.round(v)} ms ${k}`);
    console.log("scrollbench:", JSON.stringify(s.result, null, 1));
  }
  else if (s.dumpview !== undefined) {
    // (`{"dumpview": "name"}`: the ⚡ view as a standalone page, <out>/<name>.html (its styles,
    // the glyph and image store, the stage with every page drawn), to time its scrolling apart)
    const html = await evalIn(`(() => { const r = document.querySelector("phitex-preview").shadowRoot; const css = [...r.querySelectorAll("style")].map((s) => s.textContent).join("\\n") + [...(r.adoptedStyleSheets ?? [])].map((sh) => [...sh.cssRules].map((c) => c.cssText).join("\\n")).join("\\n"); const store = r.getElementById("phx-glyphs")?.closest("svg")?.outerHTML ?? ""; const st = r.getElementById("stage"); return "<!doctype html><meta charset=utf-8><style>html,body{margin:0;height:100%} " + css + " #stage{height:100vh;overflow:auto}</style>" + store + st.outerHTML; })()`, true);
    fs.writeFileSync(path.join(out, `${s.dumpview}.html`), html ?? "");
    console.log(`dumpview → ${path.join(out, s.dumpview + ".html")}: ${(html ?? "").length} chars`);
  }
  else if (s.wait !== undefined) await sleep(s.wait);
  else if (s.reload !== undefined) {
    // (a reload's page connects its core before the old page's has ended: offscreen.ts)
    for (let k = 0; k < s.reload; k++) {
      await call("Page.reload");
      const t1 = Date.now();
      let pages = 0, st;
      while (!pages && Date.now() - t1 < (s.ms ?? 120_000)) (await sleep(300), (pages = (st = await state())?.pages ?? 0));
      // (the reloaded page's core gets the 4 GiB again: it asks while the old one's are freed, worker.ts)
      const mem = Object.values(await memories());
      const lim = dataLimit();
      console.log(`reload ${k + 1}: ${pages ? `a first page in ${Date.now() - t1} ms` : "NO first page"}; its core's memory ${mem.join(", ")} GiB (the renderers' data limit ${lim === undefined ? "?" : (lim / GiB).toFixed(1) + " GiB"})`);
      if (!pages) (steps.push({ t, k: "STEP FAILED", d: { ...s, at: k + 1 } }), (process.exitCode = 1));
      else if (mem.length !== 1 || mem[0] !== 4) (console.log(`FAIL the reloaded core has ${mem.join(", ") || "no"} GiB, not 4`), steps.push({ t, k: "STEP FAILED", d: { ...s, at: k + 1, mem } }), (process.exitCode = 1));
      if (pages) budget(s.budget, st, `reload ${k + 1}`);
    }
  } else if (s.secondtab) {
    // (a second tab on the project: its own core, beside the first one's)
    const tw = await (await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent(`http://localhost:${MOCK}/project/mock`)}`, { method: "PUT" })).json();
    const w2 = new WebSocket(tw.webSocketDebuggerUrl);
    await new Promise((r) => w2.addEventListener("open", r));
    const ctx2 = [], wait2 = new Map();
    let id2 = 0;
    w2.addEventListener("message", (m) => {
      const d = JSON.parse(m.data);
      if (d.method === "Runtime.executionContextCreated") ctx2.push(d.params.context);
      wait2.get(d.id)?.(d);
    });
    const call2 = (method, params = {}) => new Promise((r) => { const i = ++id2; wait2.set(i, r); w2.send(JSON.stringify({ id: i, method, params })); });
    await call2("Runtime.enable");
    const t1 = Date.now();
    let seen = null;
    // (outgrow: a page streamed before the core runs out is not the end; its
    // words are looked for first, the card they are said in heads them "Couldn't open")
    while ((!seen || (s.secondtab === "outgrow" && !seen.startsWith("outgrew"))) && Date.now() - t1 < (s.ms ?? 120_000)) {
      await sleep(500);
      // (a background tab paints only when a frame is asked for)
      await call2("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } });
      const c = ctx2.find((x) => x.auxData?.type === "isolated" && x.origin.startsWith("chrome-extension://"));
      if (!c) continue;
      const r = await call2("Runtime.evaluate", { contextId: c.id, returnByValue: true, expression: `(() => { const s = globalThis.__phitexSession; if (s?.pages) return "a first page"; const r = document.querySelector("phitex-preview")?.shadowRoot; const m = /This document needs more than the [\\d.]+ GiB[^]*?reload this tab[^.]*\\./.exec(r?.textContent ?? ""); if (m) return "outgrew: " + m[0]; const h = [...(r?.querySelectorAll("h3") ?? [])].find((e) => /Couldn't open/.test(e.textContent)); return h ? "says: " + h.textContent + ": " + (h.parentElement.querySelector(".count")?.textContent ?? "") : null; })()` });
      seen = r.result?.result?.value ?? null;
    }
    // (each tab's core's size: at an 8 GiB limit the first has 4 GiB, the second 2)
    const mem = Object.values(await memories()).sort((a, b) => b - a);
    const lim = dataLimit();
    console.log(`second tab: ${seen ?? "neither a page nor a reason"} (${Date.now() - t1} ms); the cores' memory ${mem.join(" and ")} GiB (the renderers' data limit ${lim === undefined ? "?" : (lim / GiB).toFixed(1) + " GiB"})`);
    if (s.secondtab === "outgrow" && !/^outgrew: This document needs more than the 2 GiB/.test(seen ?? "")) (console.log("FAIL the second tab did not say it outgrew its 2 GiB"), steps.push({ t, k: "STEP FAILED", d: s }), (process.exitCode = 1));
    if (!seen || (s.secondtab === "page" && seen !== "a first page")) (steps.push({ t, k: "STEP FAILED", d: s }), (process.exitCode = 1));
    if (s.secondtab === "page" && lim !== undefined && lim <= 8 * GiB && mem.join() !== "4,2") (console.log(`FAIL at an ${(lim / GiB).toFixed(1)} GiB limit the two cores have ${mem.join(" and ")} GiB, not 4 and 2`), steps.push({ t, k: "STEP FAILED", d: { ...s, mem } }), (process.exitCode = 1));
    s.result = seen;
    w2.close();
  }
  else if (s.parity !== undefined) await parity(s);
  else if (s.shot) await shot(s.shot);
  else if (s.clean) await evalIn(`(() => { document.getElementById("phitex-zoom")?.click(); document.querySelector("[data-act=clean]")?.click(); })()`);
  else if (s.scroll !== undefined) {
    // (the ⚡ view scrolled to page `scroll`, as a reader would)
    await evalIn(`(() => { const r = document.querySelector("phitex-preview").shadowRoot; const el = r.querySelector('.slot[data-k="${s.scroll}"]'); if (el) r.getElementById("stage").scrollTop = el.offsetTop - 12; })()`, true);
    await call("Page.captureScreenshot", { format: "png" }); // (a frame: the observer sees the scroll)
  } else if (s.recompile) await evalIn(`document.getElementById("recompile").click()`);
  else if (s.eval !== undefined) {
    // (an expression in the content script's world, for debugging)
    s.result = await evalIn(s.eval, !s.page);
    console.log("eval →", JSON.stringify(s.result));
  } else if (s.offscreen !== undefined) {
    // (an expression in the offscreen document: the extension's origin, its IndexedDB)
    s.result = await inOffscreen(s.offscreen);
    console.log("offscreen →", JSON.stringify(s.result));
  } else if (s.extpage !== undefined) {
    // (an extension page, popup.html, opened in a tab of its own: its text after a moment, and a screenshot)
    const off = (await (await fetch(`http://localhost:${PORT}/json`)).json()).find((t) => t.url.endsWith("/offscreen.html"));
    const url = off.url.replace(/offscreen\.html$/, s.extpage);
    const t = await (await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
    const pw = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => pw.addEventListener("open", r));
    let pid = 0;
    const pcall = (method, params = {}) => new Promise((r) => { const i = ++pid; const f = (m) => { const d = JSON.parse(m.data); if (d.id === i) { pw.removeEventListener("message", f); r(d.result); } }; pw.addEventListener("message", f); pw.send(JSON.stringify({ id: i, method, params })); });
    await sleep(2500);
    s.result = (await pcall("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true }))?.result?.value;
    const shot = await pcall("Page.captureScreenshot", { format: "png" });
    if (shot?.data) fs.writeFileSync(path.join(out, `${s.extpage.replace(/\W/g, "-")}.png`), Buffer.from(shot.data, "base64"));
    pw.close();
    console.log("extpage →", JSON.stringify(s.result));
  } else if (s.dblpage) {
    const [k, fx, fy] = s.dblpage;
    await evalIn(`(() => { const root = document.querySelector('phitex-preview')?.shadowRoot ?? document, all = root.querySelectorAll('.slot'); const el = ${k} < 0 ? all[all.length + ${k}] : root.querySelector('.slot[data-k="${k}"]'); if (!el) return; el.scrollIntoView(); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, composed: true, clientX: r.left + r.width * ${fx}, clientY: r.top + r.height * ${fy} })); })()`, true);
    await sleep(800);
    s.result = await evalIn(`(() => { const v = mockEditor.view, m = v.state.selection?.main; return m && { file: document.querySelector('[aria-selected="true"]')?.getAttribute("aria-label"), text: mockEditor.text().slice(Math.min(m.anchor, m.head), Math.max(m.anchor, m.head)), around: mockEditor.text().slice(Math.max(0, m.anchor - 30), m.anchor + 30) }; })()`);
    console.log("dblpage →", JSON.stringify(s.result));
  } else if (s.pagesel !== undefined) {
    // (text selected on page k: its nth text run, as a mouse drag would; the editor's selection after)
    const [k, n] = s.pagesel;
    await evalIn(`(() => { const r = document.querySelector("phitex-preview").shadowRoot; const t = r.querySelectorAll('.slot[data-k="${k}"] text')[${n}]; if (!t) return; const g = document.createRange(); g.selectNodeContents(t); const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(g); r.getElementById("viewer").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true })); })()`, true);
    await sleep(1500);
    s.result = await evalIn(`(() => { const m = mockEditor.view.state.selection?.main; const t = mockEditor.text(); return m && t.slice(Math.min(m.anchor, m.head), Math.max(m.anchor, m.head)); })()`);
    const shown = await evalIn(`(() => { const r = document.querySelector("phitex-preview").shadowRoot; return r.querySelectorAll('.slot[data-k="${k}"] text')[${n}]?.textContent; })()`, true);
    console.log("pagesel →", JSON.stringify({ selectedOnPage: shown?.slice(0, 80), editorSelection: s.result?.slice(0, 120) }));
  } else if (s.select !== undefined) {
    // (the editor's selection over that text: the page's highlight boxes after)
    await evalIn(`(() => { const t = mockEditor.text(), i = t.indexOf(${JSON.stringify(s.select)}); mockEditor.view.dispatch({ selection: { anchor: i, head: i + ${JSON.stringify(s.select)}.length } }); })()`);
    await sleep(1500);
    s.result = await evalIn(`[...document.querySelector("phitex-preview").shadowRoot.querySelectorAll(".mark.sel")].map((m) => m.parentElement.dataset.k + "@" + m.style.top)`, true);
    console.log("select →", JSON.stringify(s.result));
  } else if (s.auxdump !== undefined) {
    // (the auxiliary files carried in, held and written: into DIR/<name>/{carried,files,written}/)
    const j = await evalIn(`(async () => (await globalThis.__phitexSession.core.request({ op: "auxdump" })).json)()`, true);
    const base = path.resolve(s.auxdump.dir ?? out, s.auxdump.name ?? "dump");
    for (const part of ["carried", "files", "written"]) for (const [n, t] of Object.entries(j?.[part] ?? {})) {
      const f = path.join(base, part, n);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, t);
    }
    console.log(`auxdump → ${base}: carried ${Object.keys(j?.carried ?? {}).length}, files ${Object.keys(j?.files ?? {}).length}, written ${Object.keys(j?.written ?? {}).length}`);
  } else if (s.pdfsave !== undefined) {
    // (the ⚡ PDF as it is now, saved: a fresh build's compared with it)
    const b64 = await evalIn(`(async () => { const b = await globalThis.__phitexSession.pdf(); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })()`, true);
    const f = path.join(out, `${s.pdfsave}.pdf`);
    fs.writeFileSync(f, Buffer.from(b64 ?? "", "base64"));
    console.log(`pdfsave → ${f}: ${fs.statSync(f).size} bytes`);
  } else if (s.report) {
    // (the debug report, as the user opens it: ⓘ, then "Report a problem…")
    await evalIn(`(() => { const r = document.querySelector("phitex-preview").shadowRoot; r.getElementById("sum").click(); r.querySelector(".reportbtn")?.click(); })()`, true);
    await sleep(500);
    const text = await evalIn(`document.querySelector("phitex-preview").shadowRoot.getElementById("reporttext").value`, true);
    fs.writeFileSync(path.join(out, "report.txt"), text ?? "");
    console.log(`report → ${text?.length ?? 0} chars, ${path.join(out, "report.txt")}`);
  } else if (s.noorigins) {
    // (no glyph-origin requests after layouts: isolates their effect on rebuilds)
    await evalIn(`globalThis.__phitexSession.noOriginsPrefetch = true`, true);
  } else if (s.trace !== undefined) {
    // (the core's rebuilds traced into its log: core-log.txt)
    await evalIn(`globalThis.__phitexSession.core.request({ op: "trace", on: ${!!s.trace} })`, true);
  } else if (s.open !== undefined) {
    await evalIn(`mockEditor.open(${JSON.stringify(s.open)})`);
    await sleep(500);
  } else if (s.dbloutline !== undefined) {
    // (as a user: two clicks, then the double-click)
    await evalIn(`(() => { const b = [...document.querySelectorAll(".outline-item-link")].find((b) => b.textContent === ${JSON.stringify(s.dbloutline)}); b.click(); b.click(); b.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); })()`);
    await sleep(900);
    s.result = await evalIn(`(() => [...document.querySelector("phitex-preview").shadowRoot.querySelectorAll(".mark")].map((m) => [m.parentElement.dataset.k, m.style.top]))()`, true);
    console.log("dbloutline →", JSON.stringify(s.result));
  } else if (s.cursor !== undefined) {
    // (the cursor put inside that text, as a click: the page follows it, no double-click)
    await evalIn(`(() => { const t = mockEditor.text(), i = t.indexOf(${JSON.stringify(s.cursor)}) + 2; mockEditor.select(i); document.querySelector(".cm-content").dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); })()`);
    await sleep(150);
    s.result = await evalIn(`(() => { const ms = [...(document.querySelector('phitex-preview')?.shadowRoot ?? document).querySelectorAll(".mark:not(.sel)")]; return ms.map((m) => [m.parentElement.dataset.k, m.style.left, m.style.top, m.style.width]); })()`, true);
    console.log("cursor →", JSON.stringify(s.result));
  } else if (s.dbltext !== undefined) {
    await evalIn(`(() => { const t = mockEditor.text(), i = t.indexOf(${JSON.stringify(s.dbltext)}); mockEditor.select(i, i + 3); document.querySelector(".cm-content").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); })()`);
    await sleep(700);
    s.result = await evalIn(`(() => { const ms = [...(document.querySelector('phitex-preview')?.shadowRoot ?? document).querySelectorAll(".mark")]; return ms.map((m) => [m.parentElement.dataset.k, m.style.left, m.style.top, m.style.width]); })()`, true);
    console.log("dbltext →", JSON.stringify(s.result));
  }
  steps.push({ t, k: "STEP", d: s });
}
await idle();
await shot("final");

// the trace: the session's, the steps, and the page's errors, by time
const sess = await evalIn(`(async () => { const s = globalThis.__phitexSession; const st = (await s.core.request({ op: "status" })).json; return { trace: s.trace, t0: Math.round(performance.timeOrigin), status: { pages: st.pages, history: st.history, error: st.error?.message, missing: st.missing }, pkg: s.pkg } })()`, true);
const fmt = (d) => (d === undefined ? "" : typeof d === "string" ? d : JSON.stringify(d));
// (the session's times count from its first event; the steps' from this script's start: both shown, apart)
const lines = [
  ...sess.trace.map((e) => `${String(e.t).padStart(7)} ms  ${e.k.padEnd(18)} ${fmt(e.d)}`),
  "",
  "steps and page errors (ms since this script started):",
  ...[...steps, ...events].sort((a, b) => a.t - b.t).map((e) => `${String(e.t).padStart(7)} ms  ${e.k.padEnd(18)} ${fmt(e.d)}`),
];
fs.writeFileSync(path.join(out, "trace.txt"), lines.join("\n") + "\n");
// (the core's own account: each build's how, then the terminal and the job's log)
const log = await evalIn(`(async () => (await globalThis.__phitexSession.core.request({ op: "log" })).json?.log ?? "")()`, true);
fs.writeFileSync(path.join(out, "core-log.txt"), log ?? "");
fs.writeFileSync(path.join(out, "worker-console.txt"), workerLog.join("\n") + "\n");
fs.writeFileSync(path.join(out, "trace.json"), JSON.stringify({ steps, events, ...sess }, null, 1));
const builds = sess.trace.filter((e) => e.k.startsWith("←") && e.d?.build_ms !== undefined);
const worst = builds.reduce((a, b) => (b.d.build_ms > (a?.d.build_ms ?? -1) ? b : a), undefined);
console.log(lines.slice(0, 400).join("\n"));
console.log(`\n${sc.name ?? "run"}: ${builds.length} builds, worst ${worst?.d.build_ms ?? 0} ms (${worst?.k ?? "-"} at ${worst?.t ?? 0} ms); final: ${fmt(sess.status)}; packages: ${sess.pkg.done?.length ?? 0} fetched, ${sess.pkg.failed?.length ?? 0} failed`);
console.log(`trace and screenshots: ${out}`);
// (strict: an exception or console error anywhere, the tab's or the workers', fails the run)
if (sc.strict) {
  const bad = [...events.filter((e) => e.k === "EXCEPTION" || e.k === "console.error").map((e) => `${e.k}: ${e.d}`), ...workerLog.filter((l) => / error: /.test(l))];
  for (const b of bad) console.log(`FAIL ${String(b).slice(0, 400)}`);
  if (bad.length) process.exitCode = 1;
  console.log(`strict: ${bad.length} errors`);
}
ws.close();
if (!keep) {
  try { execFileSync("pkill", ["-f", "--", `--user-data-dir=${path.join(root, PROFILE)}( |$)`]); } catch {}
  process.kill(-mock.pid);
}
process.exit(process.exitCode ?? 0);
