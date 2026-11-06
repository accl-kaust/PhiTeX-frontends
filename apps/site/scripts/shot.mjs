// Screenshots of the built site (dist/), for design review.
//   scripts/sandbox node scripts/shot.mjs [outdir]
import { chromium } from "playwright-core";
import { createServer } from "vite";
const out = process.argv[2] ?? ".cache/shots";
const server = await (await import("vite")).preview({ preview: { port: 4173, host: "127.0.0.1" } });
const url = "http://127.0.0.1:4173/";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
for (const [name, vp, scheme] of [["desk-dark", { width: 1440, height: 900 }, "dark"], ["desk-light", { width: 1440, height: 900 }, "light"], ["phone", { width: 390, height: 844 }, "dark"]]) {
  const page = await browser.newPage({ viewport: vp, colorScheme: scheme, deviceScaleFactor: 1 });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await page.goto(url);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/${name}-hero.png` });
  // scroll through so reveals fire, then a full page
  const h = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < h; y += 500) { await page.evaluate((y) => scrollTo(0, y), y); await page.waitForTimeout(120); }
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/${name}-full.png`, fullPage: true });
  console.log(name, errs.length ? errs : "no errors");
  await page.close();
}
await browser.close();
server.httpServer.close();
