// The web frontend in headless Chromium, as a visitor: each sample opened
// and typed in (its first page's time, a keystroke's), a second file added
// and \input, a project ZIP uploaded (a figure in it), and a compare with a
// saved version. Screenshots in web/shots/.
//   node web/test/run.mjs   (from the worktree, web/dist built; network for Shelf;
//   playwright-core resolvable here, e.g. web/test/node_modules linked to an install of it)
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";

const port = 18000 + Math.floor(Math.random() * 1000);
const server = spawn(process.execPath, ["web/test/serve.mjs", String(port)], { stdio: "inherit" });
await new Promise((r) => setTimeout(r, 400));
const cache = process.cwd() + "/web/test/.cache";
const env = { ...process.env, HOME: cache, XDG_CONFIG_HOME: cache + "/cfg", XDG_CACHE_HOME: cache + "/cache" };
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox", "--disable-crashpad", "--disable-crash-reporter"], env });
const p = await b.newPage({ viewport: { width: 1360, height: 820 } });
const log = [];
p.on("console", (m) => m.type() !== "debug" && log.push(`[${m.type()}] ${m.text()}`));
p.on("pageerror", (e) => log.push(`[pageerror] ${e}`));
fs.mkdirSync("web/shots", { recursive: true });

const shadow = (js) => `(() => { const r = document.querySelector("phitex-preview")?.shadowRoot; if (!r) return false; ${js} })()`;
/** n slots, each drawn. */
const pagesShown = (n) => shadow(`const s = [...r.querySelectorAll(".slot")]; return s.length === ${n} && s.every((x) => x.querySelector("canvas"));`);
/** a word in the pages' text layer. */
const onPage = (w) => shadow(`return [...r.querySelectorAll(".slot text")].some((t) => t.textContent.includes(${JSON.stringify(w)}));`);
const results = {};
const step = async (name, f) => {
  const t = Date.now();
  try {
    results[name] = { ...(await f()), ms: Date.now() - t };
  } catch (e) {
    results[name] = { error: String(e).split("\n")[0], ms: Date.now() - t };
    await p.screenshot({ path: `web/shots/${name}-error.png` }).catch(() => {});
  }
};
/** Types `text` at the end of line `line` of the editor; the keystroke-to-page ms of its last key. */
async function typeAt(line, text) {
  await p.evaluate(() => (window.phitexLast = undefined));
  await p.click(`.cm-line >> nth=${line - 1}`);
  await p.keyboard.press("End");
  await p.keyboard.type(text, { delay: 90 });
  await p.waitForFunction(() => window.phitexLast !== undefined, null, { timeout: 30000 });
  await p.waitForTimeout(600);
  return p.evaluate(() => window.phitexLast);
}

