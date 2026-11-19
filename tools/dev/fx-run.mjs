// The extension in Firefox, on the local mock, for debugging the Firefox
// build: installs it as a temporary add-on over WebDriver BiDi, writes the
// onboarded state (tools/dev/onboarded.mjs: no clicking through the terms or
// the tour), opens the mock project, waits for the ⚡ pages, screenshots.
//
//   tools/build/package.sh                      # build/phitex-instant-<v>-firefox.zip
//   tools/dev/fx-run.mjs [--wait 30] [--url http://localhost:8123/project/mock] [--shot out.png]
//   tools/dev/fx-run.mjs test/scenarios/fx.json  # a scenario: the run fails (exit 1) on any step
//
// SCENARIO.json (Firefox's checks: what goes through `content.fetch`, the
// page's fetch, which Chromium's mock-run.mjs never runs):
//   { "name": "fx", "project": "test/scenarios/fx", "history": "test/scenarios/fx-history.json",
//     "steps": [
//       { "compare": 1, "has": ["\\DIFcite"], "ms": 60000 }, // Changes' Diff from version 1 (its history, as
//                  // clicked), until the diff bar counts changes; diff.tex has each regex, else fails
//       { "replacefile": "fig.png", "b64": "…", "ms": 60000 }, // the file replaced as Overleaf says it
//                  // is; until the session's PDF changes, else the run fails
//       { "wait": 1000 },
//       { "settings": { "viewPrefs": { "opening": "badapple" } } }, // the extension's settings changed
//       { "start": { "zip": "hold", "pane": "late" }, "stage": "^Downloading" }, // the tab's start again (the mock's
//                  // zipmode; Overleaf's PDF pane laid out late), until the start's step matches
//       { "eval": "mockShowPane()" }, { "check": "expr", "is": true }, // the page's world
//       { "moving": "#opening .sheet", "is": true }, // the panel's element on screen, its pixels changing
//       { "zipmode": "ok", "until": "expr" }, // the mock's downloads answer so from here (a held one sent whole)
//       { "shot": "name" } ] }               // target/fx-run-<name>-<shot>.png
// A scenario starts the mock itself (its own port, the scenario's project
// and history), headless, and the project's first page is its first check:
// a start that fails (its card's error) fails the run.
//
// Needs: Firefox (138+) on PATH; without a scenario, the mock running
// (tools/sandbox --net node tools/mock/server.mjs). The add-on is the Firefox
// package, unzipped into target/fx-dev/ with the mock's address added to
// its matches (the store package matches overleaf.com only). Firefox runs
// with its own profile in target/fx-profile/ and stays open after
// (--close to quit it), so a second run reuses it. PHITEX_RUN=n: a run
// beside another, on its own port, profile and add-on folder.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { onboardScript, traceScript } from "./onboarded.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const scFile = args.find((a, i) => a.endsWith(".json") && !(i > 0 && args[i - 1].startsWith("--")));
const sc = scFile ? JSON.parse(fs.readFileSync(scFile, "utf8")) : null;
const RUN = +(process.env.PHITEX_RUN ?? 0);
const PORT = 9224 + 10 * RUN;
const MOCK = 8143 + RUN;
const url = sc ? `http://localhost:${MOCK}/project/mock` : opt("--url", "http://localhost:8123/project/mock");
const wait = +opt("--wait", sc ? "90" : "30") * 1000;
const shot = opt("--shot", path.join(root, sc ? `target/fx-run-${sc.name ?? "run"}.png` : "target/fx-run.png"));
const tag = RUN ? `-${RUN}` : "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the Firefox package, with the mock's address
const version = JSON.parse(fs.readFileSync(path.join(root, "build/overleaf/manifest.json"))).version;
const zip = path.join(root, `build/phitex-instant-${version}-firefox.zip`);
if (!fs.existsSync(zip)) throw new Error(`${zip}: run tools/build/package.sh first`);
const dev = path.join(root, `target/fx-dev${tag}`);
fs.rmSync(dev, { recursive: true, force: true });
fs.mkdirSync(dev, { recursive: true });
execFileSync("unzip", ["-q", zip, "-d", dev]);
const m = JSON.parse(fs.readFileSync(path.join(dev, "manifest.json")));
for (const c of m.content_scripts) c.matches.push("http://localhost/project/*");
m.web_accessible_resources[0].matches.push("http://localhost/*");
fs.writeFileSync(path.join(dev, "manifest.json"), JSON.stringify(m, null, 1));

