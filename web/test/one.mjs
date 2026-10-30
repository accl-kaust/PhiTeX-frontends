// One example opened cold, alone, in a fresh profile: its first page's time, the sheet's last step and the panel's status (debugging a sample)
//   node web/test/one.mjs NAME [--fresh]
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
const want = process.argv[2] ?? "Languages";
const port = 19000 + Math.floor(Math.random() * 1000);
const server = spawn(process.execPath, ["web/test/serve.mjs", String(port)], { stdio: "inherit" });
await new Promise((r) => setTimeout(r, 400));
const home = process.cwd() + "/web/test/.one";
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox", "--disable-crashpad", "--disable-crash-reporter"], env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home } });
const p = await b.newPage({ viewport: { width: 1360, height: 820 } });
p.on("console", (m) => /error|warn/.test(m.type()) && console.log(`[${m.type()}] ${m.text().slice(0, 300)}`));
await p.goto(`http://127.0.0.1:${port}/`);
await p.waitForFunction(() => window.phitex);
const i = await p.evaluate((w) => [...document.querySelectorAll("#phx-proj optgroup[label=Examples] option")].findIndex((o) => o.textContent === w), want);
await p.evaluate((i) => window.phitex.setDoc(i), i);
// (--fresh: the page reloaded with it as the open project, so a new core opens it first, not after the article)
if (process.argv.includes("--fresh")) {
  await p.waitForTimeout(1500);
  await p.reload();
  await p.waitForFunction(() => window.phitex);
}
const t = Date.now();
const R = `document.querySelector("phitex-preview").shadowRoot`;
for (let s = 0; s < 240; s += 5) {
  await p.waitForTimeout(5000);
  const st = await p.evaluate((R) => { const r = eval(R); return { up: r.querySelector(".win").classList.contains("sheet-up"), what: r.querySelector("#opening .what")?.textContent, detail: r.querySelector("#opening .detail")?.textContent, status: r.getElementById("sttext").textContent + " " + r.getElementById("stmore").textContent, pages: r.querySelectorAll(".slot canvas, .slot svg.page").length }; }, R);
  console.log(Math.round((Date.now() - t) / 1000) + " s", JSON.stringify(st));
  if (!st.up && st.pages) break;
}
await p.screenshot({ path: `web/shots/one-${want.toLowerCase()}.png` });
await b.close();
server.kill();