const t0 = Date.now();
await p.goto(`http://127.0.0.1:${port}/`);
await step("article", async () => {
  await p.waitForFunction(pagesShown(1), null, { timeout: 180000 });
  const cold = Date.now() - t0;
  await p.waitForTimeout(2500);
  const st = () => p.evaluate(shadow(`return r.getElementById("sttext").textContent + " " + (r.getElementById("stmore")?.textContent ?? "")`));
  const statusFirst = await st();
  const tipShown = await p.locator("phitex-preview #tip").isVisible().catch(() => false);
  const firstBuild = await p.evaluate(() => window.phitexFirst);
  const key = await typeAt(28, " Typed here.");
  const statusAfter = await st();
  await p.screenshot({ path: "web/shots/article.png" });
  return { coldFirstPageMs: cold, onBuildFirstMs: firstBuild, statusFirst, tipShown, keystrokeMs: key, statusAfter };
});
for (const [i, name, n, line] of [[1, "beamer", 4, 17], [2, "tikz", 1, 23]]) {
  await step(name, async () => {
    const t = Date.now();
    await p.evaluate((i) => window.phitex.setDoc(i), i);
    await p.waitForFunction(pagesShown(n), null, { timeout: 180000 });
    const first = Date.now() - t;
    await p.waitForTimeout(2500);
    const key = await typeAt(line, " Typed here.");
    await p.screenshot({ path: `web/shots/${name}.png` });
    return { firstPageMs: first, keystrokeMs: key };
  });
}
await step("multifile", async () => {
  await p.evaluate(() => window.phitex.setDoc(0));
  await p.waitForFunction(pagesShown(1), null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.click(".phx-tree-head [data-act=new]");
  await p.fill(".phx-tree-name input", "intro.tex");
  await p.press(".phx-tree-name input", "Enter");
  await p.click(".cm-content");
  await p.keyboard.type("\\section{Second file} Wordfromintro is here.", { delay: 20 });
  await p.click('.phx-tree-list li[data-path="main.tex"] .name');
  const lines = await p.locator(".cm-line").count();
  await p.click(`.cm-line >> nth=${lines - 3}`);
  await p.keyboard.press("End");
  await p.keyboard.type("\n\\input{intro}", { delay: 40 });
  await p.waitForFunction(onPage("Wordfromintro"), null, { timeout: 60000 });
  // (settled: the status once the last keystroke's build is in, not mid-typing)
  await p.waitForTimeout(4000);
  await p.screenshot({ path: "web/shots/multifile.png" });
  const status = await p.evaluate(shadow(`return (r.getElementById("sttext")?.textContent ?? "") + " | problems: " + (r.getElementById("pcount")?.textContent ?? "")`));
  return { inputShown: true, files: await p.locator(".phx-tree-list li").count(), status };
});
await step("zip", async () => {
  await p.click("[data-menu=new]");
  await p.setInputFiles("[data-pop=new] input[type=file]", "web/test/fixture.zip");
  await p.waitForFunction(onPage("Uploadedpart"), null, { timeout: 90000 });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: "web/shots/zip.png" });
  return { files: await p.locator(".phx-tree-list li").allTextContents() };
});
await step("compare", async () => {
  // (the panel's Compare: the versions' dialog; a version saved there)
  await p.click("phitex-preview #b-compare");
  await p.fill(".phx-save input", "Before");
  await p.press(".phx-save input", "Enter");
  await p.waitForTimeout(500);
  await p.click('.phx-tree-list li[data-path="sections/part.tex"] .name');
  await p.click(".cm-line >> nth=0");
  await p.keyboard.press("End");
  await p.keyboard.type(" Addedwords now.", { delay: 40 });
  await p.waitForFunction(onPage("Addedwords"), null, { timeout: 60000 });
  await p.click("phitex-preview #b-compare");
  await p.click(".phx-versions button[data-v]");
  await p.waitForFunction(shadow(`const d = r.getElementById("diffbar"); return !!d && /\\d+ change/.test(d.textContent) && !/Diffing|Fetching|Typesetting/.test(d.textContent);`), null, { timeout: 120000 });
  await p.waitForTimeout(4000);
  const bar = await p.evaluate(() => document.querySelector("phitex-preview").shadowRoot.getElementById("diffbar").textContent);
  await p.screenshot({ path: "web/shots/compare.png" });
  return { diffbar: bar };
});
await step("log", async () => {
  // (the panel's first-visit tips dismissed, then its ⋯ › View log)
  const skip = p.locator('phitex-preview #tip button:has-text("Skip")');
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await p.click("phitex-preview #b-more");
  await p.click("phitex-preview #x-log");
  await p.waitForFunction(shadow(`return (r.getElementById("logtext")?.textContent ?? "").length > 200`), null, { timeout: 30000 });
  const t = await p.evaluate(shadow(`return r.getElementById("logtext").textContent`));
  await p.screenshot({ path: "web/shots/log.png" });
  await p.click("phitex-preview #logview [data-close]");
  return { logChars: t.length, head: t.slice(0, 60) };
});
await step("dark", async () => {
  await p.click("phitex-preview #b-more");
  await p.click('phitex-preview #darkpdf [data-dark="on"]');
  await p.keyboard.press("Escape");
  await p.waitForTimeout(800);
  await p.screenshot({ path: "web/shots/dark.png" });
  return {};
});
await step("narrow", async () => {
  await p.setViewportSize({ width: 420, height: 820 });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: "web/shots/narrow.png" });
  return {};
});
console.log(JSON.stringify(results, null, 1));
console.log(log.slice(-30).join("\n"));
await b.close();
server.kill();