// (a scenario's mock: its project and history, on a port of its own)
let mock;
if (sc) {
  try { execFileSync("pkill", ["-f", `^node tools/mock/server.mjs ${MOCK}$`]); } catch {}
  mock = spawn("node", ["tools/mock/server.mjs", String(MOCK)], { cwd: root, env: { ...process.env, MOCK_PROJECT: path.resolve(sc.project ?? "tools/mock/project"), ...(sc.history ? { MOCK_HISTORY: path.resolve(sc.history) } : {}) }, stdio: ["ignore", "pipe", "inherit"], detached: true });
  await new Promise((r) => mock.stdout.once("data", r));
}

// Firefox with remote debugging (BiDi), started unless already listening
const up = async () => fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false);
if (!(await up())) {
  const profile = path.join(root, `target/fx-profile${tag}`);
  fs.mkdirSync(profile, { recursive: true });

  // (PHITEX_FXLOG=file: every console, the background page's and its workers' too, mirrored to Firefox's stdout, kept there)
  const log = process.env.PHITEX_FXLOG;
  if (log) fs.writeFileSync(path.join(profile, "user.js"), 'user_pref("devtools.console.stdout.content", true);\nuser_pref("devtools.console.stdout.chrome", true);\nuser_pref("browser.dom.window.dump.enabled", true);\n');
  const out = log ? fs.openSync(log, "a") : "ignore";
  // (no --no-remote: Firefox 157 then starts no profile, "Could not find profile folder", and no BiDi;
  // a scenario's Firefox is headless)
  spawn("firefox", ["--profile", profile, ...(sc || process.env.PHITEX_HEADLESS ? ["--headless"] : []), "--remote-debugging-port", String(PORT), "about:blank"], { detached: true, stdio: ["ignore", out, out] }).unref();
  for (let i = 0; i < 40 && !(await up()); i++) await sleep(250);
}

