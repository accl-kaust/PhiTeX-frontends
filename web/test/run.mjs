// The web frontend in headless Chromium, as a visitor: each sample opened,
// its first page waited for, a word typed, the keystroke-to-page time read.
//   node web/test/run.mjs   (from the worktree; web/dist built)
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";

const port = 18000 + Math.floor(Math.random() * 1000);
const server = spawn(process.execPath, ["web/test/serve.mjs", String(port)], { stdio: "inherit" });
await new Promise((r) => setTimeout(r, 400));
const env = { ...process.env, HOME: process.cwd() + "/web/test/.cache", XDG_CONFIG_HOME: process.cwd() + "/web/test/.cache/cfg", XDG_CACHE_HOME: process.cwd() + "/web/test/.cache/cache" };
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox", "--disable-crashpad", "--disable-crash-reporter"], env });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const log = [];
p.on("console", (m) => log.push(`[${m.type()}] ${m.text()}`));
p.on("pageerror", (e) => log.push(`[pageerror] ${e}`));
fs.mkdirSync("web/shots", { recursive: true });
// (a sample's pages on screen: as many slots as it has pages, each drawn)
const pagesShown = (n) => `(() => { const r = document.querySelector("phitex-preview")?.shadowRoot; const s = r ? [...r.querySelectorAll(".slot")] : []; return s.length === ${n} && s.every((x) => x.querySelector("canvas")); })()`;
const PAGES = { article: 1, beamer: 4, tikz: 1 };
const results = [];
try {
  const t0 = Date.now();
  await p.goto(`http://127.0.0.1:${port}/`);
  for (const [i, name] of ["article", "beamer", "tikz"].entries()) {
    const t = Date.now();
    if (i > 0) await p.click(`.phx-try-docs button:nth-child(${i + 1})`);
    await p.waitForFunction(pagesShown(PAGES[name]), null, { timeout: 180000 });
    const first = Date.now() - (i ? t : t0);
    await p.waitForTimeout(2500);
    await p.evaluate(() => (window.phitexLast = undefined));
    await p.click(".cm-content");
    await p.keyboard.press("Control+End");
    for (let k = 0; k < 3; k++) await p.keyboard.press("ArrowUp");
    await p.keyboard.type(" Hello", { delay: 120 });
    await p.waitForFunction(() => window.phitexLast !== undefined, null, { timeout: 30000 }).catch(() => {});
    const ms = await p.evaluate(() => window.phitexLast);
    await p.waitForTimeout(800);
    await p.screenshot({ path: `web/shots/${name}.png` });
    results.push({ name, firstPageMs: first, keystrokeMs: ms });
  }
} catch (e) {
  results.push({ error: String(e) });
  await p.screenshot({ path: "web/shots/error.png" }).catch(() => {});
}
console.log(JSON.stringify(results, null, 1));
console.log(log.filter((l) => !/\[debug\]/.test(l)).slice(-40).join("\n"));
await b.close();
server.kill();
