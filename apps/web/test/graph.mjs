// The demo's persisted graph (PhiTeX's docs/spec-persisted-graph.md, the
// web frontend's: common/src/wasm/graphs.ts, IndexedDB): in headless
// Chromium, the first sample opened, its graph saved at the pause and kept
// in this browser; the page reloaded (the demo closed and opened again):
// the graph loaded and nothing built, the same PDF; then, the page away,
// the project changed in this browser's store (as another tab's edit, or a
// ZIP uploaded over it, would leave it) and the demo opened again: the
// graph loaded, the change built, its words on the page, and the PDF a
// clean build's of the project as it is (graphs turned off, the page
// reloaded once more: byte for byte).
//   node apps/web/test/graph.mjs            build/web (tools/build/build-web.sh) served here
// PHITEX_CHROME: the browser (default /usr/bin/chromium). Exits 1 on a failure.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";

const port = 19000 + Math.floor(Math.random() * 1000);
const server = spawn(process.execPath, ["apps/web/test/serve.mjs", String(port)], { stdio: "inherit" });
await new Promise((r) => setTimeout(r, 400));
const url = `http://127.0.0.1:${port}/`;
const home = fs.mkdtempSync("/tmp/phitex-graph-");
const b = await chromium.launch({ executablePath: process.env.PHITEX_CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox", "--disable-crashpad", "--disable-crash-reporter"], env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home } });
const p = await b.newPage({ viewport: { width: 1360, height: 820 } });
const errors = [];
p.on("pageerror", (e) => errors.push(`exception: ${String(e).slice(0, 400)}`));
const shadow = (js) => `(() => { const r = document.querySelector("phitex-preview")?.shadowRoot; if (!r) return false; ${js} })()`;
const fails = [];
const check = async (what, f) => {
  const t = Date.now();
  try {
    const how = await f();
    console.log(`ok ${what} (${((Date.now() - t) / 1000).toFixed(1)} s)${how ? `: ${how}` : ""}`);
  } catch (e) {
    fails.push(what);
    console.log(`FAIL ${what}: ${String(e).split("\n")[0]}`);
  }
};

/** The demo opened (or reloaded): its first page drawn. */
async function opened(go) {
  await go();
  await p.waitForFunction(() => window.phitex && globalThis.__phitexSession, null, { timeout: 60000 });
  await p.waitForFunction(shadow(`return !r.querySelector(".win").classList.contains("sheet-up") && !!r.querySelector(".slot svg.page, .slot canvas")`), null, { timeout: 300000 });
}
/** The session's graph and build facts (its trace: "core: graph", "core: build"). */
const facts = () =>
  p.evaluate(() => {
    const t = globalThis.__phitexSession?.trace ?? [];
    const graphs = t.filter((e) => e.k === "core: graph").map((e) => e.d);
    return { graphs, build: t.find((e) => e.k === "core: build")?.d, notes: graphs.flatMap((g) => g.notes ?? []) };
  });
/** The first build's facts, once in. */
async function firstBuild() {
  await p.waitForFunction(() => (globalThis.__phitexSession?.trace ?? []).some((e) => e.k === "core: build"), null, { timeout: 300000 });
  return facts();
}
/** The PDF the session shows, hashed. */
const pdf = () => p.evaluate(async () => { const b = await globalThis.__phitexSession.pdf(); return b ? Array.from(b) : null; }).then((b) => (b ? createHash("sha256").update(Buffer.from(b)).digest("hex").slice(0, 16) : null));
/** The pages' text as the core has them (the viewer's `text`). */
const text = () => p.evaluate(async () => JSON.stringify((await globalThis.__phitexSession.core.request({ op: "text" })).json));
/** Until a graph is saved and kept in this browser's IndexedDB. */
async function saved() {
  await p.waitForFunction(() => (globalThis.__phitexSession?.trace ?? []).some((e) => e.k === "core: graph" && e.d.saved > 0), null, { timeout: 120000 });
  await p.waitForFunction(
    () => new Promise((ok) => { const o = indexedDB.open("phitex-graph"); o.onsuccess = () => { const db = o.result; if (!db.objectStoreNames.contains("meta")) return ok(false); const r = db.transaction("meta").objectStore("meta").count(); r.onsuccess = () => ok(r.result > 0); r.onerror = () => ok(false); }; o.onerror = () => ok(false); }),
    null,
    { timeout: 30000, polling: 300 },
  );
}
const describe = (f) => `${f.notes.join(" | ") || "no graph notes"}; first build: ${f.build ? `${f.build.why}, ${f.build.ran} nodes run, ${Math.round(f.build.wall_ms)} ms` : "none"}`;

let first;
await check("the first open: a clean build, its graph saved and kept", async () => {
  await opened(() => p.goto(url));
  const f = await firstBuild();
  if (f.graphs.some((g) => g.loaded)) throw new Error(`a graph loaded on a fresh browser: ${describe(f)}`);
  await saved();
  first = await pdf();
  return describe(await facts());
});
await check("reloaded, nothing changed: the graph loaded, nothing built, the same PDF", async () => {
  await opened(() => p.reload());
  const f = await firstBuild();
  await p.waitForFunction(() => (globalThis.__phitexSession?.trace ?? []).some((e) => e.k === "core: graph"), null, { timeout: 30000 });
  const g = await facts();
  const now = await pdf();
  if (!g.graphs.some((x) => x.loaded) || g.build.ran !== 0 || now !== first) throw new Error(`${describe(g)}; PDF ${now === first ? "the same" : "NOT the same"}`);
  return describe(g);
});
let typed;
await check("the project changed while the demo was away: loaded, the change built", async () => {
  // (away: a page of the demo's origin that runs nothing of it)
  const id = await p.evaluate(() => localStorage.getItem("phitex.web.open"));
  await p.goto(url + "LICENSE.txt");
  const word = await p.evaluate(
    (id) =>
      new Promise((ok, fail) => {
        const o = indexedDB.open("phitex-web");
        o.onerror = () => fail(o.error);
        o.onsuccess = () => {
          const st = o.result.transaction("projects", "readwrite").objectStore("projects");
          const g = st.get(id);
          g.onsuccess = () => {
            const pr = g.result;
            const t = pr.files[pr.main];
            const body = t.indexOf("\\begin{document}");
            const m = /\n([A-Za-z][^\\%\n{}$]{20,})\n/.exec(t.slice(body));
            if (!m) return fail(new Error("no line of words in the sample"));
            const at = body + m.index + 1 + m[1].length;
            pr.files[pr.main] = t.slice(0, at) + " Away42" + t.slice(at);
            pr.edited = true;
            const put = st.put(pr, id);
            put.onsuccess = () => ok("Away42");
            put.onerror = () => fail(put.error);
          };
        };
      }),
    id,
  );
  await opened(() => p.goto(url));
  const f = await firstBuild();
  // (the words on the pages, as the core has them: on whichever page they fell)
  const on = (await text()).includes(word);
  if (!f.graphs.some((x) => x.loaded) || !(f.build.ran > 0) || !on) throw new Error(`${describe(f)}; the words ${on ? "on" : "NOT on"} the pages`);
  await saved();
  typed = await text();
  return describe(f);
});
await check("its pages are a clean build's (graphs off, reloaded: the same text)", async () => {
  await p.evaluate(() => new Promise((ok, fail) => { const o = indexedDB.open("phitex-graph"); o.onsuccess = () => { const t = o.result.transaction("kv", "readwrite"); t.objectStore("kv").put(true, "off"); t.oncomplete = () => ok(); t.onerror = () => fail(t.error); }; o.onerror = () => fail(o.error); }));
  await opened(() => p.reload());
  const f = await firstBuild();
  const clean = await text();
  if (f.graphs.some((g) => g.loaded) || clean !== typed || !clean.includes("Away42")) throw new Error(`${describe(f)}; the text ${clean === typed ? "the same" : "DIFFERS"}`);
  return describe(f);
});
await check("no exception on the page", async () => {
  if (errors.length) throw new Error(`${errors.length}:\n${errors.join("\n")}`);
});
for (const e of errors) console.log(`  ${e}`);
await b.close();
server.kill();
fs.rmSync(home, { recursive: true, force: true });
console.log(fails.length ? `${fails.length} FAILED` : "all passed");
process.exit(fails.length ? 1 : 0);