console.log(`Firefox on :${PORT}, ${dev}`);
// (Node's WebSocket keeps no handle open: without this the run exits while it waits)
setInterval(() => {}, 1 << 30);
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/session`);
let id = 0;
const pend = new Map();
ws.onmessage = (e) => {
  const r = JSON.parse(e.data);
  if (r.id && pend.has(r.id)) (pend.get(r.id)(r), pend.delete(r.id));
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pend.set(i, (r) => (r.type === "error" ? rej(new Error(`${method}: ${r.error}: ${r.message}`)) : res(r.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = () => j(new Error(`no WebDriver BiDi on :${PORT}`)))));
// (Firefox allows one session; one a crashed run left: its Firefox quit, run again)
const logs = [];
ws.addEventListener("message", (e) => {
  const d = JSON.parse(e.data);
  if (d.method === "log.entryAdded" && /error|warn/.test(d.params.level)) logs.push(`${d.params.level}: ${d.params.text}`.slice(0, 400));
});
await send("session.new", { capabilities: {} }).catch((e) => {
  if (/Maximum number of active sessions/.test(e.message)) {
    try { execFileSync("pkill", ["-f", "--", `--profile ${path.join(root, `target/fx-profile${tag}`)}( |$)`]); } catch {}
    console.error("fx-run: a stale session held Firefox; it was quit: run again");
    process.exit(2);
  }
  throw e;
});
try {
  await send("session.subscribe", { events: ["log.entryAdded"] });
  const { extension } = await send("webExtension.install", { extensionData: { type: "path", path: dev } });
  const ctx = (await send("browsingContext.getTree", {})).contexts[0].context;
  const ev = async (expression) => (await send("script.evaluate", { expression, target: { context: ctx }, awaitPromise: true })).result?.value;

  // the onboarded state (tools/dev/onboarded.mjs), then the project again
  await send("browsingContext.navigate", { context: ctx, url, wait: "complete" });
  await sleep(1500);
  console.log("storage:", await ev(onboardScript(version, sc?.storage ?? {})));
  await send("browsingContext.reload", { context: ctx, wait: "complete" });
  const t0 = Date.now();
  let pages = "";
  while (Date.now() - t0 < wait) {
    await sleep(1000);
    pages = await ev(`(() => { const r = document.querySelector('phitex-preview')?.shadowRoot; return r ? r.querySelectorAll('.slot').length + ' pages, ' + r.querySelectorAll('.slot > *:not(.mark)').length + ' drawn' : 'no preview'; })()`);
    if (/^[1-9]\d* pages, [1-9]/.test(pages)) break;
  }
  console.log(`${pages} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (sc) await scenario(ev, pages, ctx);
  // (the timing popover's words: the first page's time by step)
  console.log("timing:", await ev(`(async () => { const r = document.querySelector('phitex-preview')?.shadowRoot; if (!r) return '-'; r.querySelector('#st')?.click(); await new Promise((f) => setTimeout(f, 300)); const t = r.querySelector('#m-time')?.innerText.replace(/\\s+/g, ' ').trim() ?? '-'; r.querySelector('#st')?.click(); return t; })()`));
  // (--frame-eval EXPR: EXPR in the tab's engine iframe (engine.html: the extension's origin), its value said)
  if (args.includes("--frame-eval")) {
    const kids = (c) => [c, ...(c.children ?? []).flatMap(kids)];
    const all = (await send("browsingContext.getTree", { root: ctx })).contexts.flatMap(kids);
    const frame = all.find((c) => c.url.endsWith("/engine.html"));
    const r = frame ? await send("script.evaluate", { expression: args[args.indexOf("--frame-eval") + 1], target: { context: frame.context }, awaitPromise: true }).catch((e) => ({ result: { value: String(e) } })) : { result: { value: "no engine iframe" } };
    console.log("frame-eval:", JSON.stringify(r.result?.value ?? r.exceptionDetails ?? r).slice(0, 1500));
  }
  // (--dev: the content script's dev log, the trace's tail and its errors (a localhost page's: content-main.ts devMark))
  if (args.includes("--dev")) console.log("dev:", await ev(`new Promise((f) => { addEventListener("message", (e) => e.data?.type === "traced" && f(e.data.trace)); setTimeout(() => f("none"), 3000); postMessage({ src: "phitex-dev", type: "trace" }, location.origin); })`));
  // (--report FILE: the panel's debug report (its trace, the workers' console), as "Report a problem…" gives it)
  if (args.includes("--report")) {
    const text = await ev(`(async () => { const r = document.querySelector('phitex-preview')?.shadowRoot; if (!r) return ''; window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e' })); await new Promise((f) => setTimeout(f, 500)); r.querySelector('.reportbtn')?.click(); for (let i = 0; i < 50 && !r.querySelector('#reporttext')?.value; i++) await new Promise((f) => setTimeout(f, 100)); return r.querySelector('#reporttext')?.value ?? ''; })()`);
    fs.writeFileSync(args[args.indexOf("--report") + 1], text ?? "");
    console.log("report:", args[args.indexOf("--report") + 1], `${(text ?? "").length} chars`);
  }
  // (the panel's diagnostics and the page's console errors: why, when no pages)
  console.log("diagnostics:", await ev(`(() => { const r = document.querySelector('phitex-preview')?.shadowRoot; return r ? [...r.querySelectorAll('.diag')].map((d) => d.innerText.replace(/\\s+/g, ' ').slice(0, 300)).join(' | ') || '(none)' : '-'; })()`));
  for (const l of logs.slice(-15)) console.log("console:", l);
  if (!/^[1-9]/.test(pages)) console.log("content script:", (await ev(traceScript())).slice(0, 4000));
  const s = await send("browsingContext.captureScreenshot", { context: ctx });
  fs.writeFileSync(shot, Buffer.from(s.data, "base64"));
  console.log("screenshot:", shot);
} catch (e) {
  console.error("fx-run:", e.message);
  if (sc) console.error("FAILED");
  process.exitCode = 1;
} finally {
  await send("session.end", {}).catch(() => {});
  if (mock) process.kill(-mock.pid);
  if (args.includes("--close") || sc) execFileSync("pkill", ["-f", "--", `--profile ${path.join(root, `target/fx-profile${tag}`)}( |$)`]);
  process.exit(process.exitCode ?? 0);
}

/** The content script's state (content-main.ts, localhost only): the PDF's hash, a compare's diff.tex, the start's errors. */
function stateScript() {
  return `new Promise((ok) => { const on = (e) => { if (e.data?.src === "phitex-dev" && e.data.type === "stated") (removeEventListener("message", on), ok(e.data.state)); }; addEventListener("message", on); postMessage({ src: "phitex-dev", type: "state" }, location.origin); setTimeout(() => ok("null"), 5000); })`;
}

