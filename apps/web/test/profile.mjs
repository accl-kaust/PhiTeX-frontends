// Where a visit's time goes: /try from a fresh profile, then reloaded (warm), every request (the page's and its
// workers'), the core's console and the panel's status as it changes, each with its ms from navigation.
//   node apps/web/test/profile.mjs [url]
import { chromium } from "playwright-core";
const url = process.argv[2] ?? "http://127.0.0.1:5198/try";
const cache = process.cwd() + "/web/test/.cache";
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox", "--disable-crashpad", "--disable-crash-reporter"], env: { ...process.env, HOME: cache, XDG_CONFIG_HOME: cache + "/cfg", XDG_CACHE_HOME: cache + "/cache" } });
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
const p = await ctx.newPage();

async function visit(name) {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const reqs = new Map();
  const events = [];
  const onReq = (r) => reqs.set(r, { url: r.url(), start: ms() });
  const onDone = async (r) => {
    const e = reqs.get(r);
    if (!e) return;
    e.end = ms();
    e.status = (await r.response())?.status();
    e.bytes = (await r.sizes().catch(() => null))?.responseBodySize ?? 0;
    e.cached = (await r.response())?.fromServiceWorker?.() ? "sw" : "";
  };
  const onFail = (r) => {
    const e = reqs.get(r);
    if (e) Object.assign(e, { end: ms(), failed: r.failure()?.errorText });
  };
  ctx.on("request", onReq);
  ctx.on("requestfinished", onDone);
  ctx.on("requestfailed", onFail);
  const onWorker = (w) => w.on("console", (m) => events.push([ms(), `worker: ${m.text().slice(0, 120)}`]));
  p.on("worker", onWorker);
  const onConsole = (m) => /phitex/.test(m.text()) && events.push([ms(), `page: ${m.text().slice(0, 120)}`]);
  p.on("console", onConsole);
  if (name === "cold") await p.goto(url);
  else await p.reload();
  events.push([ms(), "load event"]);
  // (the panel's status as it changes, and the first page drawn)
  let last = "", painted = false;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const s = await p.evaluate(() => {
      const r = document.querySelector("phitex-preview")?.shadowRoot;
      return { st: (r?.getElementById("sttext")?.textContent ?? "") + " " + (r?.getElementById("stmore")?.textContent ?? ""), canvas: !!r?.querySelector(".slot canvas"), tree: document.querySelectorAll(".phx-tree-list li").length };
    }).catch(() => ({ st: "", canvas: false, tree: 0 }));
    if (s.st !== last) events.push([ms(), `status: ${(last = s.st).trim() || "(empty)"}`]);
    if (s.canvas && !painted) (painted = true), events.push([ms(), "first page painted"]);
    if (painted && /First build|Built/.test(s.st)) break;
    await p.waitForTimeout(50);
  }
  await p.waitForTimeout(500);
  ctx.off("request", onReq); ctx.off("requestfinished", onDone); ctx.off("requestfailed", onFail);
  p.off("worker", onWorker); p.off("console", onConsole);
  const all = [...reqs.values()];
  const kind = (u) => /\/tl2026\/h\//.test(u) ? "pack" : /core\.wasm/.test(u) ? "core.wasm" : /\/formats\//.test(u) ? "format" : /shelf-(index|packs)/.test(u) ? "shelf index" : /\/texmf\//.test(u) ? "texmf" : /\/try\/(web\.js|dist\/(web|worker|thread)\.js)/.test(u) ? "script" : /tl2026\/(index|release)/.test(u) ? "shelf release" : "other";
  const groups = {};
  for (const r of all) {
    const k = kind(r.url);
    const g = (groups[k] ??= { n: 0, bytes: 0, first: Infinity, last: 0, failed: 0, hosts: new Set() });
    g.n++; g.bytes += r.bytes ?? 0; g.first = Math.min(g.first, r.start); g.last = Math.max(g.last, r.end ?? r.start);
    if (r.failed) g.failed++;
    g.hosts.add(new URL(r.url).host);
  }
  console.log(`\n=== ${name}`);
  for (const [k, g] of Object.entries(groups)) console.log(`${k.padEnd(14)} n=${String(g.n).padStart(3)}  ${(g.bytes / 1e6).toFixed(2).padStart(6)} MB  ${String(g.first).padStart(6)} → ${String(g.last).padStart(6)} ms  failed=${g.failed}  ${[...g.hosts].join(",")}`);
  for (const r of all.filter((r) => /core\.wasm|formats\/|shelf-index|web\.js|worker\.js/.test(r.url))) console.log(`  ${String(r.start).padStart(6)} → ${String(r.end ?? "?").padStart(6)} ms  ${(r.bytes / 1e6).toFixed(2)} MB  ${r.url.replace(/^https?:\/\/[^/]+/, "")}${r.failed ? "  FAILED " + r.failed : ""}`);
  for (const r of all.filter((r) => r.failed)) console.log(`  failed: ${r.url} ${r.failed}`);
  for (const [t, e] of events.sort((a, b) => a[0] - b[0])) console.log(`  ${String(t).padStart(6)} ms  ${e}`);
}
await visit("cold");
await visit("warm");
await b.close();
