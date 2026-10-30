// Examples opened one after another in one tab (one core), each until its first page: its time, the sheet's last step and the panel's status (debugging a sample, an engine switch)
//   node web/test/one.mjs NAME[,NAME…] [--fresh]   (--fresh: the first as a new core's first, the page reloaded with it open)
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
const names = (process.argv[2] ?? "Languages").split(",");
const port = 19000 + Math.floor(Math.random() * 1000);
const server = spawn(process.execPath, ["web/test/serve.mjs", String(port)], { stdio: "inherit" });
await new Promise((r) => setTimeout(r, 400));
const home = process.cwd() + "/web/test/.one";
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox", "--disable-crashpad", "--disable-crash-reporter"], env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home } });
const p = await b.newPage({ viewport: { width: 1360, height: 820 } });
p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && console.log(`[error] ${m.text().slice(0, 300)}`));
await p.goto(`http://127.0.0.1:${port}/`);
await p.waitForFunction(() => window.phitex);
const index = (w) => p.evaluate((w) => [...document.querySelectorAll("#phx-proj optgroup[label=Examples] option")].findIndex((o) => o.textContent === w), w);
const state = () =>
  p.evaluate(() => {
    const r = document.querySelector("phitex-preview").shadowRoot;
    return { up: r.querySelector(".win").classList.contains("sheet-up"), what: r.querySelector("#opening .what")?.textContent, detail: r.querySelector("#opening .detail")?.textContent, status: r.getElementById("sttext").textContent + " " + r.getElementById("stmore").textContent, pages: r.querySelectorAll(".slot canvas, .slot svg.page").length };
  });
let ok = true;
for (const [n, want] of names.entries()) {
  await p.evaluate((i) => window.phitex.setDoc(i), await index(want));
  if (n === 0 && process.argv.includes("--fresh")) {
    await p.waitForTimeout(1500);
    await p.reload();
    await p.waitForFunction(() => window.phitex);
  }
  const t = Date.now();
  await p.waitForTimeout(300);
  let st;
  for (let s = 0; s < 240; s += 5) {
    st = await state();
    if (!st.up && st.pages) break;
    await p.waitForTimeout(5000);
  }
  const done = !st.up && st.pages > 0;
  ok &&= done;
  console.log(`${want}: ${done ? `first page in ${((Date.now() - t) / 1000).toFixed(1)} s` : "NO PAGE in 240 s"} ${JSON.stringify(st)}`);
  await p.screenshot({ path: `web/shots/one-${n}-${want.toLowerCase()}.png` });
}
await b.close();
server.kill();
process.exit(ok ? 0 : 1);
