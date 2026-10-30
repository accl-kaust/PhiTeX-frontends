// /try's first visit on the dev server: the project picker's tip, light and dark, as screenshots (web/shots/tip-*.png)
import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox", "--disable-crashpad", "--disable-crash-reporter"], env: { ...process.env, HOME: process.cwd() + "/web/test/.home", XDG_CONFIG_HOME: process.cwd() + "/web/test/.home", XDG_CACHE_HOME: process.cwd() + "/web/test/.home" } });
for (const scheme of ["light", "dark"]) {
  const p = await b.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
  await p.goto(process.argv[2] ?? "http://127.0.0.1:5176/try");
  await p.waitForSelector(".phx-tip", { timeout: 120000 });
  for (const t of [400, 2600]) {
    await p.waitForTimeout(t === 400 ? 400 : 2200);
    await p.screenshot({ path: `web/shots/tip-${scheme}-${t}.png`, clip: { x: 0, y: 0, width: 520, height: 420 } });
  }
  await p.close();
}
await b.close();
