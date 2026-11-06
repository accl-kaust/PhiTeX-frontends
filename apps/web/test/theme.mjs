// /try's look in light, dark, the system's dark, and the page's toggle clicked live, as screenshots in web/shots/theme-*.png:
//   node web/test/theme.mjs [url]   (the site's page has its toggle, #theme; web/index.html alone: data-theme set as the toggle sets it)
import { chromium } from "playwright-core";
const url = process.argv[2] ?? "http://127.0.0.1:5176/try";
const cache = process.cwd() + "/web/test/.cache";
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox", "--disable-crashpad", "--disable-crash-reporter"], env: { ...process.env, HOME: cache, XDG_CONFIG_HOME: cache + "/cfg", XDG_CACHE_HOME: cache + "/cache" } });

/** The page's toggle, as the site's ui.ts does it when there is no button. */
const toggle = (p) =>
  p.evaluate(() => {
    const button = document.getElementById("theme");
    if (button) return button.click();
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
  });
/** What is dark: the app's background, the editor's, the panel's bar. */
const look = (p) =>
  p.evaluate(() => {
    const bg = (e) => (e ? getComputedStyle(e).backgroundColor : "none");
    const bar = document.querySelector("phitex-preview")?.shadowRoot?.querySelector(".bar");
    return { theme: document.documentElement.dataset.theme ?? "(system)", app: bg(document.querySelector(".phx-web")), editor: bg(document.querySelector(".cm-editor")), panel: bg(bar) };
  });

for (const scheme of ["light", "dark"]) {
  const c = await b.newContext({ viewport: { width: 1400, height: 860 }, colorScheme: scheme });
  const p = await c.newPage();
  p.on("pageerror", (e) => console.log("pageerror", e.message));
  await p.goto(url);
  await p.waitForFunction(() => document.querySelector("phitex-preview")?.shadowRoot?.querySelector("canvas"), null, { timeout: 90000 });
  await p.waitForTimeout(1500);
  await p.evaluate(() => {
    const ed = document.querySelector(".cm-content");
    const r = document.createRange();
    r.selectNodeContents(ed.querySelectorAll(".cm-line")[3] ?? ed);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  console.log(`system ${scheme}`, await look(p));
  await p.screenshot({ path: `web/shots/theme-system-${scheme}.png` });
  await toggle(p);
  await p.waitForTimeout(400);
  console.log(`system ${scheme}, toggled`, await look(p));
  await p.screenshot({ path: `web/shots/theme-system-${scheme}-toggled.png` });
  await toggle(p);
  await p.waitForTimeout(400);
  console.log(`system ${scheme}, toggled back`, await look(p));
  await p.screenshot({ path: `web/shots/theme-system-${scheme}-back.png` });
  // the Versions dialog, in this look
  await p.locator("phitex-preview #b-compare").click();
  await p.waitForSelector(".phx-save input", { timeout: 10000 });
  await p.locator(".phx-save input").focus();
  await p.screenshot({ path: `web/shots/theme-system-${scheme}-versions.png` });
  await c.close();
}
await b.close();
