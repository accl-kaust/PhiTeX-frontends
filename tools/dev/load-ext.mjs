// Load build/overleaf/ into a running Chromium, unpacked, over the DevTools
// protocol: Chromium 153 ignores --load-extension, but Extensions.loadUnpacked
// works when the browser runs with --enable-unsafe-extension-debugging
// (tools/dev/chrome.sh starts it so). The extension is loaded from
// target/ext-dev/: build/overleaf/'s files copied, its manifest matching the local
// mock (http://localhost/project*) as a --dev build's does, so a store
// build in build/overleaf/ runs on the mock too.
// Any other unpacked PhiTeX build the profile has (another checkout's or
// worktree's target/ext-dev: its own path, so its own id, kept by the
// profile across runs) is uninstalled first: one copy runs, never two
// (each would put its own switch, tips and engine in the page).
//   node tools/dev/load-ext.mjs PORT [PROFILE]   (PROFILE: the browser's --user-data-dir)
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const port = process.argv[2] ?? "9222";
const profile = process.argv[3] ?? process.env.PHITEX_PROFILE_DIR;
// (PHITEX_EXT: another unpacked build to load instead, for an A/B: target/old-ext, say)
const src = path.resolve(root, process.env.PHITEX_EXT ?? "build/overleaf"), dev = path.join(root, "target/ext-dev");
fs.rmSync(dev, { recursive: true, force: true });
fs.mkdirSync(dev, { recursive: true });
// (copies (reflinks where the disk has them), not symlinks: Chromium serves an unpacked extension's files only from inside its folder)
const link = (from, to) => {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === "manifest.json" && from === src) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (fs.statSync(a).isDirectory()) fs.mkdirSync(b), link(a, b);
    else fs.copyFileSync(a, b, fs.constants.COPYFILE_FICLONE);
  }
};
link(src, dev);
const m = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));
const add = (list, p) => list.includes(p) || list.push(p);
// (each script on the mock where it runs on overleaf.com: the editor's at /project/*, the dashboard's at /project too)
for (const c of m.content_scripts) for (const u of [...c.matches]) if (u.startsWith("https://www.overleaf.com/")) add(c.matches, u.replace("https://www.overleaf.com/", "http://localhost/"));
add(m.web_accessible_resources[0].matches, "http://localhost/*");
fs.writeFileSync(path.join(dev, "manifest.json"), JSON.stringify(m, null, 2) + "\n");

let v;
for (let i = 0; i < 80 && !v; i++) {
  await new Promise((r) => setTimeout(r, 250));
  v = await fetch(`http://localhost:${port}/json/version`).then((r) => r.json(), () => undefined);
}
if (!v) throw new Error(`no browser on :${port}`);
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const call = (method, params) =>
  new Promise((ok) => {
    const n = ++id;
    const on = (e) => {
      const m = JSON.parse(e.data);
      if (m.id === n) ws.removeEventListener("message", on), ok(m);
    };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
for (const [other, where] of otherBuilds(profile, dev)) {
  const u = await call("Extensions.uninstall", { id: other });
  console.log(u.error ? `couldn't uninstall the other PhiTeX build ${other} (${where}): ${u.error.message}` : `uninstalled the other PhiTeX build ${other} (${where})`);
}
const r = await call("Extensions.loadUnpacked", { path: dev });
ws.close();
if (r.error) throw new Error(`loadUnpacked: ${r.error.message}`);
console.log(`extension ${r.result.id} from ${dev}`);

/**
 * The profile's other unpacked PhiTeX builds: [id, path] for each unpacked
 * extension (location 4) whose folder is not `keep` and is PhiTeX's (its
 * manifest names PhiTeX, or, its folder gone, the folder was a
 * target/ext-dev). Read from the profile's preferences, where Chromium keeps
 * them; none without a profile.
 */
function otherBuilds(profile, keep) {
  if (!profile) return [];
  const found = new Map();
  for (const f of ["Preferences", "Secure Preferences"]) {
    let prefs;
    try {
      prefs = JSON.parse(fs.readFileSync(path.join(profile, "Default", f), "utf8"));
    } catch {
      continue;
    }
    for (const [eid, e] of Object.entries(prefs?.extensions?.settings ?? {})) {
      if (e?.location !== 4 || !e.path || path.resolve(e.path) === keep) continue;
      let name = "";
      try {
        name = JSON.parse(fs.readFileSync(path.join(e.path, "manifest.json"), "utf8")).name ?? "";
      } catch {}
      if (/phitex/i.test(name) || (!name && /\/target\/ext-dev\/?$/.test(e.path))) found.set(eid, e.path);
    }
  }
  return [...found];
}