/** A scenario's steps, after its first page (the first check): each that fails throws. */
async function scenario(ev, pages, ctx) {
  const state = async () => JSON.parse(await ev(stateScript()));
  const shadow = `document.querySelector('phitex-preview')?.shadowRoot`;
  if (!/^[1-9]\d* pages, [1-9]/.test(pages)) {
    const st = await state();
    throw new Error(`the project didn't open: ${pages}; ${st ? `${st.stage}; ${st.errors.join(" | ")}` : "no content script"}`);
  }
  for (const s of sc.steps ?? []) {
    const t = Date.now();
    if (s.wait !== undefined) await sleep(s.wait);
    else if (s.compare !== undefined) {
      // (Changes' Diff from version N to the editor's text, as clicked: its history read from Overleaf (the
      // page's fetch), the version's ZIP, the diff)
      const C = `${shadow}?.querySelector('#chg')?.shadowRoot`;
      const row = `.phx-commits .row[data-id="v${s.compare}"]`;
      if (!(await ev(`!!${C}?.querySelector('.chg-pop:not([hidden])')`))) await ev(`document.getElementById('phitex-changes').click()`);
      await ev(`(() => { const b = ${C}?.querySelector('[data-m=diff]'); if (b?.getAttribute('aria-pressed') !== 'true') b?.click(); return 1; })()`);
      await sleep(300);
      await ev(`${C}?.querySelector('#chg-from')?.click()`);
      let listed = false;
      for (; !listed && Date.now() - t < 30000; await sleep(300)) listed = await ev(`!!${C}?.querySelector('${row}')`);
      if (!listed) throw new Error(`compare ${s.compare}: not in the history: ${await ev(`${C}?.querySelector('.chg-pop')?.innerText.replace(/\\s+/g, ' ')`)}`);
      await ev(`${C}.querySelector('${row}').click()`);
      await sleep(200);
      await ev(`${C}.querySelector('.phx-commits .row:not([data-i]):not(.skel)').click()`);
      let bar = "";
      for (; Date.now() - t < (s.ms ?? 60000); await sleep(300)) {
        bar = await ev(`(() => { const R = ${C}; const p = R?.querySelector('.prog'); const f = R?.querySelector('.foot [aria-live]'); return p && !p.hidden ? 'busy: ' + p.innerText : f ? f.textContent : ''; })()`);
        if (/^busy: Couldn't/.test(bar) || (bar && !bar.startsWith("busy") && bar !== "…")) break;
      }
      if (!bar || bar.startsWith("busy")) throw new Error(`compare ${s.compare}: ${bar || "no count"}`);
      const tex = (await state()).diffTex ?? "";
      const missing = (s.has ?? []).filter((r) => !new RegExp(r).test(tex));
      const extra = (s.hasnt ?? []).filter((r) => new RegExp(r).test(tex));
      const kept = path.join(root, `target/fx-run-${sc.name ?? "run"}-diff.tex`);
      fs.writeFileSync(kept, tex);
      if (/^0 changes/.test(bar) || missing.length || extra.length) throw new Error(`compare ${s.compare}: "${bar}"; diff.tex (${kept}) lacks ${JSON.stringify(missing)}, has ${JSON.stringify(extra)}`);
      console.log(`compare ${s.compare}: ${bar}, diff.tex ${tex.length} chars, has ${JSON.stringify(s.has ?? [])}`);
      await ev(`${C}.querySelector('#chg-x').click()`);
    } else if (s.replacefile !== undefined) {
      // (a figure replaced in Overleaf: its socket says so, the content script reads it again (the page's fetch))
      const was = (await state()).pdf;
      await fetch(`http://localhost:${MOCK}/project/mock/replace?path=${encodeURIComponent(s.replacefile)}`, { method: "POST", body: Buffer.from(s.b64, "base64") });
      let now = was;
      for (; now === was && Date.now() - t < (s.ms ?? 60000); await sleep(300)) now = (await state()).pdf;
      if (now === was) throw new Error(`replacefile ${s.replacefile}: the PDF unchanged (${was}); ${(await state()).errors.join(" | ")}`);
      console.log(`replacefile ${s.replacefile}: the PDF changed (${was} to ${now})`);
    } else if (s.settings !== undefined) {
      // (the extension's settings changed, as Settings or the popup changes them: a "start" after reads them all)
      await ev(`new Promise((ok) => { addEventListener("message", (e) => e.data?.src === "phitex-dev" && e.data.type === "onboarded" && ok()); postMessage({ src: "phitex-dev", type: "onboard", storage: ${JSON.stringify(s.settings)} }, location.origin); })`);
    } else if (s.start !== undefined) {
      // (the tab's start again: failing as `failure` asks (content-main.ts testFailure), the mock's
      // downloads answering as `zip` asks (tools/mock/server.mjs zipmode),
      // Overleaf's PDF pane laid out late with "pane": "late" (mockShowPane() lays it out); until the
      // start's step matches `stage`, else the run fails)
      await ev(`${s.start.pane === "late" ? `localStorage.setItem("mock:latepane", "1")` : `localStorage.removeItem("mock:latepane")`}`);
      await ev(`${s.start.failure ? `localStorage.setItem("phitex:test-failure", ${JSON.stringify(s.start.failure)})` : `localStorage.removeItem("phitex:test-failure")`}`);
      await fetch(`http://localhost:${MOCK}/project/mock/zipmode?mode=${s.start.zip ?? "ok"}`, { method: "POST" });
      await send("browsingContext.reload", { context: ctx, wait: "interactive" });
      let st = null;
      for (; !(st && new RegExp(s.stage ?? "").test(st.stage)) && Date.now() - t < (s.ms ?? 30000); await sleep(250)) st = await state().catch(() => null);
      if (!(st && new RegExp(s.stage ?? "").test(st.stage))) throw new Error(`start ${JSON.stringify(s.start)}: not at ${s.stage}: ${st?.stage}`);
      console.log(`start ${JSON.stringify(s.start)}: ${st.stage}`);
    } else if (s.zipmode !== undefined) {
      // (the mock's downloads answer so from here (a held one sent whole), the tab not reloaded; until `until` (the page's world) holds)
      await fetch(`http://localhost:${MOCK}/project/mock/zipmode?mode=${s.zipmode}`, { method: "POST" });
      let ok = !s.until;
      for (; !ok && Date.now() - t < (s.ms ?? 60000); await sleep(250)) ok = !!(await ev(s.until));
      if (!ok) throw new Error(`zipmode ${s.zipmode}: not ${s.until} within ${s.ms ?? 60000} ms`);
      console.log(`zipmode ${s.zipmode}`);
    } else if (s.eval !== undefined) await ev(s.eval);
    else if (s.check !== undefined) {
      // (an expression in the page's world is `is` (deep; unset: true))
      const got = JSON.parse((await ev(`(async () => JSON.stringify(await (${s.check})) ?? "null")()`)) ?? "null");
      if (JSON.stringify(got) !== JSON.stringify(s.is ?? true)) throw new Error(`${s.what ?? s.check}: ${JSON.stringify(got)}, not ${JSON.stringify(s.is ?? true)}`);
      console.log(`ok   ${s.what ?? s.check}`);
    } else if (s.moving !== undefined) {
      // (the panel's element `moving` drawn twice, `gap` ms apart, as the screen shows it: its pixels changed
      // (an animation playing) is `is` (unset: true); waited for up to `ms` to be on screen, else not moving)
      const rect = `(() => { const el = ${shadow}?.querySelector(${JSON.stringify(s.moving)}); if (!el?.checkVisibility()) return null; const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 ? JSON.stringify({ type: "box", x: r.x, y: r.y, width: r.width, height: r.height }) : null; })()`;
      let clip = null;
      for (; !(clip = await ev(rect)) && Date.now() - t < (s.ms ?? 5000); ) await sleep(100);
      const grab = async () => (await send("browsingContext.captureScreenshot", { context: ctx, clip: JSON.parse(clip) })).data;
      let moving = false;
      if (clip) {
        const a = await grab();
        await sleep(s.gap ?? 600);
        moving = a !== (await grab());
      }
      if (moving !== (s.is ?? true)) throw new Error(`${s.what ?? `${s.moving} moving`}: ${clip ? (moving ? "moving" : "still") : "not on screen"}`);
      console.log(`ok   ${s.what ?? `${s.moving} moving`}`);
    } else if (s.shot !== undefined) {
      const r = await send("browsingContext.captureScreenshot", { context: ctx });
      const f = path.join(root, `target/fx-run-${sc.name ?? "run"}-${s.shot}.png`);
      fs.writeFileSync(f, Buffer.from(r.data, "base64"));
      console.log("screenshot:", f);
    } else throw new Error(`unknown step ${JSON.stringify(s)}`);
  }
  const st = await state();
  if (st.failed) throw new Error(`the start failed: ${st.stage}`);
  console.log(`PASSED (${(sc.steps ?? []).length} steps)`);
}
