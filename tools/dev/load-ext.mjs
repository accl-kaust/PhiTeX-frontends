// Load build/overleaf/ into a running Chromium, unpacked, over the DevTools
// protocol: Chromium 153 ignores --load-extension, but Extensions.loadUnpacked
// works when the browser runs with --enable-unsafe-extension-debugging
// (tools/dev/chrome.sh starts it so). The extension is loaded from
// target/ext-dev/: build/overleaf/'s files copied, its manifest matching the local
// mock (http://localhost/project/*) as a --dev build's does, so a store
// build in build/overleaf/ runs on the mock too.
//   node tools/dev/load-ext.mjs PORT
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const port = process.argv[2] ?? "9222";
const src = path.join(root, "build/overleaf"), dev = path.join(root, "target/ext-dev");
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
for (const c of m.content_scripts) add(c.matches, "http://localhost/project/*");
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
ws.send(JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: dev } }));
const r = await new Promise((ok) => ws.addEventListener("message", (e) => ok(JSON.parse(e.data))));
ws.close();
if (r.error) throw new Error(`loadUnpacked: ${r.error.message}`);
console.log(`extension ${r.result.id} from ${dev}`);
