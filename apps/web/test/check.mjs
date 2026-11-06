// The demo's check (PhiTeX's release gate and its nightly): the web frontend
// in headless Chromium as a visitor opens it: the first sample's first page
// drawn from its PDF, words typed into its source on the page within a
// minute, and no exception or console error on the page or in its workers.
//   node apps/web/test/check.mjs            build/web (tools/build/build-web.sh) served here
//   node apps/web/test/check.mjs URL        a deployed one (the nightly: https://demo.phitex.org/), read only
// PHITEX_CHROME: the browser (default /usr/bin/chromium). playwright-core
// resolvable here (CI: npm i --no-save playwright-core). Exits 1 on a failure.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";

const given = process.argv[2];
let server, url = given;
if (!given) {
  const port = 18000 + Math.floor(Math.random() * 1000);
  server = spawn(process.execPath, ["apps/web/test/serve.mjs", String(port)], { stdio: "inherit" });
  await new Promise((r) => setTimeout(r, 400));
  url = `http://127.0.0.1:${port}/`;
}
const home = fs.mkdtempSync("/tmp/phitex-check-");
const b = await chromium.launch({ executablePath: process.env.PHITEX_CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox", "--disable-crashpad", "--disable-crash-reporter"], env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home } });
const p = await b.newPage({ viewport: { width: 1360, height: 820 } });
const errors = [];
p.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text().slice(0, 400)}`));
p.on("pageerror", (e) => errors.push(`exception: ${String(e).slice(0, 400)}`));
p.on("worker", (w) => w.on("console", (m) => m.type() === "error" && errors.push(`worker: ${m.text().slice(0, 400)}`)));
const shadow = (js) => `(() => { const r = document.querySelector("phitex-preview")?.shadowRoot; if (!r) return false; ${js} })()`;
const fails = [];
const check = async (what, f) => {
  const t = Date.now();
  try {
    await f();
    console.log(`ok ${what} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } catch (e) {
    fails.push(what);
    console.log(`FAIL ${what}: ${String(e).split("\n")[0]}`);
  }
};
await check("the demo opens", async () => {
  await p.goto(url);
  await p.waitForFunction(() => window.phitex, null, { timeout: 60000 });
});
await check("a PDF's first page is drawn", async () => {
  await p.waitForFunction(shadow(`return !r.querySelector(".win").classList.contains("sheet-up") && !!r.querySelector(".slot svg.page, .slot canvas")`), null, { timeout: 300000 });
  // (from a PDF: the session has one, its header and end)
  const pdf = await p.evaluate(async () => { const s = globalThis.__phitexSession; const b = s && (await s.pdf?.()); return b ? [b.length, String.fromCharCode(...b.subarray(0, 5)), String.fromCharCode(...b.subarray(b.length - 6)).trim()] : null; });
  if (!pdf || pdf[1] !== "%PDF-" || !pdf[2].endsWith("%%EOF")) throw new Error(`not a PDF: ${JSON.stringify(pdf)}`);
  console.log(`  the PDF: ${pdf[0]} bytes`);
});
await check("an edit is on the page", async () => {
  // (the cursor at the end of the first line of words in the body, through the editor's view, then typed as keys)
  await p.evaluate(() => {
    const c = document.querySelector(".cm-content");
    const view = c.cmView?.view ?? c.cmTile?.view ?? c.cmView?.rootView?.view;
    const t = view.state.doc.toString(), body = t.indexOf("\\begin{document}");
    const m = /\n([A-Za-z][^\\%\n]{20,})\n/.exec(t.slice(body));
    if (!m) throw new Error("no line of words in the sample");
    view.dispatch({ selection: { anchor: body + m.index + 1 + m[1].length } });
    view.focus();
  });
  await p.keyboard.type(" Checkedword", { delay: 60 });
  await p.waitForFunction(shadow(`return [...r.querySelectorAll(".slot text")].some((t) => t.textContent.includes("Checkedword"))`), null, { timeout: 60000 });
});
fs.mkdirSync("apps/web/shots", { recursive: true });
await p.screenshot({ path: "apps/web/shots/check.png" }).catch(() => {});
await p.waitForTimeout(1500);
await check("no exception or console error", async () => {
  if (errors.length) throw new Error(`${errors.length}:\n${errors.join("\n")}`);
});
for (const e of errors) console.log(`  ${e}`);
await b.close();
server?.kill();
process.exit(fails.length ? 1 : 0);
