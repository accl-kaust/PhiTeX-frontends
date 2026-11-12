// The store's promo tiles from store/promo.html (Chromium, playwright-core):
//   node store/shots.mjs   → store/promo-small-440x280.png, store/promo-marquee-1400x560.png
import { createRequire } from "node:module";
// (playwright-core: apps/web/test's, CHECKS: npm i --no-save playwright-core there)
const { chromium } = createRequire(new URL("../apps/web/test/", import.meta.url))("playwright-core");
const b = await chromium.launch({ executablePath: process.env.PHITEX_CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox", "--disable-crashpad", "--allow-file-access-from-files"] });
for (const [w, h, name] of [[440, 280, "promo-small-440x280"], [1400, 560, "promo-marquee-1400x560"]]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.goto(new URL(`promo.html?w=${w}&h=${h}`, import.meta.url).href);
  await p.waitForFunction(() => document.body.dataset.ready === "1");
  await p.waitForTimeout(300);
  await p.screenshot({ path: new URL(`${name}.png`, import.meta.url).pathname });
}
await b.close();
