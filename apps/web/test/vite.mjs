// /try through PhiTeX.org's vite dev server, as the site's page mounts it (mount(el, {})), fresh profile; workers' consoles too.
import { chromium } from "playwright-core";
const url = process.argv[2] ?? "http://127.0.0.1:5176/try";
const cache = process.cwd() + "/web/test/.cache";
const b = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox", "--disable-crashpad", "--disable-crash-reporter"], env: { ...process.env, HOME: cache, XDG_CONFIG_HOME: cache + "/cfg", XDG_CACHE_HOME: cache + "/cache" } });
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
p.on("console", (m) => console.log(at(), "page", m.type(), m.text().slice(0, 300)));
p.on("pageerror", (e) => console.log(at(), "pageerror", e.stack?.slice(0, 400)));
p.on("requestfailed", (r) => console.log(at(), "failed", r.url(), r.failure()?.errorText));
p.on("response", (r) => /\.(wasm|gzdata|pack|js)(\?|$)/.test(r.url()) && console.log(at(), "resp", r.status(), r.url().replace(/^https?:\/\/[^/]+/, "")));
p.on("worker", (w) => {
  console.log(at(), "worker", w.url());
  w.on("console", (m) => console.log(at(), "worker console", m.type(), m.text().slice(0, 300)));
  w.on("close", () => console.log(at(), "worker closed", w.url()));
});
await p.goto(url);
await p.waitForTimeout(+(process.env.WAIT ?? 40000));
console.log(await p.evaluate(() => { const r = document.querySelector("phitex-preview")?.shadowRoot; return { iso: crossOriginIsolated, status: r?.getElementById("sttext")?.textContent, files: document.querySelectorAll(".phx-tree-list li").length, problems: [...(r?.querySelectorAll("#diags *") ?? [])].map((e) => e.textContent).filter(Boolean).slice(0, 4).join(" || ").slice(0, 600) }; }));
await p.screenshot({ path: "web/shots/vite-try.png" });
await b.close();
